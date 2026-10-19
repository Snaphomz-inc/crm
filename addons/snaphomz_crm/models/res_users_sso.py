"""Microsoft Entra ID (Azure AD) sign-in limited to Snaphomz accounts.

OpenID Connect authorization-code flow with PKCE against the Snaphomz tenant
only. The ID token is received directly from Microsoft's token endpoint over
TLS (so its issuer is authenticated by TLS, as OIDC Core 3.1.3.7 allows), then
checked for tenant, audience, nonce, expiry, guest status and email domain.
Only users who already exist in Odoo can sign in: nobody is created here.
"""
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from datetime import timedelta
from urllib.parse import urlencode

import requests

from odoo import _, api, fields, models
from odoo.exceptions import AccessDenied, ValidationError

_logger = logging.getLogger(__name__)

AUTHORITY = "https://login.microsoftonline.com"
SCOPE = "openid profile email"
GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
CLOCK_SKEW = 300
LOGIN_TOKEN_TTL = timedelta(minutes=2)
PARAM = 'snaphomz_crm.%s'

# Error codes shown on the login page (never echo Microsoft's raw messages).
SSO_ERRORS = {
    'disabled': "Microsoft sign-in is not configured yet. Contact your administrator.",
    'state': "Your sign-in session expired. Please try again.",
    'cancelled': "Microsoft sign-in was cancelled.",
    'failed': "Microsoft sign-in failed. Please try again.",
    'tenant': "Only Snaphomz Microsoft accounts can sign in.",
    'guest': "Guest accounts cannot sign in. Use your Snaphomz Microsoft account.",
    'domain': "Only @snaphomz.com Microsoft accounts can sign in.",
    'nouser': "Your Microsoft account has no access to the CRM yet. Ask your manager to add you.",
    'mismatch': "This CRM user is linked to a different Microsoft account. Contact your administrator.",
    'inactive': "Your CRM access has been deactivated.",
    'password': "Sign in with your Snaphomz Microsoft account.",
}


class SsoDenied(AccessDenied):
    """AccessDenied carrying a login-page error code."""

    def __init__(self, code):
        super().__init__(_(SSO_ERRORS.get(code, SSO_ERRORS['failed'])))
        self.code = code


def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _jwt_claims(token):
    try:
        payload = token.split('.')[1]
        payload += '=' * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except (AttributeError, IndexError, ValueError) as exc:
        raise SsoDenied('failed') from exc


