import uuid
from datetime import datetime, time, timedelta

import pytz

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError

from .common import (
    ACTIVE_STATUSES, BUYER_STATUSES, OUTCOMES, PROVIDERS, READINESS, STAGE_CODES,
)

# Human follow-up clocks: only the Log outcome action (or a verified buyer
# email reply) moves them; automated or integration writes never do.
CLOCK_FIELDS = (
    'first_human_attempt_at', 'last_human_attempt_at', 'last_two_way_contact_at',
    'last_buyer_response_at', 'attempt_count', 'last_outcome', 'last_outcome_at',
)
# Qualification is entered or confirmed by a person, never by the integration.
HUMAN_FIELDS = CLOCK_FIELDS + ('buyer_readiness', 'qualification_reason')
# Changes that may alter what Loops should know about the buyer.
LOOPS_TRIGGER_FIELDS = {
    'buyer_status', 'stage_id', 'buyer_readiness', 'user_id', 'consultation_booked_at',
    'consultation_cancelled_at', 'bra_signed_at', 'bra_status', 'active', 'partner_id', 'type',
}
VALIDATION_TRIGGER_FIELDS = {
    'buyer_status', 'next_action', 'next_action_at', 'nurture_review_date', 'nurture_reason_id',
    'lost_reason_id', 'active', 'stage_id', 'type', 'bra_reference',
}
ORIGIN_FIELDS = (
    'origin_provider', 'origin_event_type', 'origin_at', 'origin_source', 'origin_medium',
    'origin_campaign', 'origin_content', 'origin_term', 'origin_landing_page', 'origin_referrer',
    'origin_meta_page_id', 'origin_meta_form_id', 'origin_meta_campaign_id',
    'origin_meta_adset_id', 'origin_meta_ad_id', 'origin_meta_lead_id',
    'source_id', 'medium_id', 'campaign_id',
)


