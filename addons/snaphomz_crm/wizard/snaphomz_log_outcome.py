from datetime import datetime, timedelta

import pytz

from odoo import _, api, fields, models
from odoo.exceptions import UserError
from odoo.tools import html_escape

from ..models.common import OUTCOMES, RETRY_OUTCOMES, TWO_WAY_OUTCOMES

DEFAULT_NEXT_ACTIONS = {
    'no_answer': 'Call again',
    'voicemail': 'Call again',
    'wrong_details': 'Verify contact details',
    'spoke': 'Follow up as agreed',
    'requested_callback': 'Call back as requested',
}


class SnaphomzLogOutcome(models.TransientModel):
    """One action for every interaction: outcome, summary, next action."""
    _name = 'snaphomz.log.outcome'
    _description = 'Log buyer outcome'

    lead_id = fields.Many2one('crm.lead', required=True, ondelete='cascade')
    outcome = fields.Selection(OUTCOMES, required=True)
    summary = fields.Text('What happened / what was agreed', required=True)
    next_action = fields.Char('Next action')
    next_action_at = fields.Datetime('Due')
    buyer_timezone = fields.Selection(related='lead_id.buyer_timezone')
    buyer_local_time = fields.Char('Buyer local time', compute='_compute_buyer_local_time')
    attempt_count = fields.Integer(related='lead_id.attempt_count')
    attempts_warning = fields.Char(compute='_compute_attempts_warning')

    @api.depends('lead_id')
    def _compute_buyer_local_time(self):
        for wizard in self:
            tz = wizard.lead_id.buyer_timezone
            wizard.buyer_local_time = datetime.now(pytz.timezone(tz)).strftime('%a %H:%M (%Z)') if tz else _('Timezone unknown')

    @api.depends('lead_id', 'outcome')
    def _compute_attempts_warning(self):
        for wizard in self:
            lead = wizard.lead_id
            limit = lead.team_id.snaphomz_retry_attempt_limit or 3
            wizard.attempts_warning = False
            if (wizard.outcome in RETRY_OUTCOMES and not lead.last_two_way_contact_at
                    and lead.attempt_count + 1 >= limit):
                wizard.attempts_warning = _(
                    "This is unanswered attempt %(n)s of %(limit)s: review the buyer for nurture.",
                    n=lead.attempt_count + 1, limit=limit)

    @api.onchange('outcome')
    def _onchange_outcome(self):
        if not self.outcome:
            return
        if self.outcome == 'do_not_contact':
            self.next_action = False
            self.next_action_at = False
            return
        self.next_action = _(DEFAULT_NEXT_ACTIONS[self.outcome])
        team = self.lead_id.team_id or self.env['crm.team']._snaphomz_buyer_team()
        if self.outcome in RETRY_OUTCOMES + ('wrong_details',):
            self.next_action_at = team._snaphomz_next_staffed_day(fields.Datetime.now())
            if self.attempts_warning:
                self.next_action = _('Review for nurture')
        else:
            self.next_action_at = False

    def action_save(self):
        self.ensure_one()
        lead = self.lead_id
        now = fields.Datetime.now()
        if self.outcome != 'do_not_contact':
            if not (self.next_action and self.next_action_at):
                raise UserError(_("Record the next action and when it is due."))
            if self.next_action_at < now - timedelta(minutes=5):
                raise UserError(_("The next action must be due in the future."))

        vals = {
            'attempt_count': lead.attempt_count + 1,
            'last_human_attempt_at': now,
            'last_outcome': self.outcome,
            'last_outcome_at': now,
        }
        if not lead.first_human_attempt_at:
            vals['first_human_attempt_at'] = now
        if self.outcome in TWO_WAY_OUTCOMES:
            vals.update(last_two_way_contact_at=now, last_buyer_response_at=now)
            if lead.buyer_status in ('new', 'attempting'):
                vals['buyer_status'] = 'connected'
        elif lead.buyer_status == 'new':
            vals['buyer_status'] = 'attempting'

        outcome_label = dict(OUTCOMES)[self.outcome]
        lines = [f"<b>{html_escape(outcome_label)}</b>", html_escape(self.summary).replace('\n', '<br/>')]
        if self.outcome != 'do_not_contact':
            due = fields.Datetime.context_timestamp(self, self.next_action_at).strftime('%Y-%m-%d %H:%M %Z')
            lines.append(html_escape(_('Next: %(action)s — %(due)s', action=self.next_action, due=due)))
        lead.message_post(body='<br/>'.join(lines), subtype_xmlid='mail.mt_note')

        # Contact follow-ups this interaction fulfilled are completed (kept as
        # archived history); consultations and other scheduled work stay open.
        fulfilled = lead._snaphomz_open_followups().filtered(
            lambda a: a.activity_type_id in lead._snaphomz_next_action_types())
        fulfilled.with_context(snaphomz_activity_sync=True).write({'active': False, 'feedback': self.summary})

        lead = lead.with_context(snaphomz_log_outcome=True)
        if self.outcome == 'do_not_contact':
            lead.with_context(snaphomz_skip_validation=True).write(vals)
            lead.partner_id.sudo().write({'do_not_contact': True})
            lead.action_set_lost(lost_reason_id=self.env.ref('snaphomz_crm.lost_reason_do_not_contact').id)
            return {'type': 'ir.actions.act_window_close'}

        vals.update(next_action=self.next_action, next_action_at=self.next_action_at)
        activity_type = ('snaphomz_crm.activity_type_call_retry' if self.outcome in RETRY_OUTCOMES
                         else 'snaphomz_crm.activity_type_follow_up')
        lead.with_context(snaphomz_next_activity_type=activity_type).write(vals)
        return {'type': 'ir.actions.act_window_close'}
