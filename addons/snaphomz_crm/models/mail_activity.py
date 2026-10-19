from datetime import datetime, time

import pytz

from odoo import api, fields, models

SYNC_FIELDS = {'active', 'date_deadline', 'snaphomz_due_at', 'summary', 'activity_type_id', 'res_id', 'res_model_id'}


class MailActivity(models.Model):
    _inherit = 'mail.activity'

    snaphomz_due_at = fields.Datetime(
        'Due at', help="Exact due time. Activities scheduled with a date only are due at the end of that day.")

    def _snaphomz_effective_due(self):
        self.ensure_one()
        if self.snaphomz_due_at:
            return self.snaphomz_due_at
        tz = pytz.timezone(self.user_id.tz or self.env.user.tz or 'UTC')
        end_of_day = tz.localize(datetime.combine(self.date_deadline, time(23, 59, 59)))
        return end_of_day.astimezone(pytz.utc).replace(tzinfo=None)

    @api.model
    def _snaphomz_local_date(self, moment, user):
        tz = pytz.timezone(user.tz or 'UTC')
        return pytz.utc.localize(moment).astimezone(tz).date()

    def _snaphomz_leads(self):
        lead_ids = {a.res_id for a in self.sudo() if a.res_model == 'crm.lead' and a.res_id}
        return self.env['crm.lead'].sudo().with_context(active_test=False).browse(lead_ids)

    @api.model_create_multi
    def create(self, vals_list):
        activities = super().create(vals_list)
        if not self.env.context.get('snaphomz_activity_sync'):
            activities._snaphomz_leads()._snaphomz_sync_next_action_from_activities()
        return activities

    def write(self, vals):
        if 'date_deadline' in vals and 'snaphomz_due_at' not in vals and not self.env.context.get('snaphomz_activity_sync'):
            # Rescheduled from the chatter by date: drop the old exact time.
            vals = dict(vals, snaphomz_due_at=False)
        leads = self._snaphomz_leads() if SYNC_FIELDS & set(vals) else self.env['crm.lead']
        res = super().write(vals)
        if leads and not self.env.context.get('snaphomz_activity_sync'):
            (leads | self._snaphomz_leads())._snaphomz_sync_next_action_from_activities()
        return res

    def unlink(self):
        leads = self._snaphomz_leads()
        res = super().unlink()
        if not self.env.context.get('snaphomz_activity_sync'):
            leads._snaphomz_sync_next_action_from_activities()
        return res
