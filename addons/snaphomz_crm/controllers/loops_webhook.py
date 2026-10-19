import json
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class LoopsWebhookController(http.Controller):
    """Receives Loops webhooks (directly, or relayed unchanged by n8n).

    The signature on the raw body is the authentication. The event is stored
    before 2xx is returned; anything else makes Loops retry.
    """

    @http.route('/snaphomz/webhooks/loops', type='http', auth='public', methods=['POST'],
                csrf=False, save_session=False)
    def loops_webhook(self, **_kwargs):
        raw_body = request.httprequest.get_data(cache=False)
        headers = {k.lower(): v for k, v in request.httprequest.headers.items()
                   if k.lower().startswith('webhook-')}
        integration_user = request.env.ref('snaphomz_crm.user_snaphomz_integration').sudo()
        Event = request.env['snaphomz.inbound.event'].with_user(integration_user)
        try:
            status, body = Event.receive_loops_webhook(raw_body, headers)
        except Exception:
            _logger.exception("Loops webhook could not be stored")
            status, body = 500, {'status': 'error'}
        if status == 401:
            _logger.warning("Rejected Loops webhook with invalid signature (id=%s)", headers.get('webhook-id'))
        return request.make_response(
            json.dumps(body), headers=[('Content-Type', 'application/json')], status=status)
