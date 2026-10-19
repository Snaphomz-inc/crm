import uuid

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from .common import EMAIL_SUBSCRIPTION_STATUSES, SUPPRESSED_EMAIL_STATUSES, normalize_email, normalize_phone


class ResPartner(models.Model):
    _inherit = 'res.partner'

    # Identity
    snaphomz_person_uuid = fields.Char(
        'Person UUID', copy=False, readonly=True, index='btree_not_null',
        help="Stable Snaphomz identifier for this person. Shared with Loops as crmPersonId.")
    snaphomz_user_id = fields.Char(
        'Snaphomz user ID', copy=False, index='btree_not_null',
        help="User ID on the Snaphomz platform, when the buyer has an account.")
    loops_contact_id = fields.Char('Loops contact ID', copy=False, index='btree_not_null')
    is_snaphomz_buyer = fields.Boolean(compute='_compute_is_snaphomz_buyer', search='_search_is_snaphomz_buyer')
    snaphomz_identity_key_ids = fields.One2many('snaphomz.identity.key', 'partner_id', 'Identity keys')

    # Contact preferences
    preferred_contact_method = fields.Selection([
        ('phone', 'Phone call'),
        ('sms', 'Text message'),
        ('email', 'Email'),
        ('whatsapp', 'WhatsApp'),
    ], string='Preferred contact method')
    do_not_contact = fields.Boolean(
        'Do not contact', tracking=True, copy=False,
        help="The buyer explicitly asked not to be contacted. Distinct from an email unsubscribe or bounce.")
    do_not_contact_at = fields.Datetime('Do-not-contact recorded at', copy=False, readonly=True)

    # Marketing (owned by Loops; never changed by sales-stage updates)
    email_subscription_status = fields.Selection(
        EMAIL_SUBSCRIPTION_STATUSES, string='Email subscription', default='unknown',
        required=True, copy=False, tracking=True)
    email_status_event_at = fields.Datetime(
        'Subscription status as of', copy=False, readonly=True,
        help="Time of the provider event that set the current subscription status. Older events are ignored.")
    email_suppressed = fields.Boolean(compute='_compute_email_suppressed', search='_search_email_suppressed')
    marketing_consent = fields.Boolean('Marketing email consent', copy=False)
    consent_source = fields.Char('Consent source', copy=False)
    consent_at = fields.Datetime('Consent captured at', copy=False)
    last_marketing_engagement_at = fields.Datetime(
        'Last marketing engagement', copy=False, readonly=True,
        help="Last email click or reply. Automated email activity never changes the human follow-up clocks.")
    last_email_open_at = fields.Datetime(
        'Last email open', copy=False, readonly=True, help="Weak engagement signal.")

    # Ownership (drives the salesperson record rule on contacts)
    snaphomz_lead_ids = fields.One2many(
        'crm.lead', 'partner_id', string='Buyer acquisitions', context={'active_test': False})
    snaphomz_owner_user_ids = fields.Many2many(
        'res.users', 'snaphomz_partner_owner_rel', 'partner_id', 'user_id',
        string='Assigned salespeople', compute='_compute_snaphomz_owner_user_ids', store=True)

    # Loops synchronisation bookkeeping
    loops_synced_payload = fields.Json('Last payload accepted by Loops', copy=False, readonly=True)
    loops_synced_version = fields.Integer('Last version accepted by Loops', copy=False, readonly=True)
    loops_version_seq = fields.Integer('Loops payload version counter', copy=False, readonly=True)

    _snaphomz_person_uuid_uniq = models.UniqueIndex(
        '(snaphomz_person_uuid) WHERE snaphomz_person_uuid IS NOT NULL',
        'Another contact already has this person UUID.')
    _snaphomz_user_id_uniq = models.UniqueIndex(
        '(snaphomz_user_id) WHERE snaphomz_user_id IS NOT NULL',
        'Another contact already has this Snaphomz user ID.')

    @api.depends('snaphomz_person_uuid')
    def _compute_is_snaphomz_buyer(self):
        for partner in self:
            partner.is_snaphomz_buyer = bool(partner.snaphomz_person_uuid)

    def _search_is_snaphomz_buyer(self, operator, value):
        if operator not in ('=', '!=') or not isinstance(value, bool):
            return NotImplemented
        positive = (operator == '=') == value
        return [('snaphomz_person_uuid', '!=' if positive else '=', False)]

    @api.depends('email_subscription_status')
    def _compute_email_suppressed(self):
        for partner in self:
            partner.email_suppressed = partner.email_subscription_status in SUPPRESSED_EMAIL_STATUSES

    def _search_email_suppressed(self, operator, value):
        if operator not in ('=', '!=') or not isinstance(value, bool):
            return NotImplemented
        positive = (operator == '=') == value
        return [('email_subscription_status', 'in' if positive else 'not in', list(SUPPRESSED_EMAIL_STATUSES))]

    @api.depends('snaphomz_lead_ids.user_id')
    def _compute_snaphomz_owner_user_ids(self):
        for partner in self:
            partner.snaphomz_owner_user_ids = partner.with_context(active_test=False).snaphomz_lead_ids.user_id

    # ------------------------------------------------------------------
    # ORM
    # ------------------------------------------------------------------

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('do_not_contact'):
                vals.setdefault('do_not_contact_at', fields.Datetime.now())
        partners = super().create(vals_list)
        partners.filtered('snaphomz_person_uuid')._snaphomz_sync_identity_keys()
        return partners

    def write(self, vals):
        if vals.get('do_not_contact'):
            vals.setdefault('do_not_contact_at', fields.Datetime.now())
        res = super().write(vals)
        if {'email', 'phone', 'snaphomz_user_id', 'snaphomz_person_uuid', 'country_id'} & set(vals):
            self.filtered('snaphomz_person_uuid')._snaphomz_sync_identity_keys()
        if {'do_not_contact', 'email', 'name'} & set(vals) and not self.env.context.get('snaphomz_origin') == 'loops':
            self.snaphomz_lead_ids.filtered('acquisition_uuid')._snaphomz_queue_loops_sync()
        return res

    # ------------------------------------------------------------------
    # Identity
    # ------------------------------------------------------------------

    def _snaphomz_ensure_person(self):
        """Give buyer contacts a stable person UUID (once)."""
        for partner in self.filtered(lambda p: not p.snaphomz_person_uuid):
            partner.snaphomz_person_uuid = str(uuid.uuid4())
        return self

    def _snaphomz_identity_values(self):
        self.ensure_one()
        values = {
            'email': normalize_email(self.email),
            'phone': normalize_phone(self.env, self.phone, self.country_id.code),
            'snaphomz_user': self.snaphomz_user_id or False,
        }
        return {kind: value for kind, value in values.items() if value}

    def _snaphomz_sync_identity_keys(self):
        """Register this buyer's email, phone and Snaphomz user ID as identity keys.

        Keys are unique in the database, which is what prevents two
        simultaneous intakes from creating two contacts for one person.
        A phone number already held by another buyer is tolerated (shared
        household phones); an email or user ID is not.
        """
        Key = self.env['snaphomz.identity.key'].sudo()
        for partner in self:
            for kind, value in partner._snaphomz_identity_values().items():
                existing = Key.search([('kind', '=', kind), ('value', '=', value)], limit=1)
                if existing.partner_id == partner:
                    continue
                if existing:
                    if kind == 'phone':
                        continue
                    raise ValidationError(_(
                        "%(value)s already belongs to buyer %(buyer)s. Ask a manager to merge "
                        "the records instead of creating a duplicate.",
                        value=value, buyer=existing.partner_id.sudo().display_name))
                Key.create({'kind': kind, 'value': value, 'partner_id': partner.id})

    # ------------------------------------------------------------------
    # Marketing state (applied from Loops events)
    # ------------------------------------------------------------------

    def _snaphomz_apply_email_status(self, status, event_at):
        """Apply a subscription status unless a newer event already set one."""
        self.ensure_one()
        if self.email_status_event_at and event_at and event_at < self.email_status_event_at:
            return False
        self.with_context(snaphomz_origin='loops').write({
            'email_subscription_status': status,
            'email_status_event_at': event_at or fields.Datetime.now(),
        })
        return True

    def _snaphomz_touch(self, fname, event_at):
        """Advance a timestamp field, never moving it backwards."""
        self.ensure_one()
        if event_at and (not self[fname] or event_at > self[fname]):
            self.with_context(snaphomz_origin='loops').write({fname: event_at})

    def action_snaphomz_view_marketing_events(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Marketing events'),
            'res_model': 'snaphomz.inbound.event',
            'view_mode': 'list,form',
            'domain': [('partner_id', '=', self.id), ('provider', '=', 'loops')],
        }
