import json
import logging
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError
from odoo.tools import html_escape

from .common import SUPPRESSED_EMAIL_STATUSES

_logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 8
CLAIM_LEASE_MINUTES = 15
TEMPORARY_STATUS_CODES = {0, 408, 409, 425, 429}


class SnaphomzOutboundQueue(models.Model):
    """Approved CRM changes waiting to be written to Loops by n8n.

    One pending entry per buyer at a time: newer changes update the pending
    entry's payload and version, so Loops only ever receives the latest state
    and a retry never replays an outdated stage.
    """
    _name = 'snaphomz.outbound.queue'
    _description = 'Outbound Loops update'
    _order = 'id desc'

    partner_id = fields.Many2one('res.partner', 'Buyer', required=True, ondelete='cascade', index=True)
    lead_id = fields.Many2one('crm.lead', 'Acquisition', ondelete='set null')
    target = fields.Selection([('loops', 'Loops')], default='loops', required=True)
    payload = fields.Json('Raw payload', required=True)
    payload_pretty = fields.Text('Payload', compute='_compute_payload_pretty')
    version = fields.Integer(required=True, help="Monotonic per buyer; the record version sent to Loops.")
    state = fields.Selection([
        ('pending', 'Pending'),
        ('in_progress', 'Sending'),
        ('done', 'Sent'),
        ('skipped', 'Skipped'),
        ('failed', 'Failed'),
    ], default='pending', required=True, index=True)
    attempts = fields.Integer()
    next_attempt_at = fields.Datetime(index=True)
    claimed_at = fields.Datetime()
    done_at = fields.Datetime()
    last_status_code = fields.Integer()
    last_error = fields.Text()

    def _compute_payload_pretty(self):
        for entry in self:
            entry.payload_pretty = json.dumps(entry.payload, indent=2, sort_keys=True) if entry.payload else ''

    # ------------------------------------------------------------------
    # Enqueue (called from crm.lead / res.partner writes)
    # ------------------------------------------------------------------

    @api.model
    def _loops_sync_allowed(self, partner):
        """Phone-only, suppressed or non-consenting buyers are never pushed as new Loops contacts."""
        if not partner.email_normalized:
            return False, _('no usable email')
        if partner.loops_contact_id:
            return True, ''
        if partner.do_not_contact:
            return False, _('do-not-contact buyer is not created in Loops')
        if partner.email_subscription_status in SUPPRESSED_EMAIL_STATUSES:
            return False, _('suppressed email is not created in Loops')
        policy = self.env['ir.config_parameter'].sudo().get_param('snaphomz_crm.loops_contact_creation', 'consent')
        if policy == 'never':
            return False, _('policy: only existing Loops contacts are updated')
        if policy == 'consent' and not partner.marketing_consent:
            return False, _('no recorded marketing consent')
        return True, ''

    @api.model
    def _enqueue_for_lead(self, lead):
        partner = lead.partner_id
        allowed, _reason = self._loops_sync_allowed(partner)
        if not allowed:
            return self.browse()
        payload = {'email': partner.email_normalized, **lead._snaphomz_loops_properties()}
        pending = self.search([('partner_id', '=', partner.id), ('state', '=', 'pending')], limit=1)
        if pending and pending.payload == payload:
            return pending
        if not pending and partner.loops_synced_payload == payload:
            in_flight = self.search_count([('partner_id', '=', partner.id), ('state', '=', 'in_progress')])
            if not in_flight:
                return self.browse()
        version = partner.loops_version_seq + 1
        partner.with_context(snaphomz_origin='loops').sudo().write({'loops_version_seq': version})
        if pending:
            pending.write({'payload': payload, 'version': version, 'lead_id': lead.id})
            return pending
        return self.create({'partner_id': partner.id, 'lead_id': lead.id, 'payload': payload, 'version': version})

    # ------------------------------------------------------------------
    # Public API for the n8n worker (integration user, JSON-2)
    # ------------------------------------------------------------------

    def _check_worker_access(self):
        user = self.env.user
        if not (self.env.su or user.has_group('snaphomz_crm.group_snaphomz_integration') or user.has_group('base.group_system')):
            raise AccessError(_("Only the Snaphomz integration user may process the Loops queue."))

    @api.model
    def claim_batch(self, limit=20):
        """Lease up to `limit` due entries (at most one per buyer).

        Returns {"items": [{"queue_id", "version", "method", "path", "body"}, ...]}.
        """
        self._check_worker_access()
        limit = max(1, min(int(limit), 100))
        now = fields.Datetime.now()
        self.flush_model()
        self.env.cr.execute("""
            SELECT q.id FROM snaphomz_outbound_queue q
             WHERE q.state = 'pending'
               AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= %s)
               AND NOT EXISTS (SELECT 1 FROM snaphomz_outbound_queue o
                                WHERE o.partner_id = q.partner_id AND o.state = 'in_progress')
             ORDER BY q.id
             LIMIT %s
               FOR UPDATE SKIP LOCKED
        """, [now, limit])
        entries = self.sudo().browse([row[0] for row in self.env.cr.fetchall()])
        batch = []
        for entry in entries:
            allowed, reason = self._loops_sync_allowed(entry.partner_id)
            if not allowed:
                entry.write({'state': 'skipped', 'last_error': reason, 'done_at': now})
                continue
            entry.write({'state': 'in_progress', 'claimed_at': now, 'attempts': entry.attempts + 1})
            batch.append({
                'queue_id': entry.id,
                'version': entry.version,
                'method': 'PUT',
                'path': '/api/v1/contacts/update',
                'body': entry.payload,
            })
        return {'items': batch}

    @api.model
    def report_result(self, queue_id, success, status_code=None, error=None, loops_contact_id=None):
        """Record the Loops API response for one claimed entry."""
        self._check_worker_access()
        entry = self.sudo().browse(int(queue_id)).exists()
        if not entry:
            raise UserError(_("Unknown queue entry %s", queue_id))
        if entry.state != 'in_progress':
            return {'status': 'ignored', 'state': entry.state}
        now = fields.Datetime.now()
        code = int(status_code or 0)
        partner = entry.partner_id.with_context(snaphomz_origin='loops').sudo()
        if success:
            entry.write({'state': 'done', 'done_at': now, 'last_status_code': code or 200, 'last_error': False})
            vals = {}
            if entry.version >= partner.loops_synced_version:
                vals.update(loops_synced_payload=entry.payload, loops_synced_version=entry.version)
            if loops_contact_id and not partner.loops_contact_id:
                vals['loops_contact_id'] = loops_contact_id
            if vals:
                partner.write(vals)
            return {'status': 'done'}

        temporary = code in TEMPORARY_STATUS_CODES or code >= 500
        if temporary and entry.attempts < MAX_ATTEMPTS:
            delay = min(2 ** entry.attempts, 360)
            entry.write({
                'state': 'pending', 'next_attempt_at': now + timedelta(minutes=delay),
                'last_status_code': code, 'last_error': (error or '')[:4000],
            })
            return {'status': 'retry', 'next_attempt_at': fields.Datetime.to_string(entry.next_attempt_at)}
        entry.write({'state': 'failed', 'last_status_code': code, 'last_error': (error or '')[:4000]})
        entry._notify_failure()
        return {'status': 'failed'}

    # ------------------------------------------------------------------
    # Maintenance
    # ------------------------------------------------------------------

    @api.model
    def _cron_release_stale_claims(self):
        cutoff = fields.Datetime.now() - timedelta(minutes=CLAIM_LEASE_MINUTES)
        stale = self.sudo().search([('state', '=', 'in_progress'), ('claimed_at', '<', cutoff)])
        stale.write({'state': 'pending', 'last_error': _('worker lease expired; retrying')})

    def action_retry(self):
        self.sudo().filtered(lambda e: e.state in ('failed', 'skipped')).write(
            {'state': 'pending', 'attempts': 0, 'next_attempt_at': False})
        return True

    def _notify_failure(self):
        Event = self.env['snaphomz.inbound.event']
        param = self.env['ir.config_parameter'].sudo().get_param('snaphomz_crm.technical_owner_id')
        owner = self.env['res.users'].sudo().browse(int(param)).exists() if param and param.isdigit() else False
        owner = owner or self.env.ref('base.user_admin', raise_if_not_found=False)
        for entry in self:
            if owner:
                self.env['mail.thread'].sudo().message_notify(
                    model=self._name, res_id=entry.id, partner_ids=owner.partner_id.ids,
                    subject=_('Loops update failed'),
                    body=html_escape(_('Loops update for %(buyer)s failed (%(code)s): %(error)s',
                                       buyer=entry.partner_id.display_name, code=entry.last_status_code,
                                       error=(entry.last_error or '')[:500])))
        return Event
