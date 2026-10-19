import base64
import hashlib
import json
import re
import time
from datetime import datetime, timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from lxml import etree

from odoo.exceptions import AccessDenied, ValidationError
from odoo.tests import HttpCase, TransactionCase, new_test_user, tagged

TENANT = '11111111-2222-3333-4444-555555555555'
CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
ISSUER = f'https://login.microsoftonline.com/{TENANT}/v2.0'
POST = 'odoo.addons.snaphomz_crm.models.res_users_sso.requests.post'


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def id_token(**claims):
    now = int(time.time())
    payload = {
        'aud': CLIENT, 'iss': ISSUER, 'tid': TENANT, 'oid': 'oid-jane', 'nonce': 'n0nce',
        'preferred_username': 'jane@snaphomz.com', 'email': 'jane@snaphomz.com', 'name': 'Jane Rep',
        'iat': now, 'nbf': now, 'exp': now + 3600,
    }
    payload.update(claims)
    payload = {k: v for k, v in payload.items() if v is not None}
    return '.'.join([b64url(b'{"alg":"RS256","typ":"JWT"}'), b64url(json.dumps(payload).encode()), 'signature'])


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._body = body

    def json(self):
        return self._body


def configure(env, enforce=False):
    ICP = env['ir.config_parameter'].sudo()
    for key, value in {
        'entra_enabled': 'True', 'entra_tenant_id': TENANT, 'entra_client_id': CLIENT,
        'entra_client_secret': 'test-secret', 'entra_allowed_domains': 'snaphomz.com',
        'sso_enforce': 'True' if enforce else 'False', 'sso_password_logins': 'admin',
    }.items():
        ICP.set_param(f'snaphomz_crm.{key}', value)


@tagged('post_install', '-at_install', 'snaphomz')
class TestBranding(TransactionCase):

    def test_company_branding(self):
        company = self.env.ref('base.main_company')
        self.assertEqual(company.name, 'Snaphomz')
        self.assertFalse(company.uses_default_logo)
        self.assertEqual((company.primary_color, company.secondary_color), ('#171717', '#d4f776'))
        self.assertEqual(company.email_secondary_color, '#171717')
        self.assertEqual(self.env['ir.config_parameter'].sudo().get_param('web.web_app_name'), 'Snaphomz CRM')
        self.assertEqual(self.env.ref('base.partner_root').name, 'Snaphomz Bot')

    def test_branding_does_not_overwrite_customisation(self):
        from odoo.addons.snaphomz_crm.hooks import apply_branding
        company = self.env.ref('base.main_company')
        company.name = 'Snaphomz Realty LLC'
        apply_branding(self.env)
        self.assertEqual(company.name, 'Snaphomz Realty LLC')

    def test_no_odoo_promotion_in_emails(self):
        for xmlid in ('mail.mail_notification_layout', 'mail.mail_notification_light'):
            arch = etree.tostring(self.env.ref(xmlid)._get_combined_arch()).decode()
            self.assertNotIn('odoo.com', arch, xmlid)
            self.assertIn('/mail/unfollow', arch, xmlid)


