import json
from datetime import datetime, timedelta

from odoo.tests import HttpCase, get_db_name, new_test_user, tagged

from .test_loops import SECRET, sign


@tagged('post_install', '-at_install', 'snaphomz')
class TestApi(HttpCase):
    """External contract: JSON-2 with the integration API key, and the Loops route."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        team = cls.env.ref('snaphomz_crm.team_buyer_acquisition')
        cls.rep = new_test_user(cls.env, 'snz_api_rep', groups='sales_team.group_sale_salesman,base.group_partner_manager')
        team.write({'snaphomz_intake_user_id': cls.rep.id})
        integration = cls.env.ref('snaphomz_crm.user_snaphomz_integration')
        cls.integration_key = cls.env['res.users.apikeys'].with_user(integration).sudo()._generate(
            None, 'test', datetime.now() + timedelta(days=1))
        cls.rep_key = cls.env['res.users.apikeys'].with_user(cls.rep).sudo()._generate(
            None, 'test', datetime.now() + timedelta(days=1))
        cls.env['ir.config_parameter'].sudo().set_param('snaphomz_crm.loops_signing_secret', SECRET)

    def call(self, model, method, key, **kwargs):
        return self.url_open(
            f'/json/2/{model}/{method}', data=json.dumps(kwargs),
            headers={'Content-Type': 'application/json', 'Authorization': f'bearer {key}',
                     'X-Odoo-Database': get_db_name()})

    def test_submit_intake_over_json2(self):
        payload = {
            'provider': 'website', 'event_type': 'inquiry', 'event_id': 'web-api-1',
            'person': {'name': 'Api Buyer', 'email': 'api@example.com'},
        }
        res = self.call('snaphomz.inbound.event', 'submit_intake', self.integration_key, payload=payload)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()['status'], 'accepted')
        res = self.call('snaphomz.inbound.event', 'submit_intake', self.integration_key, payload=payload)
        self.assertEqual(res.json()['status'], 'duplicate')

    def test_salesperson_key_cannot_submit(self):
        res = self.call('snaphomz.inbound.event', 'submit_intake', self.rep_key,
                        payload={'provider': 'website', 'event_type': 'inquiry', 'event_id': 'x'})
        self.assertNotEqual(res.status_code, 200)

    def test_api_write_without_next_action_fails(self):
        """Acceptance 5 (API path)."""
        self.call('snaphomz.inbound.event', 'submit_intake', self.integration_key, payload={
            'provider': 'website', 'event_type': 'inquiry', 'event_id': 'web-api-2',
            'person': {'name': 'Api Two', 'email': 'api2@example.com'}})
        lead = self.env['crm.lead'].search([('email_normalized', '=', 'api2@example.com')])
        res = self.call('crm.lead', 'write', self.rep_key, ids=lead.ids, vals={'next_action_at': False})
        self.assertNotEqual(res.status_code, 200)
        self.assertIn('needs a dated next action', res.text)

    def test_loops_route(self):
        body = json.dumps({'eventName': 'testing.testEvent', 'eventTime': int(datetime.now().timestamp())}).encode()
        res = self.url_open('/snaphomz/webhooks/loops', data=body,
                            headers={'Content-Type': 'application/json', 'X-Odoo-Database': get_db_name(),
                                     **sign(body, webhook_id='msg_route')})
        self.assertEqual(res.status_code, 200, res.text)
        bad = self.url_open('/snaphomz/webhooks/loops', data=body,
                            headers={'Content-Type': 'application/json', 'X-Odoo-Database': get_db_name(),
                                     **sign(body, webhook_id='msg_bad', key=b'nope')})
        self.assertEqual(bad.status_code, 401)
