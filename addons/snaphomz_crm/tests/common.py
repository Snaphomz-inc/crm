import uuid
from datetime import datetime

from odoo.tests import TransactionCase, new_test_user

# Monday 19 October 2026, 10:00 in New York (EDT, UTC-4): inside staffed hours.
STAFFED_NOW = datetime(2026, 10, 19, 14, 0, 0)


class SnaphomzCase(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.env = cls.env(context=dict(cls.env.context, mail_notrack=True, no_reset_password=True))
        cls.team = cls.env.ref('snaphomz_crm.team_buyer_acquisition')
        cls.manager = new_test_user(
            cls.env, 'snz_manager', groups='sales_team.group_sale_salesman_all_leads,base.group_partner_manager',
            name='Mia Manager', tz='America/New_York')
        cls.rep_a = new_test_user(
            cls.env, 'snz_rep_a', groups='sales_team.group_sale_salesman,base.group_partner_manager',
            name='Ari Rep', tz='America/New_York')
        cls.rep_b = new_test_user(
            cls.env, 'snz_rep_b', groups='sales_team.group_sale_salesman,base.group_partner_manager',
            name='Bea Rep', tz='America/New_York')
        cls.team.write({
            'user_id': cls.manager.id,
            'snaphomz_intake_user_id': cls.rep_a.id,
            'snaphomz_backup_user_id': cls.rep_b.id,
        })
        cls.integration = cls.env.ref('snaphomz_crm.user_snaphomz_integration')
        cls.Event = cls.env['snaphomz.inbound.event'].with_user(cls.integration)
        cls.env['ir.config_parameter'].sudo().set_param('snaphomz_crm.loops_contact_creation', 'consent')

    def payload(self, provider='website', event_type='inquiry', email='jane.buyer@example.com',
                phone='+1 (212) 555-0101', event_id=None, **extra):
        person = {
            'first_name': 'Jane', 'last_name': 'Buyer',
            'email': email, 'phone': phone, 'timezone': 'America/Chicago',
        }
        person.update(extra.pop('person', {}))
        payload = {
            'provider': provider,
            'event_type': event_type,
            'event_id': event_id or f"{provider}-{uuid.uuid4()}",
            'event_time': '2026-10-19T13:55:00Z',
            'person': person,
            'inquiry': {'property_ref': 'MLS-123', 'message': 'Is this still available?'},
            'attribution': {'source': 'google', 'medium': 'cpc', 'campaign': 'fall-buyers',
                            'landing_page': 'https://snaphomz.com/homes/123'},
            'consent': {'marketing_email': True, 'source': 'website form', 'captured_at': '2026-10-19T13:55:00Z'},
        }
        payload.update(extra)
        return payload

    def meta_payload(self, **kw):
        payload = self.payload(provider='meta', event_type='lead_form', **kw)
        payload['attribution'] = {
            'source': 'facebook', 'medium': 'paid_social', 'campaign': 'Fall buyers',
            'meta': {'page_id': 'p1', 'form_id': 'f1', 'campaign_id': 'c1', 'ad_id': 'a1', 'lead_id': payload['event_id']},
        }
        payload['answers'] = {'when_are_you_planning_to_buy?': '0-3 months'}
        return payload

    def submit(self, payload):
        return self.Event.submit_intake(payload)

    def lead_for(self, email):
        return self.env['crm.lead'].with_context(active_test=False).search([('email_normalized', '=', email)])

    def open_activities(self, lead):
        return self.env['mail.activity'].search([('res_model', '=', 'crm.lead'), ('res_id', '=', lead.id)])