@tagged('post_install', '-at_install', 'snaphomz')
class TestEntraRules(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        configure(cls.env)
        cls.Users = cls.env['res.users'].sudo()
        cls.jane = new_test_user(cls.env, 'Jane@Snaphomz.com', groups='sales_team.group_sale_salesman',
                                 email='jane@snaphomz.com', password='Jane-password-123')

    def claims(self, **kw):
        token = id_token(**kw)
        return json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '=='))

    def assertDenied(self, code, func, *args):
        with self.assertRaises(AccessDenied) as caught:
            func(*args)
        self.assertEqual(getattr(caught.exception, 'code', None), code)

    def test_valid_member(self):
        identity = self.Users._snaphomz_entra_validate_claims(self.claims(), 'n0nce')
        self.assertEqual(identity['oid'], 'oid-jane')
        self.assertIn('jane@snaphomz.com', identity['emails'])

    def test_rejects_other_tenant_audience_nonce_expiry(self):
        validate = self.Users._snaphomz_entra_validate_claims
        self.assertDenied('failed', validate, self.claims(aud='some-other-app'), 'n0nce')
        self.assertDenied('tenant', validate, self.claims(tid='99999999-2222-3333-4444-555555555555'), 'n0nce')
        self.assertDenied('tenant', validate, self.claims(iss='https://login.microsoftonline.com/common/v2.0'), 'n0nce')
        self.assertDenied('state', validate, self.claims(), 'replayed-nonce')
        self.assertDenied('state', validate, self.claims(exp=int(time.time()) - 3600), 'n0nce')

    def test_rejects_guests_and_other_domains(self):
        validate = self.Users._snaphomz_entra_validate_claims
        self.assertDenied('guest', validate, self.claims(idp='https://sts.windows.net/other-tenant/'), 'n0nce')
        self.assertDenied('guest', validate, self.claims(acct=1), 'n0nce')
        self.assertDenied('domain', validate, self.claims(email='jane@gmail.com', preferred_username='jane@gmail.com'), 'n0nce')
        self.assertDenied('domain', validate, self.claims(email=None, preferred_username='jane@snaphomz.onmicrosoft.com'), 'n0nce')

    def test_resolves_existing_users_only(self):
        identity = {'oid': 'oid-jane', 'emails': {'jane@snaphomz.com'}}
        user = self.Users._snaphomz_entra_resolve_user(identity)
        self.assertEqual(user, self.jane)
        self.assertEqual(self.jane.snaphomz_entra_oid, 'oid-jane')
        # Linked by object ID afterwards, even if the email changes.
        self.assertEqual(self.Users._snaphomz_entra_resolve_user({'oid': 'oid-jane', 'emails': {'j.rep@snaphomz.com'}}), self.jane)
        self.assertDenied('mismatch', self.Users._snaphomz_entra_resolve_user,
                          {'oid': 'another-oid', 'emails': {'jane@snaphomz.com'}})
        self.assertDenied('nouser', self.Users._snaphomz_entra_resolve_user,
                          {'oid': 'oid-new', 'emails': {'newhire@snaphomz.com'}})
        self.jane.active = False
        self.assertDenied('inactive', self.Users._snaphomz_entra_resolve_user, identity)

    def test_integration_and_portal_users_cannot_sign_in(self):
        integration = self.env.ref('snaphomz_crm.user_snaphomz_integration')
        integration.login = 'crm-integration@snaphomz.com'
        self.assertDenied('nouser', self.Users._snaphomz_entra_resolve_user,
                          {'oid': 'oid-int', 'emails': {'crm-integration@snaphomz.com'}})
        new_test_user(self.env, 'buyer@snaphomz.com', groups='base.group_portal', email='buyer@snaphomz.com')
        self.assertDenied('nouser', self.Users._snaphomz_entra_resolve_user,
                          {'oid': 'oid-portal', 'emails': {'buyer@snaphomz.com'}})

    def test_one_time_login_token(self):
        token = self.jane._snaphomz_entra_issue_login_token()
        credential = {'login': self.jane.login, 'token': token, 'type': 'snaphomz_entra'}
        info = self.Users.authenticate(credential, {'interactive': True})
        self.assertEqual((info['uid'], info['mfa']), (self.jane.id, 'skip'))
        with self.assertRaises(AccessDenied):
            self.Users.authenticate(credential, {'interactive': True})
        token = self.jane._snaphomz_entra_issue_login_token()
        self.jane.sudo().snaphomz_entra_login_expiry = datetime.now() - timedelta(seconds=1)
        with self.assertRaises(AccessDenied):
            self.Users.authenticate({'login': self.jane.login, 'token': token, 'type': 'snaphomz_entra'},
                                    {'interactive': True})
        with self.assertRaises(AccessDenied):
            self.Users.authenticate({'login': self.jane.login, 'type': 'snaphomz_entra'}, {'interactive': True})

    def test_enforcement_blocks_passwords_and_passkeys(self):
        password = {'login': self.jane.login, 'password': 'Jane-password-123', 'type': 'password'}
        self.assertEqual(self.Users.authenticate(password, {'interactive': True})['uid'], self.jane.id)
        configure(self.env, enforce=True)
        with self.assertRaises(AccessDenied):
            self.Users.authenticate(password, {'interactive': True})
        with self.assertRaises(AccessDenied):
            # Passkeys (and any other sign-in method) are refused too.
            self.jane.with_user(self.jane).sudo()._check_credentials(
                {'login': self.jane.login, 'type': 'webauthn', 'webauthn_response': '{}'}, {'interactive': True})
        # Break-glass admin keeps password access; scripts keep API keys.
        admin = self.env.ref('base.user_admin')
        admin.password = 'Admin-password-123'
        self.assertEqual(self.Users.authenticate({'login': admin.login, 'password': 'Admin-password-123',
                                                  'type': 'password'}, {'interactive': True})['uid'], admin.id)
        key = self.env['res.users.apikeys'].with_user(self.jane).sudo()._generate(None, 'script', datetime.now() + timedelta(days=1))
        info = self.Users.authenticate({'login': self.jane.login, 'password': key, 'type': 'password'},
                                       {'interactive': False})
        self.assertEqual((info['uid'], info['auth_method']), (self.jane.id, 'apikey'))

    def test_no_password_invitation_when_enforced(self):
        configure(self.env, enforce=True)
        before = self.env['mail.mail'].search_count([])
        self.env['res.users'].create({'name': 'New Rep', 'login': 'newrep@snaphomz.com', 'email': 'newrep@snaphomz.com'})
        self.assertEqual(self.env['mail.mail'].search_count([]), before)

    def test_settings_validation(self):
        with self.assertRaises(ValidationError):
            self.env['res.config.settings'].create({
                'snaphomz_entra_enabled': True, 'snaphomz_entra_tenant_id': 'common',
                'snaphomz_entra_client_id': CLIENT}).execute()
        with self.assertRaises(ValidationError):
            self.env['res.config.settings'].create({
                'snaphomz_entra_enabled': True, 'snaphomz_entra_tenant_id': TENANT, 'snaphomz_entra_client_id': CLIENT,
                'snaphomz_entra_client_secret': 'x', 'snaphomz_sso_enforce': True,
                'snaphomz_sso_password_logins': ' '}).execute()


