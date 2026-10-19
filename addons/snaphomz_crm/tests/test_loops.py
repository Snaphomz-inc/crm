import base64
import hashlib
import hmac
import json
import time
from datetime import timedelta

from freezegun import freeze_time

from odoo.tests import tagged

from ..models.snaphomz_loops import verify_loops_signature
from .common import STAFFED_NOW, SnaphomzCase

SECRET_KEY = b'snaphomz-test-signing-key-32bytes!'
SECRET = 'whsec_' + base64.b64encode(SECRET_KEY).decode()


def sign(body, webhook_id='msg_1', ts=None, key=SECRET_KEY):
    ts = str(ts or int(time.time()))
    digest = hmac.new(key, f"{webhook_id}.{ts}.".encode() + body, hashlib.sha256).digest()
    return {
        'webhook-id': webhook_id,
        'webhook-timestamp': ts,
        'webhook-signature': 'v1,' + base64.b64encode(digest).decode(),
    }


@tagged('post_install', '-at_install', 'snaphomz')
class TestLoopsSignature(SnaphomzCase):

    def test_valid_signature(self):
        body = b'{"eventName":"testing.testEvent"}'
        self.assertTrue(verify_loops_signature(body, sign(body), [SECRET]))

    def test_tampered_body(self):
        body = b'{"eventName":"testing.testEvent"}'
        self.assertFalse(verify_loops_signature(body + b' ', sign(body), [SECRET]))

    def test_old_timestamp_rejected(self):
        body = b'{}'
        self.assertFalse(verify_loops_signature(body, sign(body, ts=int(time.time()) - 600), [SECRET]))

    def test_secret_rotation(self):
        body = b'{}'
        headers = sign(body)
        other = 'whsec_' + base64.b64encode(b'another-secret-key').decode()
        headers['webhook-signature'] = 'v1,bm90LXRoaXMtb25l ' + headers['webhook-signature']
        self.assertTrue(verify_loops_signature(body, headers, [other, SECRET]))
        self.assertFalse(verify_loops_signature(body, headers, [other]))


