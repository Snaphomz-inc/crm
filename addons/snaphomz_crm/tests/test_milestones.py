from datetime import datetime, timedelta

from freezegun import freeze_time

from odoo.exceptions import UserError
from odoo.tests import tagged

from .common import STAFFED_NOW, SnaphomzCase


@tagged('post_install', '-at_install', 'snaphomz')
@freeze_time(STAFFED_NOW)
class TestMilestones(SnaphomzCase):

    def setUp(self):
        super().setUp()
        self.submit(self.payload(email='milestone@example.com'))
        self.lead = self.lead_for('milestone@example.com')

    def qualify(self):
        self.env['snaphomz.qualify'].with_user(self.rep_a).create({
            'lead_id': self.lead.id, 'readiness': 'ready_now', 'reason': 'Ready',
            'next_action': 'Book consultation', 'next_action_at': STAFFED_NOW + timedelta(hours=2),
        }).action_apply()

    def event(self, event_type, event_id, **extra):
        return self.submit(self.payload(email='milestone@example.com', event_type=event_type,
                                        event_id=event_id, **extra))

    def test_consultation_booking_supplies_next_action_and_stops_retries(self):
        self.qualify()
        start = datetime(2026, 10, 21, 15, 0)
        self.event('consultation_booked', 'book-1', consultation={'start_at': '2026-10-21T15:00:00Z', 'booking_id': 'B1'})
        self.assertEqual(self.lead.stage_id, self.env.ref('snaphomz_crm.stage_consultation_booked'))
        self.assertEqual(self.lead.consultation_at, start)
        self.assertEqual(self.lead.next_action, 'Consultation')
        self.assertEqual(self.lead.next_action_at, start)
        retry_types = (self.env.ref('snaphomz_crm.activity_type_first_contact')
                       | self.env.ref('snaphomz_crm.activity_type_call_retry'))
        self.assertFalse(self.open_activities(self.lead).filtered(lambda a: a.activity_type_id in retry_types))

        queue = self.env['snaphomz.outbound.queue'].search([('partner_id', '=', self.lead.partner_id.id),
                                                             ('state', '=', 'pending')])
        self.assertTrue(queue.payload['consultationBooked'])
        self.assertEqual(queue.payload['buyerStage'], 'consultation_booked')

    def test_manual_stage_change_needs_evidence(self):
        self.qualify()
        with self.assertRaises(UserError):
            self.lead.with_user(self.rep_a).write({'stage_id': self.env.ref('snaphomz_crm.stage_bra_signed').id})
        with self.assertRaises(UserError):
            self.lead.with_user(self.rep_a).write({'stage_id': self.env.ref('snaphomz_crm.stage_consultation_booked').id})

    def test_bra_signature_marks_won_once(self):
        """Acceptance 3 and 12: replays create no duplicate signature milestone; counts agree."""
        self.qualify()
        self.event('bra_sent', 'bra-sent-1', bra={'agreement_id': 'AG-7'})
        self.assertEqual(self.lead.stage_id, self.env.ref('snaphomz_crm.stage_bra_sent'))
        self.event('bra_signed', 'bra-signed-1', bra={'agreement_id': 'AG-7', 'expires_at': '2027-04-19T00:00:00Z'})
        lead = self.lead
        self.assertEqual(lead.won_status, 'won')
        self.assertEqual(lead.stage_id, self.env.ref('snaphomz_crm.stage_bra_signed'))
        self.assertEqual(lead.bra_status, 'active')
        self.assertEqual(lead.bra_reference, 'AG-7')
        signed_messages = lead.message_ids.filtered(lambda m: 'AG-7 signed' in (m.body or ''))
        stage_rows = len(lead.stage_history_ids)

        self.assertEqual(self.event('bra_signed', 'bra-signed-1', bra={'agreement_id': 'AG-7'})['status'], 'duplicate')
        result = self.event('bra_signed', 'bra-signed-redelivered', bra={'agreement_id': 'AG-7'})
        self.assertEqual(result['result'], 'BRA signature already recorded')
        self.assertEqual(len(lead.message_ids.filtered(lambda m: 'AG-7 signed' in (m.body or ''))), len(signed_messages))
        self.assertEqual(len(lead.stage_history_ids), stage_rows)

        report = self.env['snaphomz.buyer.report'].search([('lead_id', '=', lead.id)])
        self.assertEqual((report.bra_sent_count, report.bra_signed_count, report.bra_active_count,
                          report.qualified_count, report.buyer_count), (1, 1, 1, 1, 1))

        with freeze_time(datetime(2027, 4, 20)):
            self.env['crm.lead']._cron_snaphomz_bra_expiry()
        self.assertEqual(lead.bra_status, 'expired')
        report.invalidate_recordset()
        self.assertEqual(report.bra_active_count, 0)

    def test_bra_signed_on_unqualified_lead_converts(self):
        self.event('bra_signed', 'bra-direct', bra={'agreement_id': 'AG-9'})
        self.assertEqual(self.lead.type, 'opportunity')
        self.assertEqual(self.lead.won_status, 'won')

    def test_milestone_for_unknown_buyer_needs_review(self):
        result = self.submit(self.payload(email='unknown@example.com', event_type='bra_signed',
                                          bra={'agreement_id': 'AG-1'}))
        self.assertEqual(result['state'], 'review')

    def test_bra_cancel_and_mismatch(self):
        self.event('bra_signed', 'sig', bra={'agreement_id': 'AG-5'})
        result = self.event('bra_cancelled', 'cancel-wrong', bra={'agreement_id': 'AG-OTHER'})
        self.assertEqual(result['state'], 'failed')
        self.event('bra_cancelled', 'cancel', bra={'agreement_id': 'AG-5'})
        self.assertEqual(self.lead.bra_status, 'cancelled')
        self.assertFalse(self.lead.bra_active)

    def test_stage_history_records_actor_and_origin(self):
        self.qualify()
        rows = self.lead.stage_history_ids
        self.assertEqual(set(rows.mapped('kind')), {'status', 'stage'})
        self.assertIn(self.rep_a, rows.mapped('actor_id'))
        first = rows.sorted('id')[0]
        self.assertEqual((first.new_status, first.origin), ('new', 'website'))

    def test_merge_keeps_identifiers_and_inquiries(self):
        other_partner = self.env['res.partner'].create({'name': 'Dup', 'email': 'dup@example.com'})
        dup = self.env['crm.lead'].create({
            'name': 'Duplicate', 'partner_id': other_partner.id, 'user_id': self.rep_a.id,
            'next_action': 'Call', 'next_action_at': STAFFED_NOW + timedelta(hours=1)})
        self.env['snaphomz.inquiry'].create({'lead_id': dup.id, 'provider': 'website', 'event_type': 'inquiry',
                                             'inquiry_at': STAFFED_NOW})
        merged = (self.lead | dup)._merge_opportunity(user_id=self.rep_a.id, auto_unlink=True)
        self.assertEqual(merged.inquiry_count, 2)
        self.assertTrue(merged.merged_acquisition_uuids)