@tagged('post_install', '-at_install', 'snaphomz')
class TestEntraFlow(HttpCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        configure(cls.env)
        cls.jane = new_test_user(cls.env, 'jane@snaphomz.com', groups='sales_team.group_sale_salesman',
                                 email='jane@snaphomz.com')

    def setUp(self):
        super().setUp()
        # Anonymous browser session bound to the test database (a database
        # header would make requests stateless and drop the sign-in state).
        self.authenticate(None, None)

    def get(self, path):
        return self.url_open(path, allow_redirects=False)

    def start(self):
        res = self.get('/snaphomz/auth/entra?redirect=/odoo/crm')
        self.assertEqual(res.status_code, 303)
        location = urlparse(res.headers['Location'])
        self.assertEqual(f'{location.scheme}://{location.netloc}{location.path}',
                         f'https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/authorize')
        return {k: v[0] for k, v in parse_qs(location.query).items()}

    def test_authorization_request_uses_pkce(self):
        query = self.start()
        self.assertEqual(query['client_id'], CLIENT)
        self.assertEqual(query['response_type'], 'code')
        self.assertEqual(query['code_challenge_method'], 'S256')
        self.assertTrue(query['redirect_uri'].endswith('/snaphomz/auth/entra/callback'))
        self.assertTrue(query['state'] and query['nonce'])

    def test_full_sign_in(self):
        query = self.start()
        token = id_token(nonce=query['nonce'])
        with patch(POST, return_value=FakeResponse(200, {'id_token': token})) as post:
            res = self.get(f"/snaphomz/auth/entra/callback?code=auth-code&state={query['state']}")
        self.assertEqual(res.status_code, 303)
        self.assertTrue(res.headers['Location'].endswith('/app/crm'), res.headers['Location'])
        sent = post.call_args.kwargs['data']
        self.assertEqual(sent['code'], 'auth-code')
        self.assertEqual(b64url(hashlib.sha256(sent['code_verifier'].encode()).digest()), query['code_challenge'])
        self.assertEqual(self.jane.snaphomz_entra_oid, 'oid-jane')
        self.assertEqual(self.get('/odoo').status_code, 200, "session is signed in")

    def test_state_mismatch_and_refused_accounts(self):
        query = self.start()
        res = self.get('/snaphomz/auth/entra/callback?code=x&state=forged')
        self.assertIn('entra_error=state', res.headers['Location'])

        query = self.start()
        token = id_token(nonce=query['nonce'], email='eve@gmail.com', preferred_username='eve@gmail.com')
        with patch(POST, return_value=FakeResponse(200, {'id_token': token})):
            res = self.get(f"/snaphomz/auth/entra/callback?code=x&state={query['state']}")
        self.assertIn('entra_error=domain', res.headers['Location'])
        self.assertNotEqual(self.get('/odoo').status_code, 200)

        query = self.start()
        with patch(POST, return_value=FakeResponse(400, {'error': 'invalid_grant'})):
            res = self.get(f"/snaphomz/auth/entra/callback?code=x&state={query['state']}")
        self.assertIn('entra_error=failed', res.headers['Location'])

    def test_login_page(self):
        page = self.get('/web/login').text
        self.assertIn('<title>Snaphomz CRM</title>', page)
        self.assertIn('/snaphomz_crm/static/src/img/favicon.ico', page)
        self.assertIn('Sign in with Microsoft', page)
        self.assertNotIn('Powered by', page)
        self.assertIn('o_snaphomz_login_product">CRM</span>', page, "CRM sits next to the logo")
        self.assertNotIn('Buyer CRM', page)
        self.assertNotIn('o_snaphomz_password_hidden', page)

        configure(self.env, enforce=True)
        self.assertIn('o_snaphomz_password_hidden', self.get('/web/login').text)
        self.assertNotIn('o_snaphomz_password_hidden', self.get('/web/login?local=1').text)
        self.assertIn('Only @snaphomz.com', self.get('/web/login?entra_error=domain').text)


@tagged('post_install', '-at_install', 'snaphomz')
class TestAppUrlsAndAdmin(HttpCase):

    def session_info(self, path='/app'):
        page = self.url_open(path).text
        match = re.search(r'odoo.__session_info__ = (\{.*?\});', page, re.S)
        self.assertTrue(match, "web client page with session info")
        return json.loads(match.group(1))

    def test_web_client_lives_under_app(self):
        self.authenticate(None, None)  # anonymous browser session on the test database
        res = self.url_open('/app/buyers', allow_redirects=False)
        self.assertEqual(res.status_code, 303)
        self.assertIn('redirect=/app/buyers', res.headers['Location'].replace('%2F', '/'))

        self.authenticate('admin', 'admin')
        res = self.url_open('/', allow_redirects=False)
        self.assertTrue(res.headers['Location'].endswith('/app'), res.headers['Location'])
        for path in ('/app', '/app/my-new-leads', '/app/unassigned', '/odoo'):
            self.assertEqual(self.url_open(path, allow_redirects=False).status_code, 200, path)

    def test_sign_in_lands_on_app(self):
        self.authenticate(None, None)
        page = self.url_open('/web/login').text
        csrf = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
        res = self.url_open('/web/login', data={'login': 'admin', 'password': 'admin', 'csrf_token': csrf},
                            allow_redirects=False)
        self.assertEqual(res.status_code, 303)
        self.assertTrue(res.headers['Location'].endswith('/app'), res.headers['Location'])

    def test_landing_page_by_role(self):
        rep = new_test_user(self.env, 'landing_rep', groups='sales_team.group_sale_salesman', password='landing-rep-1')
        boss = new_test_user(self.env, 'landing_boss', groups='sales_team.group_sale_salesman_all_leads',
                             password='landing-boss-1')
        expected = {
            ('landing_rep', 'landing-rep-1'): 'snaphomz_crm.action_my_new_leads',
            ('landing_boss', 'landing-boss-1'): 'snaphomz_crm.action_unassigned_intake',
            ('admin', 'admin'): 'snaphomz_crm.action_all_active_buyers',
        }
        for (login, password), xmlid in expected.items():
            self.authenticate(login, password)
            self.assertEqual(self.session_info()['home_action_id'], self.env.ref(xmlid).id, login)
        # A personal Home Action still wins.
        rep.action_id = self.env.ref('snaphomz_crm.action_my_followups_today').id
        self.authenticate('landing_rep', 'landing-rep-1')
        self.assertEqual(self.session_info()['home_action_id'], self.env.ref('snaphomz_crm.action_my_followups_today').id)
        self.assertEqual(self.env.ref('snaphomz_crm.action_my_new_leads').path, 'my-new-leads')

    def test_admin_has_every_internal_permission(self):
        admin = self.env.ref('base.user_admin')
        integration = self.env.ref('snaphomz_crm.group_snaphomz_integration')
        external = self.env.ref('base.group_portal') | self.env.ref('base.group_public')
        internal = self.env['res.groups'].search([('share', '=', False)]).filtered(
            lambda g: not (g.all_implied_ids & external)) - integration
        self.assertFalse(internal - admin.all_group_ids, "admin holds every internal group")
        self.assertFalse(admin.all_group_ids & external)
        self.assertNotIn(integration, admin.all_group_ids)
        self.assertTrue(admin.has_group('base.group_system'))
        self.assertTrue(admin.has_group('sales_team.group_sale_manager'))
        admin.tour_enabled = True
        self.env['res.users']._snaphomz_grant_admin_full_access()
        self.assertFalse(admin.tour_enabled, "onboarding tours stay off for admin")
        # Groups that appear later are granted on the next upgrade.
        extra = self.env['res.groups'].create({'name': 'Later module group'})
        self.env['res.users']._snaphomz_grant_admin_full_access()
        self.assertIn(extra, admin.all_group_ids)