@tagged('post_install', '-at_install', 'snaphomz')
@freeze_time(STAFFED_NOW)
class TestLoopsSync(SnaphomzCase):

    def setUp(self):
        super().setUp()
        self.env['ir.config_parameter'].sudo().set_param('snaphomz_crm.loops_signing_secret', SECRET)
        self.submit(self.payload(email='loops@example.com'))
        self.lead = self.lead_for('loops@example.com')
        self.partner = self.lead.partner_id
        self.Queue = self.env['snaphomz.outbound.queue'].with_user(self.integration)

    def webhook(self, event_name, webhook_id, event_time=None, **extra):
        payload = {
            'eventName': event_name,
            'eventTime': int((event_time or STAFFED_NOW).timestamp()) if event_time is not False else None,
            'webhookSchemaVersion': '1.0.0',
            'contactIdentity': {'id': 'loops-contact-1', 'email': 'LOOPS@example.com', 'userId': None},
        }
        payload.update(extra)
        body = json.dumps(payload).encode()
        with freeze_time(STAFFED_NOW):
            headers = sign(body, webhook_id=webhook_id, ts=int(STAFFED_NOW.timestamp()))
            return self.env['snaphomz.inbound.event'].with_user(self.integration).receive_loops_webhook(body, headers)

    def pending(self):
        return self.env['snaphomz.outbound.queue'].search([('partner_id', '=', self.partner.id), ('state', '=', 'pending')])

    def test_unsubscribe_and_duplicate(self):
        status, body = self.webhook('email.unsubscribed', 'msg_unsub')
        self.assertEqual((status, body['status']), (200, 'accepted'))
        self.assertEqual(self.partner.email_subscription_status, 'unsubscribed')
        self.assertEqual(self.partner.loops_contact_id, 'loops-contact-1')
        status, body = self.webhook('email.unsubscribed', 'msg_unsub')
        self.assertEqual(body['status'], 'duplicate')

    def test_invalid_signature_rejected(self):
        body = b'{"eventName":"email.unsubscribed"}'
        headers = sign(body, key=b'wrong')
        status, _body = self.env['snaphomz.inbound.event'].with_user(self.integration).receive_loops_webhook(body, headers)
        self.assertEqual(status, 401)
        self.assertEqual(self.partner.email_subscription_status, 'unknown')

    def test_delayed_webhook_does_not_override_newer_state(self):
        self.webhook('email.resubscribed', 'msg_new', event_time=STAFFED_NOW)
        self.webhook('email.unsubscribed', 'msg_old', event_time=STAFFED_NOW - timedelta(hours=2))
        self.assertEqual(self.partner.email_subscription_status, 'subscribed')

    def test_marketing_events_never_touch_sales_state(self):
        """Acceptance 7: automated activity never resets human follow-up clocks or requeues stages."""
        self.Queue.claim_batch()['items']  # drain the intake update
        before = (self.lead.attempt_count, self.lead.last_human_attempt_at, self.lead.last_buyer_response_at,
                  self.lead.buyer_status, self.lead.user_id, self.lead.next_action_at)
        for i, name in enumerate(['campaign.email.sent', 'email.delivered', 'email.opened', 'email.clicked',
                                  'email.hardBounced']):
            self.webhook(name, f'msg_{i}')
        after = (self.lead.attempt_count, self.lead.last_human_attempt_at, self.lead.last_buyer_response_at,
                 self.lead.buyer_status, self.lead.user_id, self.lead.next_action_at)
        self.assertEqual(before, after)
        self.assertEqual(self.partner.last_marketing_engagement_at, STAFFED_NOW)
        self.assertEqual(self.partner.last_email_open_at, STAFFED_NOW)
        self.assertEqual(self.partner.email_subscription_status, 'bounced')
        self.assertFalse(self.pending(), "marketing events do not requeue sales updates")

    def test_unknown_contact_is_ignored(self):
        payload = {'eventName': 'email.clicked', 'eventTime': int(STAFFED_NOW.timestamp()),
                   'contactIdentity': {'id': 'x', 'email': 'stranger@example.com'}}
        body = json.dumps(payload).encode()
        with freeze_time(STAFFED_NOW):
            status, result = self.env['snaphomz.inbound.event'].with_user(self.integration).receive_loops_webhook(
                body, sign(body, webhook_id='msg_stranger', ts=int(STAFFED_NOW.timestamp())))
        self.assertEqual(result['state'], 'ignored')
        self.assertFalse(self.lead_for('stranger@example.com'))

    def test_outbound_payload_and_coalescing(self):
        entry = self.pending()
        self.assertEqual(len(entry), 1)
        self.assertEqual(entry.payload, {
            'email': 'loops@example.com',
            'crmPersonId': self.partner.snaphomz_person_uuid,
            'buyerStage': 'new',
            'buyerReadiness': '',
            'salesOwnerName': 'Ari Rep',
            'consultationBooked': False,
            'braSigned': False,
            'salesSequenceEligible': True,
        })
        self.assertNotIn('subscribed', entry.payload, "stage updates never touch subscriptions")
        version = entry.version
        self.lead.with_user(self.manager).user_id = self.rep_b
        self.assertEqual(self.pending(), entry, "changes coalesce into the pending entry")
        self.assertEqual(entry.payload['salesOwnerName'], 'Bea Rep')
        self.assertGreater(entry.version, version)

    def test_claim_and_report(self):
        batch = self.Queue.claim_batch(limit=10)['items']
        self.assertEqual(len(batch), 1)
        item = batch[0]
        self.assertEqual(item['path'], '/api/v1/contacts/update')
        self.assertEqual(self.Queue.claim_batch(limit=10)['items'], [], "claimed entries are not handed out twice")

        result = self.Queue.report_result(item['queue_id'], False, status_code=503, error='unavailable')
        self.assertEqual(result['status'], 'retry')
        entry = self.env['snaphomz.outbound.queue'].browse(item['queue_id'])
        self.assertEqual(entry.state, 'pending')
        with freeze_time(STAFFED_NOW + timedelta(minutes=5)):
            item = self.Queue.claim_batch()['items'][0]
            self.Queue.report_result(item['queue_id'], True, status_code=200, loops_contact_id='lc_42')
        self.assertEqual(entry.state, 'done')
        self.assertEqual(self.partner.loops_contact_id, 'lc_42')
        self.assertEqual(self.partner.loops_synced_payload, entry.payload)

        # Unchanged state is not re-sent.
        self.lead.with_user(self.manager).write({'user_id': self.rep_a.id})
        self.assertFalse(self.pending())

    def test_permanent_failure_is_kept_for_review(self):
        item = self.Queue.claim_batch()['items'][0]
        self.Queue.report_result(item['queue_id'], False, status_code=400, error='bad property')
        entry = self.env['snaphomz.outbound.queue'].browse(item['queue_id'])
        self.assertEqual(entry.state, 'failed')
        entry.with_user(self.manager).action_retry()
        self.assertEqual(entry.state, 'pending')

    def test_stale_claims_released(self):
        item = self.Queue.claim_batch()['items'][0]
        with freeze_time(STAFFED_NOW + timedelta(minutes=20)):
            self.env['snaphomz.outbound.queue']._cron_release_stale_claims()
        self.assertEqual(self.env['snaphomz.outbound.queue'].browse(item['queue_id']).state, 'pending')

    def test_creation_policy(self):
        # No consent and not yet in Loops: no new contact is created.
        self.submit(self.payload(email='noconsent@example.com', phone='+12125550177', consent={}))
        partner = self.lead_for('noconsent@example.com').partner_id
        self.assertFalse(self.env['snaphomz.outbound.queue'].search([('partner_id', '=', partner.id)]))
        # Once Loops reports the contact exists, updates flow.
        partner.loops_contact_id = 'lc_known'
        self.lead_for('noconsent@example.com').with_user(self.manager).user_id = self.rep_b
        self.assertTrue(self.env['snaphomz.outbound.queue'].search([('partner_id', '=', partner.id)]))

    def test_do_not_contact_removes_sequence_eligibility(self):
        """Acceptance 8: suppression survives repeat intake and stage changes."""
        self.partner.loops_contact_id = 'lc_1'
        self.webhook('contact.unsubscribed', 'msg_u1')
        wizard = self.env['snaphomz.log.outcome'].with_user(self.rep_a).create({
            'lead_id': self.lead.id, 'outcome': 'do_not_contact', 'summary': 'Stop'})
        wizard.action_save()
        entry = self.pending()
        self.assertFalse(entry.payload['salesSequenceEligible'])
        self.assertEqual(entry.payload['buyerStage'], 'lost')
        self.submit(self.payload(email='loops@example.com'))
        self.assertTrue(self.partner.do_not_contact)
        self.assertEqual(self.partner.email_subscription_status, 'unsubscribed')
        self.assertFalse(self.lead.active)