class ResUsersSso(models.Model):
    _inherit = 'res.users'

    snaphomz_entra_oid = fields.Char(
        'Microsoft account ID', copy=False, index='btree_not_null', groups='base.group_system',
        help="Entra ID object ID linked on first Microsoft sign-in. Clear it to re-link the user.")
    snaphomz_entra_login_hash = fields.Char(copy=False, groups=fields.NO_ACCESS)
    snaphomz_entra_login_expiry = fields.Datetime(copy=False, groups=fields.NO_ACCESS)

    _snaphomz_entra_oid_uniq = models.UniqueIndex(
        '(snaphomz_entra_oid) WHERE snaphomz_entra_oid IS NOT NULL',
        'This Microsoft account is already linked to another user.')

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    @api.model
    def _snaphomz_entra_config(self):
        ICP = self.env['ir.config_parameter'].sudo()
        domains = ICP.get_param(PARAM % 'entra_allowed_domains', 'snaphomz.com') or ''
        logins = ICP.get_param(PARAM % 'sso_password_logins', 'admin') or ''
        config = {
            'enabled': str(ICP.get_param(PARAM % 'entra_enabled', '')).lower() in ('1', 'true', 'yes'),
            'tenant_id': (ICP.get_param(PARAM % 'entra_tenant_id') or '').strip().lower(),
            'client_id': (ICP.get_param(PARAM % 'entra_client_id') or '').strip().lower(),
            'client_secret': ICP.get_param(PARAM % 'entra_client_secret') or '',
            'allowed_domains': {d.strip().lower().lstrip('@') for d in re.split(r'[,\s]+', domains) if d.strip()},
            'enforce': str(ICP.get_param(PARAM % 'sso_enforce', '')).lower() in ('1', 'true', 'yes'),
            'password_logins': {l.strip().lower() for l in re.split(r'[,\s]+', logins) if l.strip()},
        }
        config['ready'] = bool(
            config['enabled'] and GUID_RE.match(config['tenant_id']) and GUID_RE.match(config['client_id'])
            and config['client_secret'] and config['allowed_domains'])
        return config

    @api.model
    def _snaphomz_sso_enforced(self):
        config = self._snaphomz_entra_config()
        return config['ready'] and config['enforce']

    def _snaphomz_password_login_allowed(self):
        self.ensure_one()
        config = self._snaphomz_entra_config()
        if not (config['ready'] and config['enforce']):
            return True
        return (self.login or '').lower() in config['password_logins']

    @api.model
    def _snaphomz_login_page_context(self, params):
        """Values for the login template (rendered for anonymous visitors)."""
        config = self._snaphomz_entra_config()
        redirect = params.get('redirect') or ''
        start_url = '/snaphomz/auth/entra'
        if redirect.startswith('/') and not redirect.startswith('//'):
            start_url += '?' + urlencode({'redirect': redirect})
        code = params.get('entra_error')
        return {
            'enabled': config['ready'],
            'hide_password': config['ready'] and config['enforce'] and params.get('local') != '1',
            'start_url': start_url,
            'error': _(SSO_ERRORS[code]) if code in SSO_ERRORS else False,
            'domains': ', '.join(sorted('@' + d for d in config['allowed_domains'])),
        }

    # ------------------------------------------------------------------
    # Authorization request (PKCE)
    # ------------------------------------------------------------------

    @api.model
    def _snaphomz_entra_authorization(self, redirect_uri):
        """Return (authorize_url, pending_state) for a new sign-in attempt."""
        config = self._snaphomz_entra_config()
        if not config['ready']:
            raise SsoDenied('disabled')
        verifier = secrets.token_urlsafe(64)
        pending = {
            'state': secrets.token_urlsafe(32),
            'nonce': secrets.token_urlsafe(32),
            'verifier': verifier,
            'redirect_uri': redirect_uri,
            'created': int(time.time()),
        }
        query = urlencode({
            'client_id': config['client_id'],
            'response_type': 'code',
            'response_mode': 'query',
            'redirect_uri': redirect_uri,
            'scope': SCOPE,
            'state': pending['state'],
            'nonce': pending['nonce'],
            'code_challenge': _b64url(hashlib.sha256(verifier.encode()).digest()),
            'code_challenge_method': 'S256',
            'prompt': 'select_account',
        })
        return f"{AUTHORITY}/{config['tenant_id']}/oauth2/v2.0/authorize?{query}", pending

    # ------------------------------------------------------------------
    # Token redemption and claim validation
    # ------------------------------------------------------------------

    @api.model
    def _snaphomz_entra_redeem(self, code, pending):
        config = self._snaphomz_entra_config()
        if not config['ready']:
            raise SsoDenied('disabled')
        try:
            response = requests.post(
                f"{AUTHORITY}/{config['tenant_id']}/oauth2/v2.0/token",
                data={
                    'client_id': config['client_id'],
                    'client_secret': config['client_secret'],
                    'grant_type': 'authorization_code',
                    'code': code,
                    'redirect_uri': pending['redirect_uri'],
                    'code_verifier': pending['verifier'],
                    'scope': SCOPE,
                },
                timeout=15,
            )
        except requests.RequestException as exc:
            _logger.warning("Entra token request failed: %s", exc)
            raise SsoDenied('failed') from exc
        try:
            body = response.json()
        except ValueError:
            body = {}
        if not response.ok or not body.get('id_token'):
            _logger.warning("Entra token endpoint refused the code (%s): %s",
                            response.status_code, body.get('error_description') or body.get('error'))
            raise SsoDenied('failed')
        return self._snaphomz_entra_validate_claims(_jwt_claims(body['id_token']), pending['nonce'])

    @api.model
    def _snaphomz_entra_validate_claims(self, claims, nonce):
        config = self._snaphomz_entra_config()
        now = time.time()
        issuer = f"{AUTHORITY}/{config['tenant_id']}/v2.0"
        aud = claims.get('aud')
        audiences = {a.lower() for a in ([aud] if isinstance(aud, str) else (aud or []))}
        if config['client_id'] not in audiences:
            _logger.warning("Entra ID token for another audience: %s", aud)
            raise SsoDenied('failed')
        if (claims.get('tid') or '').lower() != config['tenant_id'] or claims.get('iss') != issuer:
            _logger.warning("Entra ID token from another tenant: tid=%s iss=%s", claims.get('tid'), claims.get('iss'))
            raise SsoDenied('tenant')
        if not nonce or not hmac.compare_digest(str(claims.get('nonce', '')), nonce):
            raise SsoDenied('state')
        if float(claims.get('exp', 0)) < now - CLOCK_SKEW or float(claims.get('nbf', 0)) > now + CLOCK_SKEW:
            raise SsoDenied('state')
        # Guests (B2B) keep their home identity provider in `idp`; members don't.
        if (claims.get('idp') and claims['idp'] != issuer) or str(claims.get('acct', '0')) == '1':
            raise SsoDenied('guest')
        oid = claims.get('oid')
        if not oid:
            raise SsoDenied('failed')
        emails = {
            (claims.get(key) or '').strip().lower()
            for key in ('email', 'preferred_username', 'upn')
        } - {''}
        allowed = {e for e in emails if e.rsplit('@', 1)[-1] in config['allowed_domains'] and '@' in e}
        if not allowed:
            _logger.info("Entra sign-in refused for %s: domain not allowed", ', '.join(sorted(emails)) or oid)
            raise SsoDenied('domain')
        return {'oid': oid, 'emails': allowed, 'name': claims.get('name')}

    # ------------------------------------------------------------------
    # User resolution and session login
    # ------------------------------------------------------------------

    @api.model
    def _snaphomz_entra_resolve_user(self, identity):
        Users = self.sudo().with_context(active_test=False)
        user = Users.search([('snaphomz_entra_oid', '=', identity['oid'])], limit=1)
        if not user:
            conditions = [c for e in sorted(identity['emails']) for c in (('login', '=ilike', e), ('email', '=ilike', e))]
            candidates = Users.search(['|'] * (len(conditions) - 1) + conditions)
            # =ilike treats _ and % as wildcards: keep exact (case-insensitive) matches only.
            candidates = candidates.filtered(
                lambda u: (u.login or '').lower() in identity['emails'] or (u.email or '').lower() in identity['emails'])
            if len(candidates) != 1:
                _logger.info("Entra sign-in refused: %s matching CRM users for %s",
                             len(candidates), ', '.join(sorted(identity['emails'])))
                raise SsoDenied('nouser')
            user = candidates
            if user.snaphomz_entra_oid and user.snaphomz_entra_oid != identity['oid']:
                raise SsoDenied('mismatch')
        if not user.active:
            raise SsoDenied('inactive')
        if user.share or user.has_group('snaphomz_crm.group_snaphomz_integration') or user.id == 1:
            raise SsoDenied('nouser')
        if not user.snaphomz_entra_oid:
            user.snaphomz_entra_oid = identity['oid']
        return user

    def _snaphomz_entra_issue_login_token(self):
        """One-time, two-minute token proving this request just passed Entra validation."""
        self.ensure_one()
        token = secrets.token_urlsafe(32)
        self.sudo().write({
            'snaphomz_entra_login_hash': hashlib.sha256(token.encode()).hexdigest(),
            'snaphomz_entra_login_expiry': fields.Datetime.now() + LOGIN_TOKEN_TTL,
        })
        return token

    def _check_credentials(self, credential, env):
        if credential.get('type') == 'snaphomz_entra':
            user = self.env.user.sudo()
            token = credential.get('token') or ''
            stored, expiry = user.snaphomz_entra_login_hash, user.snaphomz_entra_login_expiry
            user.write({'snaphomz_entra_login_hash': False, 'snaphomz_entra_login_expiry': False})
            if (not token or not stored or not expiry or expiry < fields.Datetime.now()
                    or not hmac.compare_digest(stored, hashlib.sha256(token.encode()).hexdigest())):
                raise AccessDenied()
            # Entra already applied MFA and Conditional Access.
            return {'uid': user.id, 'auth_method': 'snaphomz_entra', 'mfa': 'skip'}

        if not self.env.user._snaphomz_password_login_allowed():
            # Microsoft sign-in is required: passwords, passkeys and any other
            # sign-in method are refused. Scripts keep working with API keys.
            if (credential.get('type') == 'password' and credential.get('password')
                    and not (env or {}).get('interactive', True)):
                uid = self.env['res.users.apikeys']._check_credentials(scope='rpc', key=credential['password'])
                if uid == self.env.uid:
                    return {'uid': uid, 'auth_method': 'apikey', 'mfa': 'default'}
            raise SsoDenied('password')
        return super()._check_credentials(credential, env)

    @api.model_create_multi
    def create(self, vals_list):
        if self._snaphomz_sso_enforced():
            # No "set your password" invitation: people sign in with Microsoft.
            self = self.with_context(no_reset_password=True)
        return super().create(vals_list)


