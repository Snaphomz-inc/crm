from freezegun import freeze_time

from odoo.tests import tagged

from .common import STAFFED_NOW, SnaphomzCase

REPLY = """Return-Path: <{sender}>
From: Jane Buyer <{sender}>
To: sales@snaphomz.com
Subject: Re: New homes in Austin this week
Message-ID: <{msgid}@mail.example.com>
In-Reply-To: <loops-campaign-123@loops.so>
Date: Mon, 19 Oct 2026 14:00:00 +0000
Content-Type: text/plain; charset="utf-8"

Yes, please call me tomorrow afternoon.
"""


@tagged('post_install', '-at_install', 'snaphomz')
@freeze_time(STAFFED_NOW)
class TestMailbox(SnaphomzCase):
    """Acceptance 9: replies reach the right buyer or a named review queue."""

    def setUp(self):
        super().setUp()
        self.submit(self.payload(email='reply@example.com'))
        self.lead = self.lead_for('reply@example.com')

    def receive(self, sender, msgid):
        return self.env['mail.thread'].sudo().message_process(
            'snaphomz.inbound.email', REPLY.format(sender=sender, msgid=msgid))

    def test_reply_is_moved_to_buyer(self):
        record_id = self.receive('reply@example.com', 'r1')
        inbound = self.env['snaphomz.inbound.email'].browse(record_id)
        self.assertEqual(inbound.state, 'matched')
        self.assertEqual(inbound.lead_id, self.lead)
        emails = self.lead.message_ids.filtered(lambda m: m.message_type == 'email')
        self.assertEqual(len(emails), 1)
        self.assertIn('call me tomorrow', emails.body)
        self.assertFalse(inbound.message_ids.filtered(lambda m: m.message_type == 'email'))
        self.assertEqual(self.lead.last_buyer_response_at, STAFFED_NOW)
        self.assertEqual(self.lead.attempt_count, 0, "a reply is not a contact attempt")
        self.assertIn('Reply to buyer email', self.open_activities(self.lead).mapped('summary'))

    def test_unknown_sender_goes_to_owned_queue(self):
        record_id = self.receive('someone-else@example.com', 'r2')
        inbound = self.env['snaphomz.inbound.email'].browse(record_id)
        self.assertEqual(inbound.state, 'unmatched')
        self.assertEqual(inbound.owner_id, self.manager)
        self.assertTrue(inbound.activity_ids)
        self.assertFalse(self.lead.message_ids.filtered(lambda m: m.message_type == 'email'))

        inbound.with_user(self.manager).write({'lead_id': self.lead.id})
        inbound.with_user(self.manager).action_attach_to_lead()
        self.assertEqual(inbound.state, 'attached')
        self.assertTrue(self.lead.message_ids.filtered(lambda m: m.message_type == 'email'))
