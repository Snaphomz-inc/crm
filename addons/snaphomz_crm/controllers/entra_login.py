import hmac
import logging
import time
from urllib.parse import urlencode

from odoo import http
from odoo.exceptions import AccessDenied
from odoo.http import request

from odoo.addons.web.controllers.utils import _get_login_redirect_url, ensure_db

_logger = logging.getLogger(__name__)

SESSION_KEY = 'snaphomz_entra'
PENDING_TTL = 600


def _safe_redirect(target):
    if target and target.startswith('/') and not target.startswith('//') and '\\' not in target:
        return target
    return '/odoo'


def _login_error(code):
    return request.redirect('/web/login?' + urlencode({'entra_error': code}), 303)


class SnaphomzEntraLogin(http.Controller):

    @http.route('/snaphomz/auth/entra', type='http', auth='none', methods=['GET'], readonly=False)
    def entra_start(self, redirect=None, **_kw):
        ensure_db()
        Users = request.env['res.users'].sudo()
        redirect_uri = request.httprequest.url_root.rstrip('/') + '/snaphomz/auth/entra/callback'
        try:
            url, pending = Users._snaphomz_entra_authorization(redirect_uri)
        except AccessDenied as exc:
            return _login_error(getattr(exc, 'code', 'failed'))
        pending['redirect'] = _safe_redirect(redirect)
        request.session[SESSION_KEY] = pending
        return request.redirect(url, 303, local=False)

    @http.route('/snaphomz/auth/entra/callback', type='http', auth='none', methods=['GET'], readonly=False)
    def entra_callback(self, code=None, state=None, error=None, **_kw):
        ensure_db()
        pending = request.session.pop(SESSION_KEY, None)
        if error:
            _logger.info("Entra sign-in returned error %s", error)
            return _login_error('cancelled' if error == 'access_denied' else 'failed')
        if (not pending or not state or not code
                or not hmac.compare_digest(str(state), pending.get('state', ''))
                or time.time() - pending.get('created', 0) > PENDING_TTL):
            return _login_error('state')

        Users = request.env['res.users'].sudo()
        try:
            identity = Users._snaphomz_entra_redeem(code, pending)
            user = Users._snaphomz_entra_resolve_user(identity)
            token = user._snaphomz_entra_issue_login_token()
            credential = {'login': user.login, 'token': token, 'type': 'snaphomz_entra'}
            auth_info = request.session.authenticate(request.env, credential)
        except AccessDenied as exc:
            request.env.cr.commit()  # keep the consumed one-time token cleared
            return _login_error(getattr(exc, 'code', 'failed'))
        response = request.redirect(_get_login_redirect_url(auth_info['uid'], pending.get('redirect')), 303)
        response.autocorrect_location_header = False
        return response
