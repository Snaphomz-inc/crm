from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import html_escape

from .common import normalize_email


class SnaphomzInboundEmail(models.Model):
    """Fallback target of the sales mailbox.

    Replies to emails sent from Odoo thread onto the lead automatically. Loops
    campaign replies have no Odoo thread, so the gateway hands them to this
    model: the sender is matched to a buyer by identity key and the email is
    moved onto that buyer's acquisition record. Anything ambiguous stays here
    in the unmatched queue with a named owner; nothing is guessed.
    """
    _name = 'snaphomz.inbound.email'
    _description = 'Sales mailbox email'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'received_at desc, id desc'

    name = fields.Char('Subject', required=True, default=lambda self: _('(no subject)'))
    email_from = fields.Char('From', readonly=True)
    received_at = fields.Datetime(default=fields.Datetime.now, readonly=True, index=True)
    partner_id = fields.Many2one('res.partner', 'Buyer', readonly=True)
    lead_id = fields.Many2one('crm.lead', 'Acquisition', domain="[('acquisition_uuid', '!=', False)]")
    owner_id = fields.Many2one('res.users', 'Review owner', tracking=True)
    state = fields.Selection([
        ('matched', 'Attached automatically'),
        ('unmatched', 'Unmatched'),
        ('attached', 'Attached by a person'),
        ('ignored', 'Ignored'),
    ], default='unmatched', required=True, index=True, tracking=True)
    match_note = fields.Char(readonly=True)

    @api.model
    def _snaphomz_match_sender(self, email_from):
        email = normalize_email(email_from)
        if not email:
            return self.env['crm.lead'], _('sender address could not be read')
        key = self.env['snaphomz.identity.key'].sudo().search([('kind', '=', 'email'), ('value', '=', email)], limit=1)
        if not key:
            return self.env['crm.lead'], _('no buyer with this email')
        leads = key.partner_id.with_context(active_test=False).snaphomz_lead_ids.filtered('acquisition_uuid')
        active = leads.filtered('active')
        if len(active) == 1:
            return active, _('matched by sender email')
        if not active and len(leads) == 1:
            return leads, _('matched to closed acquisition')
        return self.env['crm.lead'], _('sender matches several acquisition records')

    @api.model
    def message_new(self, msg_dict, custom_values=None):
        lead, note = self._snaphomz_match_sender(msg_dict.get('email_from'))
        team = self.env['crm.team']._snaphomz_buyer_team()
        values = dict(custom_values or {}, **{
            'name': msg_dict.get('subject') or _('(no subject)'),
            'email_from': msg_dict.get('email_from'),
            'partner_id': lead.partner_id.id if lead else msg_dict.get('author_id') or False,
            'lead_id': lead.id if lead else False,
            'state': 'matched' if lead else 'unmatched',
            'owner_id': (lead.user_id or team.user_id).id if lead else team.user_id.id,
            'match_note': note,
        })
        return super().message_new(msg_dict, custom_values=values)

    def _message_post_after_hook(self, message, msg_vals):
        res = super()._message_post_after_hook(message, msg_vals)
        if message.message_type == 'email':
            for record in self.filtered(lambda r: r.state == 'matched' and r.lead_id):
                record._snaphomz_move_to_lead(record.lead_id)
            for record in self.filtered(lambda r: r.state == 'unmatched' and r.owner_id):
                record.sudo().activity_schedule(
                    'mail.mail_activity_data_todo', user_id=record.owner_id.id,
                    summary=_('Match unmatched sales email'), note=record.match_note)
        return res

    def _snaphomz_move_to_lead(self, lead):
        """Move received emails onto the acquisition and alert its owner."""
        self.ensure_one()
        messages = self.sudo().message_ids.filtered(lambda m: m.message_type == 'email')
        if not messages:
            return
        messages.write({'model': 'crm.lead', 'res_id': lead.id})
        messages.attachment_ids.write({'res_model': 'crm.lead', 'res_id': lead.id})
        lead = lead.sudo()
        received = max(messages.mapped('date'))
        # A real buyer reply is a buyer response (never an automated signal).
        if not lead.last_buyer_response_at or received > lead.last_buyer_response_at:
            lead.with_context(snaphomz_skip_validation=True).write({'last_buyer_response_at': received})
        lead.partner_id._snaphomz_touch('last_marketing_engagement_at', received)
        if lead.active:
            lead._snaphomz_stop_contact_retries(_('Buyer replied by email'))
            team = lead.team_id or self.env['crm.team']._snaphomz_buyer_team()
            owner = lead._snaphomz_activity_owner()
            due = team._snaphomz_plan(fields.Datetime.now(), 0)
            self.env['mail.activity'].sudo().create({
                'res_model_id': self.env['ir.model']._get_id('crm.lead'),
                'res_id': lead.id,
                'activity_type_id': self.env.ref('mail.mail_activity_data_email').id,
                'summary': _('Reply to buyer email'),
                'snaphomz_due_at': due,
                'date_deadline': self.env['mail.activity']._snaphomz_local_date(due, owner),
                'user_id': owner.id,
            })
        else:
            lead.write({'snaphomz_needs_review': True,
                        'snaphomz_review_note': _('Buyer replied by email to a closed acquisition.')})

    def action_attach_to_lead(self):
        for record in self:
            if not record.lead_id:
                raise UserError(_("Choose the acquisition record first."))
            record._snaphomz_move_to_lead(record.lead_id)
            record.write({'state': 'attached', 'partner_id': record.lead_id.partner_id.id})
            record.activity_ids.action_feedback(feedback=_('Attached to %s', record.lead_id.display_name))
        return True

    def action_ignore(self):
        self.write({'state': 'ignored'})
        self.activity_ids.action_feedback(feedback=_('Ignored'))
        return True

    def _snaphomz_notify_body(self):
        return html_escape(self.match_note or '')
