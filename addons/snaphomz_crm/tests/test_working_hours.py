from datetime import datetime

from freezegun import freeze_time

from odoo.tests import tagged

from .common import SnaphomzCase


@tagged('post_install', '-at_install', 'snaphomz')
class TestWorkingHours(SnaphomzCase):
    """Acceptance 10: after-hours, other timezones and the DST boundary."""

    def test_inside_hours(self):
        # Monday 19 Oct 10:00 EDT.
        self.assertEqual(self.team._snaphomz_plan(datetime(2026, 10, 19, 14, 0), 15), datetime(2026, 10, 19, 14, 15))

    def test_spans_closing_time(self):
        # Monday 17:55 EDT + 15 staffed minutes -> Tuesday 09:10 EDT.
        self.assertEqual(self.team._snaphomz_plan(datetime(2026, 10, 19, 21, 55), 15), datetime(2026, 10, 20, 13, 10))

    def test_dst_boundary(self):
        # Friday 30 Oct 17:55 EDT (UTC-4); DST ends Sunday 1 Nov; Monday 09:10 EST (UTC-5) = 14:10 UTC.
        self.assertEqual(self.team._snaphomz_plan(datetime(2026, 10, 30, 21, 55), 15), datetime(2026, 11, 2, 14, 10))

    def test_next_staffed_day_keeps_local_time(self):
        # Friday 30 Oct 11:00 EDT -> Monday 2 Nov 11:00 EST = 16:00 UTC.
        self.assertEqual(self.team._snaphomz_next_staffed_day(datetime(2026, 10, 30, 15, 0)), datetime(2026, 11, 2, 16, 0))
        # Monday 20:00 EDT (after hours) -> Tuesday, clipped to the 09:00 opening.
        self.assertEqual(self.team._snaphomz_next_staffed_day(datetime(2026, 10, 20, 0, 0)), datetime(2026, 10, 20, 13, 0))

    def test_buyer_in_another_timezone(self):
        with freeze_time(datetime(2026, 10, 19, 23, 30)):  # 19:30 EDT, 16:30 in Los Angeles
            self.submit(self.payload(email='la@example.com', event_time='2026-10-19T23:30:00Z',
                                     person={'timezone': 'America/Los_Angeles'}))
        lead = self.lead_for('la@example.com')
        self.assertEqual(lead.partner_id.tz, 'America/Los_Angeles')
        # Staffed clock starts at the team's next opening (stored in UTC); due 15 staffed minutes later.
        self.assertEqual(lead.sla_start_at, datetime(2026, 10, 20, 13, 0))
        self.assertEqual(lead.next_action_at, datetime(2026, 10, 20, 13, 15))

    def test_reminders_and_escalation(self):
        with freeze_time(datetime(2026, 10, 19, 14, 0)):
            self.submit(self.payload(email='sla@example.com'))
        lead = self.lead_for('sla@example.com')
        Lead = self.env['crm.lead']
        with freeze_time(datetime(2026, 10, 19, 14, 10)):
            Lead._cron_snaphomz_first_contact_alerts()
        self.assertFalse(lead.sla_owner_alerted)
        with freeze_time(datetime(2026, 10, 19, 14, 16)):
            Lead._cron_snaphomz_first_contact_alerts()
        self.assertTrue(lead.sla_owner_alerted)
        self.assertFalse(lead.sla_manager_alerted)
        with freeze_time(datetime(2026, 10, 19, 14, 31)):
            Lead._cron_snaphomz_first_contact_alerts()
        self.assertTrue(lead.sla_manager_alerted)
        notified = self.env['mail.message'].search([('model', '=', 'crm.lead'), ('res_id', '=', lead.id),
                                                    ('message_type', '=', 'user_notification')])
        self.assertEqual(set(notified.partner_ids.ids) & {self.rep_a.partner_id.id, self.manager.partner_id.id},
                         {self.rep_a.partner_id.id, self.manager.partner_id.id})

    def test_overdue_digest_runs(self):
        with freeze_time(datetime(2026, 10, 19, 14, 0)):
            self.submit(self.payload(email='late@example.com'))
        with freeze_time(datetime(2026, 10, 20, 14, 0)):
            self.env['crm.lead']._cron_snaphomz_overdue_digest()
        digest = self.env['mail.message'].search([('model', '=', 'crm.team'), ('res_id', '=', self.team.id),
                                                  ('subject', 'ilike', 'overdue')])
        self.assertTrue(digest)
        self.assertIn('Jane Buyer', ' '.join(digest.mapped('body')))
