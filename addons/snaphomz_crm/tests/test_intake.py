from datetime import datetime, timedelta

from freezegun import freeze_time

from odoo.exceptions import UserError
from odoo.tests import tagged

from .common import STAFFED_NOW, SnaphomzCase


@tagged('post_install', '-at_install', 'snaphomz')
@freeze_time(STAFFED_NOW)
class TestIntake(SnaphomzCase):

    def test_meta_lead_creates_one_assigned_buyer_and_task(self):
        """Acceptance 1: one submission -> one assigned buyer, one first-contact task, identifiers kept."""
        payload = self.meta_payload()
        result = self.submit(payload)
        self.assertEqual(result['status'], 'accepted')
        self.assertEqual(result['state'], 'done')

        lead = self.lead_for('jane.buyer@example.com')
        self.assertEqual(len(lead), 1)
        self.assertEqual(lead.user_id, self.rep_a)
        self.assertEqual(lead.team_id, self.team)
        self.assertEqual(lead.type, 'lead')
        self.assertEqual(lead.buyer_status, 'new')
        self.assertEqual(lead.origin_provider, 'meta')
        self.assertEqual(lead.origin_meta_form_id, 'f1')
        self.assertEqual(lead.origin_meta_lead_id, payload['event_id'])
        self.assertEqual(lead.origin_campaign, 'Fall buyers')
        self.assertEqual(lead.source_id.name.lower(), 'facebook')
        self.assertEqual(lead.partner_id.phone, '+12125550101')
        self.assertEqual(lead.partner_id.tz, 'America/Chicago')
        self.assertTrue(lead.partner_id.snaphomz_person_uuid)
        self.assertTrue(lead.acquisition_uuid)
        self.assertEqual(result['acquisition_uuid'], lead.acquisition_uuid)
        self.assertEqual(lead.inquiry_count, 1)
        self.assertIn('0-3 months', ' '.join(lead.message_ids.mapped('body')))

        activities = self.open_activities(lead)
        self.assertEqual(len(activities), 1)
        self.assertEqual(activities.activity_type_id, self.env.ref('snaphomz_crm.activity_type_first_contact'))
        self.assertEqual(activities.user_id, self.rep_a)
        self.assertEqual(lead.next_action_at, STAFFED_NOW + timedelta(minutes=15))
        self.assertEqual(lead.sla_start_at, STAFFED_NOW)
        self.assertEqual(lead.next_action, 'First contact')
        keys = lead.partner_id.snaphomz_identity_key_ids
        self.assertEqual(set(keys.mapped('kind')), {'email', 'phone'})

    def test_replayed_event_is_ignored(self):
        """Acceptance 3: the same event delivered twice creates nothing new."""
        payload = self.meta_payload()
        self.submit(payload)
        lead = self.lead_for('jane.buyer@example.com')
        counts = (len(self.open_activities(lead)), lead.inquiry_count,
                  self.env['res.partner'].search_count([('email', '=', 'jane.buyer@example.com')]))

        again = self.submit(payload)
        self.assertEqual(again['status'], 'duplicate')
        lead.invalidate_recordset()
        self.assertEqual(self.lead_for('jane.buyer@example.com'), lead)
        self.assertEqual(counts, (len(self.open_activities(lead)), lead.inquiry_count,
                                  self.env['res.partner'].search_count([('email', '=', 'jane.buyer@example.com')])))

    def test_repeat_inquiry_website_then_meta(self):
        """Acceptance 2: one active acquisition; both inquiries visible; original source preserved."""
        self.submit(self.payload(provider='website'))
        lead = self.lead_for('jane.buyer@example.com')
        lead.with_user(self.manager).user_id = self.rep_b
        self.submit(self.meta_payload(email='Jane.Buyer@Example.com'))

        leads = self.lead_for('jane.buyer@example.com')
        self.assertEqual(leads, lead)
        self.assertEqual(lead.inquiry_count, 2)
        self.assertEqual(set(lead.inquiry_ids.mapped('provider')), {'website', 'meta'})
        self.assertEqual(lead.origin_provider, 'website')
        self.assertEqual(lead.origin_campaign, 'fall-buyers')
        self.assertEqual(lead.latest_inquiry_provider, 'meta')
        self.assertEqual(lead.user_id, self.rep_b, "owner is preserved on repeat inquiries")
        self.assertEqual(self.env['res.partner'].search_count([('email', '=ilike', 'jane.buyer@example.com')]), 1)

    def test_phone_only_lead(self):
        self.submit(self.payload(email=False, phone='212-555-0199'))
        partner = self.env['snaphomz.identity.key'].search([('kind', '=', 'phone'), ('value', '=', '+12125550199')]).partner_id
        self.assertTrue(partner)
        lead = partner.snaphomz_lead_ids
        self.assertEqual(len(lead), 1)
        self.assertEqual(lead.user_id, self.rep_a)
        self.assertFalse(self.env['snaphomz.outbound.queue'].search([('partner_id', '=', partner.id)]),
                         "phone-only buyers are never pushed to Loops")

    def test_phone_match_with_different_email_goes_to_review(self):
        self.submit(self.payload(email='first@example.com', phone='+12125550123'))
        result = self.submit(self.payload(email='second@example.com', phone='+12125550123'))
        self.assertEqual(result['state'], 'review')
        event = self.env['snaphomz.inbound.event'].browse(result['id'])
        self.assertEqual(event.review_reason, 'identity_conflict')
        self.assertFalse(self.lead_for('second@example.com'))

        # Manager decides it is a different person (shared household phone).
        wizard = self.env['snaphomz.resolve.event'].with_user(self.manager).create(
            {'event_id': event.id, 'resolution': 'new'})
        wizard.action_apply()
        self.assertEqual(event.state, 'done')
        second = self.lead_for('second@example.com')
        self.assertEqual(len(second), 1)
        self.assertNotEqual(second.partner_id, self.lead_for('first@example.com').partner_id)

    def test_conflicting_user_id_and_email(self):
        self.submit(self.payload(email='a@example.com', person={'snaphomz_user_id': 'U-1'}))
        self.submit(self.payload(email='b@example.com', phone='+12125550111'))
        result = self.submit(self.payload(email='b@example.com', phone=False, person={'snaphomz_user_id': 'U-1'}))
        self.assertEqual(result['state'], 'review')

    def test_snaphomz_user_id_matches_before_email(self):
        self.submit(self.payload(email='old@example.com', person={'snaphomz_user_id': 'U-9'}))
        self.submit(self.payload(email='new@example.com', phone=False, person={'snaphomz_user_id': 'U-9'}))
        lead = self.lead_for('old@example.com')
        self.assertEqual(lead.inquiry_count, 2)
        self.assertFalse(self.lead_for('new@example.com'))

    def test_newsletter_signup_never_creates_lead(self):
        result = self.submit(self.payload(event_type='newsletter_signup', email='news@example.com'))
        self.assertEqual(result['state'], 'ignored')
        self.assertFalse(self.lead_for('news@example.com'))

    def test_registration_follows_buyer_intent_rule(self):
        self.submit(self.payload(event_type='registration', email='reg1@example.com'))
        self.assertFalse(self.lead_for('reg1@example.com'))
        self.env['ir.config_parameter'].sudo().set_param('snaphomz_crm.registration_creates_lead', 'True')
        self.submit(self.payload(event_type='registration', email='reg2@example.com'))
        self.assertTrue(self.lead_for('reg2@example.com'))

    def test_unavailable_intake_goes_to_manager_queue(self):
        self.team.write({'snaphomz_intake_available': False, 'snaphomz_backup_available': False})
        self.submit(self.payload(email='queue@example.com'))
        lead = self.lead_for('queue@example.com')
        self.assertFalse(lead.user_id)
        self.assertEqual(self.open_activities(lead).user_id, self.manager)
        alert = self.env['mail.message'].search([('model', '=', 'crm.lead'), ('res_id', '=', lead.id),
                                                 ('subject', '=', 'New buyer waiting for assignment')])
        self.assertIn(self.manager.partner_id, alert.partner_ids, "managers are alerted on the buyer record")

        # Assigning later moves the first-contact task to the new owner.
        lead.with_user(self.manager).user_id = self.rep_b
        self.assertEqual(self.open_activities(lead).user_id, self.rep_b)

    def test_lost_buyer_returning_is_reopened(self):
        self.submit(self.payload(email='back@example.com'))
        lead = self.lead_for('back@example.com')
        lead.with_user(self.rep_a).action_set_lost(lost_reason_id=self.env.ref('snaphomz_crm.lost_reason_not_buying').id)
        self.assertFalse(lead.active)
        self.assertEqual(lead.buyer_status, 'lost')

        self.submit(self.payload(email='back@example.com'))
        self.assertTrue(lead.active)
        self.assertEqual(lead.buyer_status, 'new')
        self.assertEqual(lead.user_id, self.rep_a)
        self.assertEqual(lead.inquiry_count, 2)
        self.assertTrue(lead.next_action_at)

    def test_do_not_contact_buyer_returning_is_flagged_not_reopened(self):
        self.submit(self.payload(email='dnc@example.com'))
        lead = self.lead_for('dnc@example.com')
        wizard = self.env['snaphomz.log.outcome'].with_user(self.rep_a).create({
            'lead_id': lead.id, 'outcome': 'do_not_contact', 'summary': 'Asked us to stop calling'})
        wizard.action_save()
        self.assertTrue(lead.partner_id.do_not_contact)

        result = self.submit(self.payload(email='dnc@example.com'))
        self.assertEqual(result['state'], 'done')
        self.assertFalse(lead.active)
        self.assertTrue(lead.snaphomz_needs_review)
        self.assertEqual(lead.inquiry_count, 2)
        self.assertTrue(lead.partner_id.do_not_contact, "suppression is preserved on repeat intake")

    def test_after_hours_inquiry_due_at_next_opening(self):
        # Saturday 24 Oct 2026 15:00 UTC -> Monday 26 Oct 09:00 EDT = 13:00 UTC.
        with freeze_time(datetime(2026, 10, 24, 15, 0)):
            self.submit(self.payload(email='weekend@example.com', event_time='2026-10-24T15:00:00Z'))
        lead = self.lead_for('weekend@example.com')
        self.assertEqual(lead.sla_start_at, datetime(2026, 10, 26, 13, 0))
        self.assertEqual(lead.next_action_at, datetime(2026, 10, 26, 13, 15))
        self.assertEqual(lead.sla_owner_alert_at, datetime(2026, 10, 26, 13, 15))
        self.assertEqual(lead.sla_manager_alert_at, datetime(2026, 10, 26, 13, 30))

    def test_invalid_payloads(self):
        with self.assertRaises(UserError):
            self.submit({'provider': 'website', 'event_type': 'inquiry'})
        with self.assertRaises(UserError):
            self.submit({'provider': 'mystery', 'event_type': 'inquiry', 'event_id': 'x'})
        result = self.submit({'provider': 'website', 'event_type': 'inquiry', 'event_id': 'no-contact', 'person': {}})
        self.assertEqual(result['state'], 'failed')

    def test_preview_does_not_write(self):
        before = self.env['res.partner'].search_count([])
        preview = self.Event.preview_intake(self.payload(email='preview@example.com'))
        self.assertEqual(preview['action'], 'create')
        self.assertEqual(self.env['res.partner'].search_count([]), before)

    def test_missing_events_reconciliation(self):
        payload = self.meta_payload()
        self.submit(payload)
        missing = self.Event.find_missing_events('meta', [payload['event_id'], 'meta-not-seen'])
        self.assertEqual(missing, {'missing': ['meta-not-seen']})

    def test_integration_cannot_create_leads_directly(self):
        from odoo.exceptions import AccessError
        with self.assertRaises(AccessError):
            self.env['crm.lead'].with_user(self.integration).create({'name': 'Sneaky'})
