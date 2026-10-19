"""Loops webhook verification and processing.

Loops signs webhooks with the Standard Webhooks scheme: HMAC-SHA256 over
"{webhook-id}.{webhook-timestamp}.{raw body}" using the base64 secret after
the "whsec_" prefix; the Webhook-Signature header holds space-separated
"v1,<base64>" entries. Timestamps older than five minutes are rejected.
"""
import base64
import binascii
import hashlib
import hmac
import json
import time

from odoo import _, api, models

from .common import normalize_email, parse_datetime

TIMESTAMP_TOLERANCE_SECONDS = 300

# Loops event -> subscription status it proves.
STATUS_EVENTS = {
    'contact.unsubscribed': 'unsubscribed',
    'email.unsubscribed': 'unsubscribed',
    'email.hardBounced': 'bounced',
    'email.spamReported': 'spam_complaint',
    'email.resubscribed': 'subscribed',
}


def verify_loops_signature(raw_body, headers, secrets, now=None):
    """Return True when any configured secret produced one of the v1 signatures."""
    webhook_id = headers.get('webhook-id')
    timestamp = headers.get('webhook-timestamp')
    signature_header = headers.get('webhook-signature')
    if not (webhook_id and timestamp and signature_header and secrets):
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    if abs((now or time.time()) - ts) > TIMESTAMP_TOLERANCE_SECONDS:
        return False
    signed = f"{webhook_id}.{timestamp}.".encode() + raw_body
    candidates = [
        value for version, _sep, value in (part.partition(',') for part in signature_header.split())
        if version == 'v1'
    ]
    for secret in secrets:
        try:
            key = base64.b64decode(secret.removeprefix('whsec_'))
        except (binascii.Error, ValueError):
            continue
        expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
        if any(hmac.compare_digest(expected, candidate) for candidate in candidates):
            return True
    return False


class SnaphomzInboundEventLoops(models.Model):
    _inherit = 'snaphomz.inbound.event'

    @api.model
    def _snaphomz_loops_secrets(self):
        raw = self.env['ir.config_parameter'].sudo().get_param('snaphomz_crm.loops_signing_secret') or ''
        return [s for s in raw.replace(',', ' ').split() if s]

    @api.model
    def receive_loops_webhook(self, raw_body, headers):
        """Verify, store and process one Loops webhook delivery.

        Returns (http_status, body). 401 for bad signatures so Loops shows the
        failure; 2xx only after the event is durably stored.
        """
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        if not verify_loops_signature(raw_body, headers, self._snaphomz_loops_secrets()):
            return 401, {'status': 'invalid_signature'}
        try:
            payload = json.loads(raw_body)
        except ValueError:
            return 400, {'status': 'invalid_json'}
        if not isinstance(payload, dict) or not payload.get('eventName'):
            return 400, {'status': 'invalid_payload'}
        identity = payload.get('contactIdentity') or payload.get('contact') or {}
        event, duplicate = self._snaphomz_accept(
            'loops', headers['webhook-id'], payload['eventName'],
            parse_datetime(payload.get('eventTime')), payload)
        if duplicate:
            return 200, {'status': 'duplicate'}
        event.sudo().person_uuid = identity.get('crmPersonId') or (payload.get('contact') or {}).get('crmPersonId') or False
        event._snaphomz_process()
        return 200, {'status': 'accepted', 'state': event.state}

    def _snaphomz_loops_partner(self, payload):
        Partner = self.env['res.partner'].sudo()
        contact = payload.get('contact') or {}
        identity = payload.get('contactIdentity') or {}
        loops_id = identity.get('id') or contact.get('id')
        person_uuid = contact.get('crmPersonId')
        email = normalize_email(identity.get('email') or contact.get('email'))
        if loops_id:
            partner = Partner.search([('loops_contact_id', '=', loops_id)], limit=1)
            if partner:
                return partner
        if person_uuid:
            partner = Partner.search([('snaphomz_person_uuid', '=', person_uuid)], limit=1)
            if partner:
                return partner
        if email:
            return self._snaphomz_key_partner('email', email)
        return Partner.browse()

    def _snaphomz_process_loops(self):
        """Marketing events never touch sales stage, owner or human follow-up clocks."""
        self.ensure_one()
        payload = self.payload or {}
        name = payload.get('eventName')
        at = self.event_at
        if name == 'testing.testEvent':
            return {'state': 'done', 'summary': 'test event'}

        partner = self._snaphomz_loops_partner(payload)
        if not partner:
            return {'state': 'ignored', 'summary': 'no matching buyer'}
        partner = partner.with_context(snaphomz_origin='loops')
        identity = payload.get('contactIdentity') or payload.get('contact') or {}
        loops_id = identity.get('id')
        if loops_id and partner.loops_contact_id != loops_id and name != 'contact.deleted':
            partner.loops_contact_id = loops_id

        summary = name
        if name in STATUS_EVENTS:
            applied = partner._snaphomz_apply_email_status(STATUS_EVENTS[name], at)
            summary = f"{name}: {'applied' if applied else 'older than current status, ignored'}"
        elif name == 'contact.created':
            subscribed = (payload.get('contact') or {}).get('subscribed')
            if subscribed is not None and partner.email_subscription_status == 'unknown':
                partner._snaphomz_apply_email_status('subscribed' if subscribed else 'unsubscribed', at)
        elif name == 'contact.deleted':
            partner._snaphomz_apply_email_status('unsubscribed', at)
            partner.loops_contact_id = False
        elif name == 'email.clicked':
            partner._snaphomz_touch('last_marketing_engagement_at', at)
        elif name == 'email.opened':
            partner._snaphomz_touch('last_email_open_at', at)

        lead = partner.snaphomz_lead_ids.filtered('active')[:1] or partner.snaphomz_lead_ids[:1]
        return {'state': 'done', 'summary': summary, 'partner_id': partner.id, 'lead_id': lead.id or False}
