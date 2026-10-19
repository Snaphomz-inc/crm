import re

from odoo import http
from odoo.http import request

from odoo.addons.web.controllers.home import Home

APP_PREFIX = '/app'
_ODOO_PREFIX = re.compile(r'^/odoo(?=/|\?|$)')


def to_app_url(url):
    """/odoo... -> /app...; anything else unchanged."""
    return _ODOO_PREFIX.sub(APP_PREFIX, url) if isinstance(url, str) else url


class SnaphomzHome(Home):
    """Serve the web client at /app and send people there after sign-in."""

    @http.route([APP_PREFIX, f'{APP_PREFIX}/<path:subpath>'], type='http', auth='none', readonly=False)
    def snaphomz_web_client(self, s_action=None, **kw):
        return self.web_client(s_action=s_action, **kw)

    @http.route()
    def index(self, s_action=None, db=None, **kw):
        response = super().index(s_action=s_action, db=db, **kw)
        if response.status_code in (301, 302, 303, 307, 308) and response.location:
            response.location = to_app_url(response.location)
        return response

    def _login_redirect(self, uid, redirect=None):
        return to_app_url(super()._login_redirect(uid, redirect=redirect))
