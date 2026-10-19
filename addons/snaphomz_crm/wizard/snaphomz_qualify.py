from datetime import datetime, time

import pytz

from odoo import _, fields, models
from odoo.exceptions import UserError
from odoo.tools import html_escape

from ..models.common import READINESS


class SnaphomzQualify(models.TransientModel):
    """A salesperson confirms readiness. Ready now converts the lead (once);
    needs preparation / exploring moves it to nurture; unqualified closes it."""
    _name = 'snaphomz.qualify'
    _description = 'Qualify buyer'

    lead_id = fields.Many2one('crm.lead', required=True, ondelete='cascade')
    readiness = fields.Selection(READINESS, required=True)
    reason = fields.Text('Qualification reason', required=True)
    next_action = fields.Char('Next action', default=lambda self: _('Book consultation'))
    next_action_at = fields.Datetime('Due')
    nurture_reason_id = fields.Many2one('snaphomz.nurture.reason', 'Nurture reason')
    nurture_review_date = fields.Date('Review on')
    lost_reason_id = fields.Many2one('crm.lost.reason', 'Reason')

    def _review_moment(self, team):
        calendar = team._snaphomz_calendar()
        tz = pytz.timezone(calendar.tz or 'UTC')
        local_midnight = tz.localize(datetime.combine(self.nurture_review_date, time.min))
        return team._snaphomz_plan(local_midnight.astimezone(pytz.utc).replace(tzinfo=None), 0)

    def action_apply(self):
        self.ensure_one()
        lead = self.lead_id
        team = lead.team_id or self.env['crm.team']._snaphomz_buyer_team()
        base = {'buyer_readiness': self.readiness, 'qualification_reason': self.reason}
        label = dict(READINESS)[self.readiness]
        lead.message_post(
            body=f"<b>{html_escape(_('Readiness: %s', label))}</b><br/>{html_escape(self.reason)}",
            subtype_xmlid='mail.mt_note')

        if self.readiness == 'ready_now':
            if not (self.next_action and self.next_action_at):
                raise UserError(_("Set the next action (for example booking the consultation) and its due time."))
            lead.with_context(snaphomz_qualifying=True).write(dict(
                base, buyer_status='qualified', next_action=self.next_action, next_action_at=self.next_action_at))
            if lead.type == 'lead':
                lead.with_context(snaphomz_qualifying=True).convert_opportunity(lead.partner_id)
                Stage = self.env['crm.stage']
                code = 'consultation_booked' if lead.consultation_at and lead.consultation_booked_at else 'qualified'
                lead.with_context(snaphomz_qualifying=True).write({'stage_id': Stage._snaphomz_get(code).id})
            return lead.redirect_lead_opportunity_view()

        if self.readiness in ('needs_preparation', 'exploring'):
            if not (self.nurture_reason_id and self.nurture_review_date):
                raise UserError(_("Nurture needs a reason and a review date."))
            lead.write(dict(
                base, buyer_status='nurture', nurture_reason_id=self.nurture_reason_id.id,
                nurture_review_date=self.nurture_review_date, next_action=_('Nurture review'),
                next_action_at=self._review_moment(team)))
            return {'type': 'ir.actions.act_window_close'}

        if not self.lost_reason_id:
            raise UserError(_("Choose why the buyer is unqualified."))
        lead.with_context(snaphomz_skip_validation=True).write(base)
        lead.action_set_lost(lost_reason_id=self.lost_reason_id.id)
        return {'type': 'ir.actions.act_window_close'}
