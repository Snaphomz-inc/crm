import base64

from freezegun import freeze_time

from odoo.exceptions import AccessError
from odoo.tests import tagged

from .common import STAFFED_NOW, SnaphomzCase


@tagged('post_install', '-at_install', 'snaphomz')
@freeze_time(STAFFED_NOW)
class TestPermissions(SnaphomzCase):
    """Acceptance 6: a salesperson cannot reach another salesperson's buyers."""

    def setUp(self):
        super().setUp()
        self.submit(self.payload(email='mine@example.com'))
        self.team.snaphomz_intake_user_id = self.rep_b
        self.submit(self.payload(email='theirs@example.com', phone='+12125550188'))
        self.team.snaphomz_intake_user_id = self.rep_a
        self.mine = self.lead_for('mine@example.com')
        self.theirs = self.lead_for('theirs@example.com')
        self.assertEqual(self.theirs.user_id, self.rep_b)
        self.attachment = self.env['ir.attachment'].create({
            'name': 'pre-approval.pdf', 'datas': base64.b64encode(b'%PDF-1.4'),
            'res_model': 'crm.lead', 'res_id': self.theirs.id})

    def test_search_and_direct_access(self):
        Lead = self.env['crm.lead'].with_user(self.rep_a)
        self.assertIn(self.mine, Lead.search([]))
        self.assertNotIn(self.theirs, Lead.search([]))
        with self.assertRaises(AccessError):
            Lead.browse(self.theirs.id).read(['name'])

    def test_unassigned_leads_hidden_from_salespeople(self):
        self.theirs.with_user(self.manager).user_id = False
        self.assertNotIn(self.theirs, self.env['crm.lead'].with_user(self.rep_a).search([]))
        self.assertIn(self.theirs, self.env['crm.lead'].with_user(self.manager).search([]))

    def test_export_respects_ownership(self):
        self.rep_a.group_ids += self.env.ref('base.group_allow_export')
        data = self.env['crm.lead'].with_user(self.rep_a).search([]).export_data(['email_from'])['datas']
        exported = {row[0] for row in data}
        self.assertIn('mine@example.com', exported)
        self.assertNotIn('theirs@example.com', exported)

    def test_linked_contacts(self):
        Partner = self.env['res.partner'].with_user(self.rep_a)
        self.assertIn(self.mine.partner_id, Partner.search([]))
        self.assertNotIn(self.theirs.partner_id, Partner.search([]))
        with self.assertRaises(AccessError):
            Partner.browse(self.theirs.partner_id.id).read(['email'])
        # Non-buyer contacts (colleagues, companies) remain visible.
        self.assertIn(self.rep_b.partner_id, Partner.search([]))

    def test_attachments_inquiries_and_history(self):
        with self.assertRaises(AccessError):
            self.attachment.with_user(self.rep_a).read(['datas'])
        Inquiry = self.env['snaphomz.inquiry'].with_user(self.rep_a)
        self.assertFalse(Inquiry.search([('lead_id', '=', self.theirs.id)]))
        self.assertTrue(Inquiry.search([('lead_id', '=', self.mine.id)]))
        History = self.env['snaphomz.stage.history'].with_user(self.rep_a)
        self.assertFalse(History.search([('lead_id', '=', self.theirs.id)]))
        Report = self.env['snaphomz.buyer.report'].with_user(self.rep_a)
        self.assertEqual(Report.search([]).lead_id, self.mine)

    def test_messages_and_activities(self):
        Message = self.env['mail.message'].with_user(self.rep_a)
        self.assertFalse(Message.search([('model', '=', 'crm.lead'), ('res_id', '=', self.theirs.id)]))
        Activity = self.env['mail.activity'].with_user(self.rep_a)
        self.assertFalse(Activity.search([('res_model', '=', 'crm.lead'), ('res_id', '=', self.theirs.id)]))

    def test_reassignment_cuts_previous_owner_off(self):
        self.mine.with_user(self.manager).user_id = self.rep_b
        self.assertNotIn(self.rep_a.partner_id, self.mine.message_partner_ids)
        with self.assertRaises(AccessError):
            self.env['crm.lead'].with_user(self.rep_a).browse(self.mine.id).read(['name'])
        with self.assertRaises(AccessError):
            self.env['res.partner'].with_user(self.rep_a).browse(self.mine.partner_id.id).read(['email'])
        self.mine.with_user(self.rep_b).message_post(body='Buyer shared pre-approval', subtype_xmlid='mail.mt_comment')
        new_message = self.mine.message_ids[0]
        self.assertFalse(self.env['mail.message'].with_user(self.rep_a).search([('id', '=', new_message.id)]))

    def test_only_managers_assign_buyers(self):
        """Nothing reaches a salesperson unless a manager assigns it."""
        with self.assertRaises(AccessError):
            self.mine.with_user(self.rep_a).write({'user_id': self.rep_b.id})
        with self.assertRaises(AccessError):
            self.env['crm.lead'].with_user(self.rep_a).create({
                'name': 'Walk-in buyer', 'next_action': 'Call', 'next_action_at': STAFFED_NOW})
        self.assertFalse(self.mine.with_user(self.rep_a).snaphomz_can_assign)
        # A manager's assignment is recorded in the tracked history.
        self.theirs.with_user(self.manager).with_context(mail_notrack=False).user_id = self.rep_a
        self.env.flush_all()
        self.env.cr.precommit.run()  # tracking values are written at commit time
        self.assertIn(self.theirs, self.env['crm.lead'].with_user(self.rep_a).search([]))
        tracking = self.theirs.message_ids.tracking_value_ids.filtered(
            lambda t: t.field_id.name == 'user_id' and t.new_value_integer == self.rep_a.id)
        self.assertEqual(tracking.mail_message_id.author_id, self.manager.partner_id)

    def test_salesperson_has_no_integration_access(self):
        with self.assertRaises(AccessError):
            self.env['snaphomz.inbound.event'].with_user(self.rep_a).search([])
        with self.assertRaises(AccessError):
            self.env['snaphomz.inbound.event'].with_user(self.rep_a).submit_intake(self.payload())
        with self.assertRaises(AccessError):
            self.env['ir.config_parameter'].with_user(self.rep_a).get_param('snaphomz_crm.loops_signing_secret')

    def test_manager_sees_everything(self):
        Lead = self.env['crm.lead'].with_user(self.manager)
        self.assertEqual(Lead.search([('id', 'in', (self.mine | self.theirs).ids)]), self.mine | self.theirs)
        self.assertTrue(self.env['res.partner'].with_user(self.manager).browse(self.theirs.partner_id.id).email)

    def test_integration_cannot_change_human_fields(self):
        with self.assertRaises(AccessError):
            self.mine.with_user(self.integration).write({'buyer_readiness': 'ready_now'})
