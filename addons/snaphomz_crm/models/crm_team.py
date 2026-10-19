from datetime import datetime, time, timedelta

import pytz

from odoo import fields, models


class CrmTeam(models.Model):
    _inherit = 'crm.team'

    snaphomz_is_buyer_team = fields.Boolean('Buyer acquisition team')
    snaphomz_intake_user_id = fields.Many2one(
        'res.users', 'Designated intake salesperson', domain="[('share', '=', False)]",
        help="New, unowned buyer inquiries are assigned to this salesperson while they are available.")
    snaphomz_intake_available = fields.Boolean(
        'Intake salesperson available', default=True,
        help="Untick while the designated salesperson is away.")
    snaphomz_backup_user_id = fields.Many2one(
        'res.users', 'Backup intake salesperson', domain="[('share', '=', False)]",
        help="Used when the designated intake salesperson is unavailable.")
    snaphomz_backup_available = fields.Boolean('Backup available', default=True)
    snaphomz_calendar_id = fields.Many2one(
        'resource.calendar', 'Staffed hours',
        help="Staffed days, hours and timezone used for first-contact reminders and retry proposals.")
    snaphomz_first_contact_minutes = fields.Integer(
        'Owner reminder after (staffed minutes)', default=15)
    snaphomz_escalation_minutes = fields.Integer(
        'Manager escalation after (staffed minutes)', default=30)
    snaphomz_retry_attempt_limit = fields.Integer(
        'Unanswered attempts before nurture review', default=3)

    def _snaphomz_buyer_team(self):
        team = self.env.ref('snaphomz_crm.team_buyer_acquisition', raise_if_not_found=False)
        if not team:
            team = self.search([('snaphomz_is_buyer_team', '=', True)], limit=1)
        return team.sudo()

    def _snaphomz_calendar(self):
        self.ensure_one()
        return (
            self.snaphomz_calendar_id
            or self.env.ref('snaphomz_crm.calendar_sales_coverage', raise_if_not_found=False)
            or self.env.company.resource_calendar_id
        ).sudo()

    # ------------------------------------------------------------------
    # Business-time helpers. All inputs and outputs are naive UTC datetimes.
    # ------------------------------------------------------------------

    def _snaphomz_plan(self, start, minutes):
        """Return the moment `minutes` staffed minutes after `start`.

        With minutes=0 this is the next staffed opening (or `start` itself
        when it is already inside staffed hours). Public holidays defined on
        the calendar are skipped.
        """
        calendar = self._snaphomz_calendar()
        aware = pytz.utc.localize(start)
        planned = calendar.plan_hours(minutes / 60.0, aware, compute_leaves=True)
        if not planned:
            return start + timedelta(minutes=minutes)
        return planned.astimezone(pytz.utc).replace(tzinfo=None)

    def _snaphomz_is_staffed(self, moment):
        return self._snaphomz_plan(moment, 0) == moment

    def _snaphomz_next_staffed_day(self, moment):
        """Same local time on the next staffed day, clipped into staffed hours."""
        calendar = self._snaphomz_calendar()
        tz = pytz.timezone(calendar.tz or 'UTC')
        local = pytz.utc.localize(moment).astimezone(tz)
        tomorrow = tz.localize(datetime.combine(local.date() + timedelta(days=1), time.min), is_dst=False)
        intervals = calendar._work_intervals_batch(
            tomorrow.astimezone(pytz.utc), tomorrow.astimezone(pytz.utc) + timedelta(days=21),
        )[False]
        days = {}
        for start, stop, _meta in intervals:
            days.setdefault(start.astimezone(tz).date(), []).append((start, stop))
        if not days:
            return self._snaphomz_plan(moment + timedelta(days=1), 0)
        first_day = min(days)
        day_intervals = sorted(days[first_day])
        candidate = tz.localize(datetime.combine(first_day, local.time().replace(microsecond=0)), is_dst=False)
        chosen = next(
            (candidate for start, stop in day_intervals if start <= candidate < stop),
            day_intervals[0][0],
        )
        return chosen.astimezone(pytz.utc).replace(tzinfo=None)

    def _snaphomz_pick_intake_owner(self):
        """Designated intake salesperson, else the backup, else nobody (manager queue)."""
        self.ensure_one()
        for user, available in ((self.snaphomz_intake_user_id, self.snaphomz_intake_available),
                                (self.snaphomz_backup_user_id, self.snaphomz_backup_available)):
            if user and user.active and available:
                return user
        return self.env['res.users']