class ResConfigSettingsSso(models.TransientModel):
    _inherit = 'res.config.settings'

    snaphomz_entra_enabled = fields.Boolean(
        'Microsoft sign-in', config_parameter='snaphomz_crm.entra_enabled')
    snaphomz_entra_tenant_id = fields.Char(
        'Directory (tenant) ID', config_parameter='snaphomz_crm.entra_tenant_id')
    snaphomz_entra_client_id = fields.Char(
        'Application (client) ID', config_parameter='snaphomz_crm.entra_client_id')
    snaphomz_entra_client_secret = fields.Char(
        'Client secret', config_parameter='snaphomz_crm.entra_client_secret')
    snaphomz_entra_allowed_domains = fields.Char(
        'Allowed email domains', config_parameter='snaphomz_crm.entra_allowed_domains', default='snaphomz.com')
    snaphomz_sso_enforce = fields.Boolean(
        'Require Microsoft sign-in', config_parameter='snaphomz_crm.sso_enforce',
        help="Password sign-in is refused for everyone except the break-glass logins below.")
    snaphomz_sso_password_logins = fields.Char(
        'Break-glass password logins', config_parameter='snaphomz_crm.sso_password_logins', default='admin',
        help="Comma-separated logins that may still use a password at /web/login?local=1.")
    snaphomz_entra_redirect_uri = fields.Char('Redirect URI to register', compute='_compute_snaphomz_entra_redirect_uri')

    def _compute_snaphomz_entra_redirect_uri(self):
        base = self.env['ir.config_parameter'].sudo().get_param('web.base.url', '')
        for settings in self:
            settings.snaphomz_entra_redirect_uri = f"{base.rstrip('/')}/snaphomz/auth/entra/callback"

    def set_values(self):
        for settings in self.filtered('snaphomz_entra_enabled'):
            for label, value in ((_('Directory (tenant) ID'), settings.snaphomz_entra_tenant_id),
                                 (_('Application (client) ID'), settings.snaphomz_entra_client_id)):
                if not GUID_RE.match((value or '').strip()):
                    raise ValidationError(_("%s must be the GUID shown in the Entra app registration "
                                            "(not 'common' or 'organizations').", label))
        for settings in self.filtered('snaphomz_sso_enforce'):
            if not (settings.snaphomz_entra_enabled and settings.snaphomz_entra_client_secret):
                raise ValidationError(_("Configure and test Microsoft sign-in before requiring it."))
            if not (settings.snaphomz_sso_password_logins or '').strip():
                raise ValidationError(_("Keep at least one break-glass password login (e.g. admin)."))
        return super().set_values()
