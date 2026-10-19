from datetime import datetime, timedelta

from freezegun import freeze_time

from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests import Form, tagged

from .common import STAFFED_NOW, SnaphomzCase


@tagged('post_install', '-at_install', 'snaphomz')
@freeze_time(STAFFED_NOW)
class TestOutcome(SnaphomzCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()

    def setUp(self):
        super().setUp()
        self.submit(self.payload(email='outcome@example.com'))
        self.lead = self.lead_for('outcome@example.com').with_user(self.rep_a)

    def log(self, outcome, summary='Talked', next_action='Send listings', next_action_at=None):
        wizard = Form(self.env['snaphomz.log.outcome'].with_user(self.rep_a).with_context(default_lead_id=self.lead.id))
        wizard.outcome = outcome
        wizard.summary = summary
        if outcome != 'do_not_contact':
            if next_action:
                wizard.next_action = next_action
            if next_action_at:
                wizard.next_action_at = next_action_at
        return wizard.save().action_save()

    def test_log_spoke(self):
        """Acceptance 4: Spoke + summary + next action; manager sees it; clocks reflect the action."""
        due = STAFFED_NOW + timedelta(days=1)
        self.log('spoke', summary='Wants 3-bed in Austin', next_action='Send listings', next_action_at=due)
        lead = self.lead
        self.assertEqual(lead.attempt_count, 1)
        self.assertEqual(lead.first_human_attempt_at, STAFFED_NOW)
        self.assertEqual(lead.last_human_attempt_at, STAFFED_NOW)
        self.assertEqual(lead.last_two_way_contact_at, STAFFED_NOW)
        self.assertEqual(lead.last_buyer_response_at, STAFFED_NOW)
        self.assertEqual(lead.buyer_status, 'connected')
        self.assertEqual(lead.last_outcome, 'spoke')
        self.assertEqual(lead.next_action, 'Send listings')
        self.assertEqual(lead.next_action_at, due)

        open_acts = self.open_activities(lead)
        self.assertEqual(len(open_acts), 1, "the first-contact task is completed and replaced")
        self.assertEqual(open_acts.summary, 'Send listings')
        self.assertEqual(open_acts.snaphomz_due_at, due)
        done = self.env['mail.activity'].with_context(active_test=False).search(
            [('res_model', '=', 'crm.lead'), ('res_id', '=', lead.id), ('active', '=', False)])
        self.assertEqual(done.activity_type_id, self.env.ref('snaphomz_crm.activity_type_first_contact'))

        manager_view = lead.with_user(self.manager)
        self.assertIn('Wants 3-bed in Austin', ' '.join(manager_view.message_ids.mapped('body')))
        self.assertEqual(manager_view.last_outcome, 'spoke')

    def test_no_answer_proposes_next_staffed_day(self):
        wizard = Form(self.env['snaphomz.log.outcome'].with_user(self.rep_a).with_context(default_lead_id=self.lead.id))
        wizard.outcome = 'no_answer'
        wizard.summary = 'Rang out'
        # Monday 10:00 EDT -> Tuesday 10:00 EDT.
        self.assertEqual(wizard.next_action_at, datetime(2026, 10, 20, 14, 0))
        wizard.save().action_save()
        self.assertEqual(self.lead.buyer_status, 'attempting')
        self.assertFalse(self.lead.last_two_way_contact_at)
        self.assertEqual(self.open_activities(self.lead).activity_type_id,
                         self.env.ref('snaphomz_crm.activity_type_call_retry'))

    def test_attempts_exhausted_after_limit(self):
        for _i in range(3):
            self.log('voicemail', next_action='Call again', next_action_at=STAFFED_NOW + timedelta(days=1))
        self.assertTrue(self.lead.attempts_exhausted)
        self.assertIn(self.lead, self.env['crm.lead'].with_user(self.manager).search([('attempts_exhausted', '=', True)]))

    def test_do_not_contact(self):
        self.log('do_not_contact', summary='Asked to stop')
        lead = self.lead
        self.assertFalse(lead.active)
        self.assertEqual(lead.buyer_status, 'lost')
        self.assertEqual(lead.lost_reason_id, self.env.ref('snaphomz_crm.lost_reason_do_not_contact'))
        self.assertTrue(lead.partner_id.do_not_contact)
        self.assertFalse(lead.sales_sequence_eligible)
        self.assertFalse(self.open_activities(lead))

    def test_next_action_required_on_form_and_api_writes(self):
        """Acceptance 5: active records cannot lose their next action; reasons are enforced."""
        with self.assertRaises(ValidationError):
            self.lead.write({'next_action_at': False})
        with self.assertRaises(ValidationError):
            self.lead.write({'buyer_status': 'nurture'})
        with self.assertRaises(UserError):
            self.lead.action_set_lost()
        with self.assertRaises(ValidationError):
            self.lead.with_context(snaphomz_activity_sync=False).write({'buyer_status': 'lost'})

    def test_clocks_only_move_through_log_outcome(self):
        with self.assertRaises(AccessError):
            self.lead.write({'last_two_way_contact_at': STAFFED_NOW})
        with self.assertRaises(AccessError):
            self.lead.write({'attempt_count': 5})

    def test_completing_activity_without_outcome_leaves_lead_missing_next_action(self):
        self.open_activities(self.lead).with_user(self.rep_a).action_feedback(feedback='done')
        self.assertFalse(self.lead.next_action_at)
        self.assertTrue(self.lead.missing_next_action)
        self.assertIn(self.lead, self.env['crm.lead'].with_user(self.rep_a).search(
            [('user_id', '=', self.rep_a.id), ('missing_next_action', '=', True)]))
        self.assertEqual(self.lead.attempt_count, 0, "a completed task is not proof of a conversation")

    def test_rescheduling_activity_updates_displayed_next_action(self):
        activity = self.open_activities(self.lead)
        activity.with_user(self.rep_a).write({'date_deadline': '2026-10-22'})
        # Date-only activities are due at the end of that day in the assignee's timezone.
        self.assertEqual(self.lead.next_action_at, datetime(2026, 10, 23, 3, 59, 59))

    def test_earliest_activity_drives_next_action(self):
        self.lead.activity_schedule('mail.mail_activity_data_call', date_deadline=STAFFED_NOW.date(),
                                    summary='Earlier call', user_id=self.rep_a.id)
        self.lead.write({'next_action': 'Later follow-up', 'next_action_at': STAFFED_NOW + timedelta(days=3)})
        self.assertEqual(self.lead.next_action, 'Earlier call')

    def test_overdue_and_due_today_filters(self):
        Lead = self.env['crm.lead'].with_user(self.rep_a)
        self.assertIn(self.lead, Lead.search([('is_due_today', '=', True)]))
        self.assertNotIn(self.lead, Lead.search([('is_overdue', '=', True)]))
        with freeze_time(STAFFED_NOW + timedelta(hours=2)):
            self.assertIn(self.lead, Lead.search([('is_overdue', '=', True)]))

    def test_qualify_ready_now_converts_once(self):
        wizard = self.env['snaphomz.qualify'].with_user(self.rep_a).create({
            'lead_id': self.lead.id, 'readiness': 'ready_now', 'reason': 'Pre-approved, buying in 60 days',
            'next_action': 'Book consultation', 'next_action_at': STAFFED_NOW + timedelta(hours=4),
        })
        wizard.action_apply()
        lead = self.lead
        self.assertEqual(lead.type, 'opportunity')
        self.assertEqual(lead.stage_id, self.env.ref('snaphomz_crm.stage_qualified'))
        self.assertEqual(lead.buyer_status, 'qualified')
        self.assertEqual(lead.qualified_by_id, self.rep_a)
        self.assertEqual(lead.inquiry_count, 1, "conversion keeps inquiries and identifiers")
        history = lead.stage_history_ids.filtered(lambda h: h.kind == 'status')
        self.assertEqual(history.sorted('id').mapped('new_status'), ['new', 'qualified'])

    def test_generic_conversion_requires_qualification(self):
        with self.assertRaises(UserError):
            self.lead.write({'type': 'opportunity'})

    def test_qualify_nurture_requires_reason_and_review(self):
        wizard = self.env['snaphomz.qualify'].with_user(self.rep_a).create({
            'lead_id': self.lead.id, 'readiness': 'needs_preparation', 'reason': 'Credit repair first'})
        with self.assertRaises(UserError):
            wizard.action_apply()
        wizard.write({'nurture_reason_id': self.env.ref('snaphomz_crm.nurture_reason_financing').id,
                      'nurture_review_date': '2026-12-01'})
        wizard.action_apply()
        self.assertEqual(self.lead.buyer_status, 'nurture')
        # Review date at the staffed opening: 09:00 EST on 1 Dec = 14:00 UTC.
        self.assertEqual(self.lead.next_action_at, datetime(2026, 12, 1, 14, 0))

    def test_restore_lost_buyer_requires_next_action(self):
        self.lead.action_set_lost(lost_reason_id=self.env.ref('snaphomz_crm.lost_reason_unreachable').id)
        self.assertEqual(self.lead.buyer_status, 'lost')
        self.lead.with_user(self.rep_a).action_restore()
        self.assertTrue(self.lead.active)
        self.assertEqual(self.lead.buyer_status, 'new')
        self.assertTrue(self.lead.next_action_at)