class CrmLead(models.Model):
    _inherit = 'crm.lead'

    # ------------------------------------------------------------------
    # Identity
    # ------------------------------------------------------------------
    acquisition_uuid = fields.Char(
        'Acquisition UUID', copy=False, readonly=True, index='btree_not_null',
        default=lambda self: str(uuid.uuid4()))
    merged_acquisition_uuids = fields.Text(
        'Merged acquisition UUIDs', copy=False, readonly=True,
        help="Identifiers of acquisition records merged into this one; intake still resolves them.")
    person_uuid = fields.Char(related='partner_id.snaphomz_person_uuid', string='Person UUID')
    snaphomz_user_id = fields.Char(related='partner_id.snaphomz_user_id', string='Snaphomz user ID')
    buyer_timezone = fields.Selection(related='partner_id.tz', string='Buyer timezone', readonly=False)
    preferred_contact_method = fields.Selection(related='partner_id.preferred_contact_method', readonly=False)

    # ------------------------------------------------------------------
    # Workflow
    # ------------------------------------------------------------------
    buyer_status = fields.Selection(
        BUYER_STATUSES, string='Lead status', default='new', required=True,
        index=True, tracking=True, copy=False)
    stage_code = fields.Selection(related='stage_id.snaphomz_code', store=True, string='Milestone')

    # ------------------------------------------------------------------
    # Origin: set at first intake, preserved thereafter
    # ------------------------------------------------------------------
    origin_provider = fields.Selection(PROVIDERS + [('manual', 'Manual entry')], string='Original channel', readonly=True)
    origin_event_type = fields.Char('Original inquiry type', readonly=True)
    origin_at = fields.Datetime('First inquiry at', readonly=True, index=True)
    origin_source = fields.Char('Original UTM source', readonly=True)
    origin_medium = fields.Char('Original UTM medium', readonly=True)
    origin_campaign = fields.Char('Original UTM campaign', readonly=True)
    origin_content = fields.Char('Original UTM content', readonly=True)
    origin_term = fields.Char('Original UTM term', readonly=True)
    origin_landing_page = fields.Char('Original landing page', readonly=True)
    origin_referrer = fields.Char('Original referrer', readonly=True)
    origin_meta_page_id = fields.Char('Meta page ID', readonly=True)
    origin_meta_form_id = fields.Char('Meta form ID', readonly=True)
    origin_meta_campaign_id = fields.Char('Meta campaign ID', readonly=True)
    origin_meta_adset_id = fields.Char('Meta ad set ID', readonly=True)
    origin_meta_ad_id = fields.Char('Meta ad ID', readonly=True)
    origin_meta_lead_id = fields.Char('Meta lead ID', readonly=True)

    # ------------------------------------------------------------------
    # Latest inquiry (updated on every intake)
    # ------------------------------------------------------------------
    latest_inquiry_provider = fields.Selection(PROVIDERS, string='Latest channel', readonly=True)
    latest_inquiry_source = fields.Char('Latest source', readonly=True)
    latest_inquiry_campaign = fields.Char('Latest campaign', readonly=True)
    latest_property_ref = fields.Char('Latest property / listing', readonly=True)
    latest_inquiry_at = fields.Datetime('Latest inquiry at', readonly=True)
    latest_inquiry_text = fields.Text('Latest inquiry text', readonly=True)
    inquiry_ids = fields.One2many('snaphomz.inquiry', 'lead_id', 'Inquiries')
    inquiry_count = fields.Integer(compute='_compute_inquiry_count', store=True)

    # ------------------------------------------------------------------
    # Buyer needs
    # ------------------------------------------------------------------
    buyer_locations = fields.Char('Target locations')
    home_type = fields.Selection([
        ('single_family', 'Single-family'),
        ('condo', 'Condo'),
        ('townhouse', 'Townhouse'),
        ('multi_family', 'Multi-family'),
        ('land', 'Land'),
        ('other', 'Other / mixed'),
    ], string='Home type')
    budget_min = fields.Monetary('Budget from', currency_field='company_currency')
    budget_max = fields.Monetary('Budget up to', currency_field='company_currency')
    monthly_payment_comfort = fields.Monetary('Comfortable monthly payment', currency_field='company_currency')
    buying_timeline = fields.Selection([
        ('0_3', 'Within 3 months'),
        ('3_6', '3–6 months'),
        ('6_12', '6–12 months'),
        ('12_plus', 'More than 12 months'),
        ('unknown', 'Not sure'),
    ], string='Buying timeline')
    tour_ready = fields.Selection([
        ('yes', 'Ready to tour'),
        ('soon', 'Soon'),
        ('no', 'Not yet'),
    ], string='Tour readiness')
    financing_status = fields.Selection([
        ('cash', 'Cash buyer'),
        ('preapproved', 'Pre-approved'),
        ('prequalified', 'Pre-qualified'),
        ('not_started', 'Not started'),
        ('unknown', 'Unknown'),
    ], string='Financing')
    existing_representation = fields.Selection([
        ('none', 'No agent'),
        ('has_agent', 'Already has an agent'),
        ('unknown', 'Unknown'),
    ], string='Existing representation')

    # ------------------------------------------------------------------
    # Qualification (entered or confirmed by a person)
    # ------------------------------------------------------------------
    buyer_readiness = fields.Selection(READINESS, string='Readiness', tracking=True)
    qualification_reason = fields.Text('Qualification reason')
    qualified_at = fields.Datetime('Qualification date', readonly=True)
    qualified_by_id = fields.Many2one('res.users', 'Qualified by', readonly=True)

    # ------------------------------------------------------------------
    # Sales progress
    # ------------------------------------------------------------------
    last_outcome = fields.Selection(OUTCOMES, string='Last outcome', readonly=True)
    last_outcome_at = fields.Datetime('Last outcome at', readonly=True)
    nurture_reason_id = fields.Many2one('snaphomz.nurture.reason', 'Nurture reason', tracking=True)
    nurture_review_date = fields.Date('Nurture review date', tracking=True)

    # ------------------------------------------------------------------
    # Follow-up
    # ------------------------------------------------------------------
    next_action = fields.Char('Next action', tracking=True)
    next_action_at = fields.Datetime('Next action due', tracking=True, index=True)
    is_overdue = fields.Boolean('Overdue', compute='_compute_is_overdue', search='_search_is_overdue')
    is_due_today = fields.Boolean('Due today', compute='_compute_is_due_today', search='_search_is_due_today')
    missing_next_action = fields.Boolean(compute='_compute_missing_next_action', store=True)

    # ------------------------------------------------------------------
    # Human activity clocks (only Log outcome changes these)
    # ------------------------------------------------------------------
    first_human_attempt_at = fields.Datetime('First contact attempt', readonly=True, copy=False)
    last_human_attempt_at = fields.Datetime('Last contact attempt', readonly=True, copy=False)
    last_two_way_contact_at = fields.Datetime('Last two-way contact', readonly=True, copy=False)
    last_buyer_response_at = fields.Datetime('Last buyer response', readonly=True, copy=False)
    attempt_count = fields.Integer('Contact attempts', readonly=True, copy=False)
    waiting_for_buyer = fields.Boolean(compute='_compute_waiting_for_buyer', store=True)
    attempts_exhausted = fields.Boolean(compute='_compute_attempts_exhausted', store=True)

    # First-contact service level (staffed time)
    sla_start_at = fields.Datetime('Staffed clock started', readonly=True, copy=False)
    sla_owner_alert_at = fields.Datetime('Owner reminder at', readonly=True, copy=False)
    sla_manager_alert_at = fields.Datetime('Manager escalation at', readonly=True, copy=False)
    sla_owner_alerted = fields.Boolean(readonly=True, copy=False)
    sla_manager_alerted = fields.Boolean(readonly=True, copy=False)

    # ------------------------------------------------------------------
    # Marketing (owned by Loops, shown here for context)
    # ------------------------------------------------------------------
    email_subscription_status = fields.Selection(related='partner_id.email_subscription_status')
    do_not_contact = fields.Boolean(related='partner_id.do_not_contact')
    last_marketing_engagement_at = fields.Datetime(related='partner_id.last_marketing_engagement_at')
    marketing_consent = fields.Boolean(related='partner_id.marketing_consent')
    sales_sequence_eligible = fields.Boolean(
        'Sales sequence eligible', compute='_compute_sales_sequence_eligible', store=True,
        help="Sent to Loops as salesSequenceEligible. False once the buyer is lost or asked not to be contacted.")

    # ------------------------------------------------------------------
    # Consultation and BRA milestones
    # ------------------------------------------------------------------
    consultation_booked_at = fields.Datetime('Consultation booking confirmed', readonly=True, copy=False)
    consultation_at = fields.Datetime('Consultation time', copy=False, tracking=True)
    consultation_completed_at = fields.Datetime('Consultation completed', copy=False, tracking=True)
    consultation_cancelled_at = fields.Datetime('Consultation cancelled', readonly=True, copy=False)
    bra_sent_at = fields.Datetime('BRA sent', copy=False, tracking=True)
    bra_signed_at = fields.Datetime('BRA signed', copy=False, tracking=True)
    bra_reference = fields.Char('Agreement ID', copy=False, tracking=True)
    bra_status = fields.Selection([
        ('none', 'Not sent'),
        ('sent', 'Sent'),
        ('active', 'Signed and valid'),
        ('expired', 'Expired'),
        ('cancelled', 'Cancelled'),
    ], string='BRA validity', default='none', required=True, copy=False, tracking=True)
    bra_expires_at = fields.Datetime('BRA expires', copy=False)
    bra_ended_at = fields.Datetime('BRA ended', copy=False, readonly=True)
    bra_active = fields.Boolean('Active BRA', compute='_compute_bra_active', store=True)

    # ------------------------------------------------------------------
    # Review and history
    # ------------------------------------------------------------------
    snaphomz_needs_review = fields.Boolean('Needs manager review', copy=False, tracking=True)
    snaphomz_review_note = fields.Text('Review note', copy=False)
    stage_history_ids = fields.One2many('snaphomz.stage.history', 'lead_id', 'Stage history')

    _snaphomz_acquisition_uuid_uniq = models.UniqueIndex(
        '(acquisition_uuid) WHERE acquisition_uuid IS NOT NULL',
        'Another record already has this acquisition UUID.')
    _snaphomz_one_active_acquisition = models.UniqueIndex(
        '(partner_id) WHERE active IS TRUE AND acquisition_uuid IS NOT NULL AND partner_id IS NOT NULL',
        'This buyer already has an active acquisition record. Add the inquiry to that record instead.')

    # ------------------------------------------------------------------
    # Computes
    # ------------------------------------------------------------------

    @api.depends('inquiry_ids')
    def _compute_inquiry_count(self):
        for lead in self:
            lead.inquiry_count = len(lead.inquiry_ids)

    def _compute_is_overdue(self):
        now = fields.Datetime.now()
        for lead in self:
            lead.is_overdue = bool(lead.active and lead.next_action_at and lead.next_action_at < now)

    def _search_is_overdue(self, operator, value):
        if operator not in ('=', '!=') or not isinstance(value, bool):
            return NotImplemented
        domain = [('next_action_at', '!=', False), ('next_action_at', '<', fields.Datetime.now())]
        if (operator == '=') == value:
            return domain
        return ['!', '&', *domain]

    def _user_day_bounds_utc(self):
        tz = pytz.timezone(self.env.user.tz or 'UTC')
        today = datetime.now(tz).date()
        start = tz.localize(datetime.combine(today, time.min))
        end = tz.localize(datetime.combine(today + timedelta(days=1), time.min))
        return (start.astimezone(pytz.utc).replace(tzinfo=None),
                end.astimezone(pytz.utc).replace(tzinfo=None))

    def _compute_is_due_today(self):
        _start, end = self._user_day_bounds_utc()
        for lead in self:
            lead.is_due_today = bool(lead.next_action_at and lead.next_action_at < end)

    def _search_is_due_today(self, operator, value):
        """Due before the end of the user's day (includes overdue follow-ups)."""
        if operator not in ('=', '!=') or not isinstance(value, bool):
            return NotImplemented
        _start, end = self._user_day_bounds_utc()
        domain = [('next_action_at', '!=', False), ('next_action_at', '<', end)]
        if (operator == '=') == value:
            return domain
        return ['!', '&', *domain]

    @api.depends('active', 'buyer_status', 'next_action_at', 'won_status')
    def _compute_missing_next_action(self):
        for lead in self:
            lead.missing_next_action = bool(
                lead.active and lead.won_status != 'won'
                and lead.buyer_status in ACTIVE_STATUSES + ('nurture',)
                and not lead.next_action_at)

    @api.depends('active', 'buyer_status', 'last_human_attempt_at', 'last_buyer_response_at', 'won_status')
    def _compute_waiting_for_buyer(self):
        for lead in self:
            lead.waiting_for_buyer = bool(
                lead.active and lead.won_status != 'won'
                and lead.buyer_status not in ('lost',)
                and lead.last_human_attempt_at
                and (not lead.last_buyer_response_at or lead.last_buyer_response_at < lead.last_human_attempt_at))

    @api.depends('active', 'buyer_status', 'attempt_count', 'last_two_way_contact_at', 'team_id.snaphomz_retry_attempt_limit')
    def _compute_attempts_exhausted(self):
        for lead in self:
            limit = lead.team_id.snaphomz_retry_attempt_limit or 3
            lead.attempts_exhausted = bool(
                lead.active and lead.buyer_status in ('new', 'attempting')
                and not lead.last_two_way_contact_at and lead.attempt_count >= limit)

    @api.depends('active', 'buyer_status', 'partner_id.do_not_contact')
    def _compute_sales_sequence_eligible(self):
        for lead in self:
            lead.sales_sequence_eligible = bool(
                lead.active and lead.buyer_status != 'lost' and not lead.partner_id.do_not_contact)

    @api.depends('bra_status')
    def _compute_bra_active(self):
        for lead in self:
            lead.bra_active = lead.bra_status == 'active'

    # ------------------------------------------------------------------
    # ORM
    # ------------------------------------------------------------------

    def _snaphomz_is_integration(self):
        return self.env.user.has_group('snaphomz_crm.group_snaphomz_integration') and not self.env.su

    @api.model_create_multi
    def create(self, vals_list):
        if self._snaphomz_is_integration() and not self.env.context.get('snaphomz_intake'):
            raise AccessError(_("The integration user creates buyers only through submit_intake."))
        team = self.env['crm.team']._snaphomz_buyer_team()
        now = fields.Datetime.now()
        for vals in vals_list:
            vals.setdefault('origin_provider', 'manual')
            vals.setdefault('origin_at', now)
            status = vals.get('buyer_status', 'new')
            if status in ACTIVE_STATUSES and not vals.get('next_action_at') and team:
                vals.setdefault('next_action', _('First contact'))
                vals['next_action_at'] = team._snaphomz_plan(now, team.snaphomz_first_contact_minutes or 15)
        leads = super().create(vals_list)
        leads.partner_id._snaphomz_ensure_person()
        leads.partner_id._snaphomz_sync_identity_keys()
        self.env['snaphomz.stage.history'].sudo().create([
            lead._snaphomz_history_vals('status', None, lead.buyer_status) for lead in leads
        ] + [
            lead._snaphomz_history_vals('stage', None, lead.stage_id)
            for lead in leads if lead.type == 'opportunity' and lead.stage_id
        ])
        self.env['res.partner'].flush_model(['snaphomz_owner_user_ids'])
        leads.filtered('next_action_at').with_context(
            snaphomz_next_activity_type=self.env.context.get('snaphomz_next_activity_type')
            or 'snaphomz_crm.activity_type_first_contact',
        )._snaphomz_upsert_next_activity()
        if not self.env.context.get('snaphomz_skip_validation'):
            leads._snaphomz_check_requirements()
        leads._snaphomz_queue_loops_sync()
        return leads

    def write(self, vals):
        if self._snaphomz_is_integration() and HUMAN_FIELDS_SET & set(vals):
            raise AccessError(_(
                "Integration writes cannot change human follow-up fields: %s",
                ', '.join(sorted(HUMAN_FIELDS_SET & set(vals)))))
        if (set(CLOCK_FIELDS) & set(vals) and not self.env.su
                and not self.env.context.get('snaphomz_log_outcome')):
            raise AccessError(_("Contact attempts and conversations are recorded with Log outcome."))
        if 'buyer_readiness' in vals:
            vals = dict(vals, qualified_at=fields.Datetime.now(), qualified_by_id=self.env.uid)
        if vals.get('type') == 'opportunity':
            self._snaphomz_check_can_convert()
        if vals.get('stage_id'):
            vals = self._snaphomz_prepare_stage_change(vals)
        ctx = self.env.context
        if ('next_action_at' in vals and not vals['next_action_at']
                and not ctx.get('snaphomz_activity_sync') and not ctx.get('snaphomz_skip_validation')):
            for lead in self:
                status = vals.get('buyer_status', lead.buyer_status)
                if vals.get('active', lead.active) and lead.won_status != 'won' and status in ACTIVE_STATUSES:
                    raise ValidationError(_(
                        "%(lead)s is an active buyer and needs a dated next action. "
                        "Use Log outcome or set the next action and its due time.", lead=lead.display_name))

        track = {'buyer_status', 'stage_id', 'type'} & set(vals)
        before = {lead.id: (lead.buyer_status, lead.stage_id, lead.type) for lead in self} if track else {}
        previous_owners = {lead.id: lead.user_id for lead in self} if 'user_id' in vals else {}
        owner_changed = 'user_id' in vals and any(lead.user_id.id != vals['user_id'] for lead in self)

        res = super().write(vals)

        if before:
            self._snaphomz_log_history(before)
        if owner_changed:
            self._snaphomz_reassign_open_activities()
            self._snaphomz_unsubscribe_previous_owners(previous_owners)
        if {'user_id', 'partner_id', 'active'} & set(vals):
            # Contact visibility rules read this stored field: recompute it now.
            self.env['res.partner'].flush_model(['snaphomz_owner_user_ids'])
        if {'next_action', 'next_action_at'} & set(vals) and not ctx.get('snaphomz_activity_sync'):
            self._snaphomz_upsert_next_activity()
        if VALIDATION_TRIGGER_FIELDS & set(vals) and not ctx.get('snaphomz_skip_validation'):
            self._snaphomz_check_requirements()
        if LOOPS_TRIGGER_FIELDS & set(vals) and ctx.get('snaphomz_origin') != 'loops':
            self._snaphomz_queue_loops_sync()
        return res

    def _snaphomz_check_requirements(self):
        """Business rules enforced on every form and API write."""
        for lead in self:
            if lead.active and lead.won_status != 'won':
                if lead.buyer_status in ACTIVE_STATUSES and not lead.next_action_at:
                    raise ValidationError(_(
                        "%(lead)s is an active buyer and needs a dated next action. "
                        "Use Log outcome or set the next action and its due time.", lead=lead.display_name))
                if lead.buyer_status == 'nurture' and not (lead.nurture_review_date and lead.nurture_reason_id):
                    raise ValidationError(_(
                        "%(lead)s is in nurture: a nurture reason and a review date are required.",
                        lead=lead.display_name))
            if lead.buyer_status == 'lost' and not lead.lost_reason_id:
                raise ValidationError(_("%(lead)s is unqualified or lost: a reason is required.", lead=lead.display_name))
            if lead.won_status == 'won' and lead.stage_code == 'bra_signed' and not lead.bra_reference:
                raise ValidationError(_(
                    "%(lead)s is marked BRA signed: record the agreement ID first.", lead=lead.display_name))

    def _snaphomz_check_can_convert(self):
        for lead in self.filtered(lambda l: l.type == 'lead' and l.acquisition_uuid):
            if lead.buyer_readiness != 'ready_now' and not self.env.context.get('snaphomz_qualifying'):
                raise UserError(_(
                    "Use Qualify on %(lead)s: a salesperson must confirm the buyer is ready now "
                    "before it becomes an opportunity.", lead=lead.display_name))

    def _snaphomz_prepare_stage_change(self, vals):
        """Only move to a milestone stage when the evidence supports it."""
        stage = self.env['crm.stage'].browse(vals['stage_id'])
        vals = dict(vals)
        now = fields.Datetime.now()
        for lead in self:
            if stage.snaphomz_code == 'consultation_booked' and not (vals.get('consultation_at') or lead.consultation_at):
                raise UserError(_("Record the consultation time on %(lead)s before moving it to Consultation booked.",
                                  lead=lead.display_name))
            if stage.snaphomz_code == 'bra_signed' and not (vals.get('bra_reference') or lead.bra_reference):
                raise UserError(_("Record the agreement ID on %(lead)s before marking the BRA signed.",
                                  lead=lead.display_name))
        if stage.snaphomz_code == 'consultation_booked' and not all(self.mapped('consultation_booked_at')):
            vals.setdefault('consultation_booked_at', now)
        if stage.snaphomz_code == 'consultation_completed':
            if not all(self.mapped('consultation_completed_at')):
                vals.setdefault('consultation_completed_at', now)
        if stage.snaphomz_code == 'bra_sent':
            if not all(self.mapped('bra_sent_at')):
                vals.setdefault('bra_sent_at', now)
            if all(lead.bra_status == 'none' for lead in self):
                vals.setdefault('bra_status', 'sent')
        if stage.snaphomz_code == 'bra_signed':
            if not all(self.mapped('bra_signed_at')):
                vals.setdefault('bra_signed_at', now)
            vals.setdefault('bra_status', 'active')
        return vals

    # ------------------------------------------------------------------
    # Lost / restore / won
    # ------------------------------------------------------------------

    def action_set_lost(self, **additional_values):
        if not additional_values.get('lost_reason_id') and not all(self.mapped('lost_reason_id')):
            raise UserError(_("Choose a reason before marking a buyer unqualified or lost."))
        res = super(CrmLead, self.with_context(snaphomz_skip_validation=True)).action_set_lost(**additional_values)
        self._snaphomz_close_followups(_("Buyer marked unqualified or lost."))
        self.with_context(snaphomz_activity_sync=True).write({
            'buyer_status': 'lost', 'next_action': False, 'next_action_at': False,
        })
        return res

    def action_unarchive(self):
        reopened = self.filtered(lambda l: not l.active and l.buyer_status == 'lost')
        res = super(CrmLead, self.with_context(snaphomz_skip_validation=True)).action_unarchive()
        for lead in reopened:
            team = lead.team_id or self.env['crm.team']._snaphomz_buyer_team()
            status = 'qualified' if lead.type == 'opportunity' else (
                'connected' if lead.last_two_way_contact_at else 'attempting' if lead.attempt_count else 'new')
            lead.write({
                'buyer_status': status,
                'next_action': lead.next_action or _('Re-engage buyer'),
                'next_action_at': lead.next_action_at or team._snaphomz_plan(fields.Datetime.now(), 0),
            })
        return res

    # ------------------------------------------------------------------
    # Next action <-> activity synchronisation
    # ------------------------------------------------------------------

    def _snaphomz_activity_owner(self):
        self.ensure_one()
        team = self.team_id or self.env['crm.team']._snaphomz_buyer_team()
        if self.user_id:
            return self.user_id
        if team.user_id:
            return team.user_id
        return self.env.user if not self._snaphomz_is_integration() else self.env.ref('base.user_admin')

    def _snaphomz_open_followups(self):
        self.ensure_one()
        return self.env['mail.activity'].sudo().search([
            ('res_model', '=', 'crm.lead'), ('res_id', '=', self.id), ('active', '=', True),
        ])

    def _snaphomz_next_action_types(self):
        return (self.env.ref('snaphomz_crm.activity_type_first_contact')
                | self.env.ref('snaphomz_crm.activity_type_call_retry')
                | self.env.ref('snaphomz_crm.activity_type_follow_up'))

    def _snaphomz_upsert_next_activity(self):
        """Write next_action / next_action_at into the lead's next-action activity.

        Only first-contact / call-retry / follow-up activities are rewritten;
        consultations and other scheduled activities are left alone. The
        activity type can be chosen with context key snaphomz_next_activity_type.
        """
        Activity = self.env['mail.activity'].sudo().with_context(snaphomz_activity_sync=True)
        activity_type = self.env.ref(
            self.env.context.get('snaphomz_next_activity_type') or 'snaphomz_crm.activity_type_follow_up')
        next_types = self._snaphomz_next_action_types()
        model_id = self.env['ir.model']._get_id('crm.lead')
        for lead in self:
            if not lead.next_action_at:
                continue
            owner = lead._snaphomz_activity_owner()
            values = {
                'summary': lead.next_action or activity_type.name,
                'snaphomz_due_at': lead.next_action_at,
                'date_deadline': Activity._snaphomz_local_date(lead.next_action_at, owner),
                'user_id': owner.id,
                'activity_type_id': activity_type.id,
            }
            current = lead._snaphomz_open_followups().filtered(
                lambda a: a.activity_type_id in next_types).sorted(lambda a: a._snaphomz_effective_due())[:1]
            if current:
                current.with_context(snaphomz_activity_sync=True).write(values)
            else:
                Activity.create(dict(values, res_model_id=model_id, res_id=lead.id))
        self._snaphomz_sync_next_action_from_activities()

    def _snaphomz_sync_next_action_from_activities(self):
        """Displayed next action = earliest open activity on the record."""
        for lead in self.exists():
            earliest = lead._snaphomz_open_followups().sorted(lambda a: a._snaphomz_effective_due())[:1]
            values = {
                'next_action': earliest and (earliest.summary or earliest.activity_type_id.name) or False,
                'next_action_at': earliest and earliest._snaphomz_effective_due() or False,
            }
            if lead.next_action != values['next_action'] or lead.next_action_at != values['next_action_at']:
                lead.with_context(snaphomz_activity_sync=True, snaphomz_skip_validation=True).sudo().write(values)

    def _snaphomz_close_followups(self, reason):
        for lead in self:
            activities = lead._snaphomz_open_followups()
            if activities:
                activities.with_context(snaphomz_activity_sync=True).unlink()
                lead.message_post(body=_("Open follow-ups closed: %s", reason), subtype_xmlid='mail.mt_note')

    def _snaphomz_reassign_open_activities(self):
        for lead in self:
            owner = lead._snaphomz_activity_owner()
            lead._snaphomz_open_followups().filtered(lambda a: a.user_id != owner).with_context(
                snaphomz_activity_sync=True).write({'user_id': owner.id})

    def _snaphomz_unsubscribe_previous_owners(self, previous_owners):
        """A reassigned buyer's conversation must stop reaching the previous salesperson."""
        for lead in self:
            old = previous_owners.get(lead.id)
            if old and old != lead.user_id and not old.has_group('sales_team.group_sale_salesman_all_leads'):
                lead.sudo().message_unsubscribe(partner_ids=old.partner_id.ids)

    # ------------------------------------------------------------------
    # History
    # ------------------------------------------------------------------

    def _snaphomz_history_vals(self, kind, old, new):
        origin = self.env.context.get('snaphomz_origin') or (
            'integration' if self._snaphomz_is_integration() else 'user')
        vals = {'lead_id': self.id, 'kind': kind, 'actor_id': self.env.uid, 'origin': origin}
        if kind == 'status':
            vals.update(old_status=old or False, new_status=new)
        else:
            vals.update(old_stage_id=old.id if old else False, new_stage_id=new.id if new else False)
        return vals

    def _snaphomz_log_history(self, before):
        History = self.env['snaphomz.stage.history'].sudo()
        rows = []
        for lead in self:
            old_status, old_stage, old_type = before[lead.id]
            if old_status != lead.buyer_status:
                rows.append(lead._snaphomz_history_vals('status', old_status, lead.buyer_status))
            if lead.type == 'opportunity' and old_type == 'lead':
                # Entering the pipeline: stage durations start at conversion.
                rows.append(lead._snaphomz_history_vals('stage', None, lead.stage_id))
            elif old_stage != lead.stage_id and lead.type == 'opportunity':
                rows.append(lead._snaphomz_history_vals('stage', old_stage, lead.stage_id))
        if rows:
            History.create(rows)

    # ------------------------------------------------------------------
    # Loops
    # ------------------------------------------------------------------

    def _snaphomz_loops_stage(self):
        self.ensure_one()
        if self.buyer_status in ('lost', 'nurture'):
            return self.buyer_status
        if self.type == 'opportunity' and self.stage_code:
            return self.stage_code
        return self.buyer_status

    def _snaphomz_loops_properties(self):
        """Whitelisted properties sent to Loops. Never includes `subscribed`."""
        self.ensure_one()
        return {
            'crmPersonId': self.partner_id.snaphomz_person_uuid,
            'buyerStage': self._snaphomz_loops_stage(),
            'buyerReadiness': self.buyer_readiness or '',
            'salesOwnerName': self.user_id.name or '',
            'consultationBooked': bool(self.consultation_booked_at and not self.consultation_cancelled_at),
            'braSigned': self.bra_status == 'active',
            'salesSequenceEligible': self.sales_sequence_eligible,
        }

    def _snaphomz_queue_loops_sync(self):
        if self.env.context.get('snaphomz_origin') == 'loops':
            return
        Queue = self.env['snaphomz.outbound.queue'].sudo()
        for lead in self.filtered(lambda l: l.acquisition_uuid and l.partner_id):
            # The newest acquisition record speaks for the person.
            if not lead.active and lead.partner_id.snaphomz_lead_ids.filtered(lambda l: l.active and l != lead):
                continue
            Queue._enqueue_for_lead(lead)

    # ------------------------------------------------------------------
    # Merge: keep identifiers and history of merged acquisitions
    # ------------------------------------------------------------------

    def _merge_dependences(self, opportunities):
        super()._merge_dependences(opportunities)
        self.ensure_one()
        tails = opportunities - self
        if not tails:
            return
        tails.inquiry_ids.sudo().write({'lead_id': self.id})
        tails.stage_history_ids.sudo().write({'lead_id': self.id})
        self.env['snaphomz.inbound.event'].sudo().search([('lead_id', 'in', tails.ids)]).write({'lead_id': self.id})
        merged = [u for u in (self.merged_acquisition_uuids or '').split() if u]
        for tail in tails:
            merged += [tail.acquisition_uuid] + (tail.merged_acquisition_uuids or '').split()
        values = {'merged_acquisition_uuids': ' '.join(sorted(set(filter(None, merged))))}
        earliest = min(opportunities, key=lambda l: l.origin_at or l.create_date)
        if earliest != self:
            for fname in ORIGIN_FIELDS:
                value = earliest[fname]
                values[fname] = value.id if isinstance(value, models.BaseModel) else value
        self.sudo().with_context(snaphomz_skip_validation=True).write(values)

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def action_snaphomz_log_outcome(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Log outcome'),
            'res_model': 'snaphomz.log.outcome',
            'view_mode': 'form',
            'target': 'new',
            'context': {'default_lead_id': self.id},
        }

    def action_snaphomz_qualify(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Qualify buyer'),
            'res_model': 'snaphomz.qualify',
            'view_mode': 'form',
            'target': 'new',
            'context': {'default_lead_id': self.id},
        }

    def action_snaphomz_view_inquiries(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Inquiries'),
            'res_model': 'snaphomz.inquiry',
            'view_mode': 'list,form',
            'domain': [('lead_id', '=', self.id)],
        }

    def action_snaphomz_view_marketing_events(self):
        self.ensure_one()
        return self.partner_id.action_snaphomz_view_marketing_events()

    def action_snaphomz_clear_review(self):
        self.write({'snaphomz_needs_review': False})


HUMAN_FIELDS_SET = set(HUMAN_FIELDS)
