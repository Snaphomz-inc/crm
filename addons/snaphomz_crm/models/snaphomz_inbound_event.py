import json
import logging
import uuid
from datetime import timedelta

import psycopg2

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tools import html_escape

from .common import INTAKE_EVENT_TYPES, INTAKE_PROVIDERS, PROVIDERS, parse_datetime

_logger = logging.getLogger(__name__)

# Minutes to wait before each automatic retry of a failed processing attempt.
RETRY_BACKOFF_MINUTES = (1, 2, 5, 15, 60, 240)
MAX_ATTEMPTS = len(RETRY_BACKOFF_MINUTES) + 1


class RetryLater(Exception):
    """Temporary condition (e.g. concurrent intake for the same person)."""


class SnaphomzInboundEvent(models.Model):
    """Durable log of every event received from Meta, the website, imports and Loops.

    Events are accepted (stored) before they are processed, de-duplicated on
    (provider, event_id), retried with backoff and, when they cannot be
    processed automatically, kept for review and controlled replay.
    """
    _name = 'snaphomz.inbound.event'
    _description = 'Inbound integration event'
    _order = 'received_at desc, id desc'
    _rec_name = 'event_id'

    provider = fields.Selection(PROVIDERS, required=True, index=True, readonly=True)
    event_id = fields.Char('Event ID', required=True, index=True, readonly=True)
    event_type = fields.Char(required=True, readonly=True)
    event_at = fields.Datetime('Event time', readonly=True)
    received_at = fields.Datetime(required=True, default=fields.Datetime.now, readonly=True, index=True)
    person_uuid = fields.Char('Person UUID', index=True, readonly=True)
    acquisition_uuid = fields.Char('Acquisition UUID', index=True, readonly=True)
    partner_id = fields.Many2one('res.partner', 'Buyer', ondelete='set null', index=True, readonly=True)
    lead_id = fields.Many2one('crm.lead', 'Acquisition', ondelete='set null', index=True, readonly=True)
    payload = fields.Json('Raw payload', readonly=True)
    payload_pretty = fields.Text('Payload', compute='_compute_payload_pretty')
    state = fields.Selection([
        ('pending', 'Pending'),
        ('done', 'Processed'),
        ('review', 'Needs review'),
        ('failed', 'Failed'),
        ('ignored', 'Ignored'),
    ], default='pending', required=True, index=True, readonly=True)
    attempts = fields.Integer(readonly=True)
    next_attempt_at = fields.Datetime(readonly=True, index=True)
    processed_at = fields.Datetime(readonly=True)
    result = fields.Char(readonly=True)
    error = fields.Text(readonly=True)
    review_reason = fields.Selection([
        ('identity_conflict', 'Conflicting identity'),
        ('unknown_buyer', 'No matching buyer'),
        ('acquisition_conflict', 'Acquisition belongs to another person'),
    ], readonly=True)
    conflict_partner_ids = fields.Many2many('res.partner', string='Possible matches', readonly=True)
    forced_partner_id = fields.Many2one(
        'res.partner', 'Resolved to buyer', readonly=True,
        help="Set by a manager when resolving an identity conflict.")
    force_new_person = fields.Boolean('Resolved as new person', readonly=True)

    _provider_event_uniq = models.Constraint(
        'UNIQUE(provider, event_id)', 'This event has already been received.')

    def _compute_payload_pretty(self):
        for event in self:
            event.payload_pretty = json.dumps(event.payload, indent=2, sort_keys=True, default=str) if event.payload else ''

    # ------------------------------------------------------------------
    # Public API (called with the integration user's API key over JSON-2)
    # ------------------------------------------------------------------

    @api.model
    def submit_intake(self, payload):
        """Canonical intake for Meta, website, signing-system and import events.

        Returns {"status": "accepted"|"duplicate", "state": ..., ...}. The
        event is stored before processing, so a returned "accepted" means the
        caller may stop retrying even if processing is still pending.
        """
        self._snaphomz_check_api_access()
        if not isinstance(payload, dict):
            raise UserError(_("payload must be a JSON object"))
        provider = payload.get('provider')
        event_type = payload.get('event_type')
        event_id = payload.get('event_id')
        if provider not in INTAKE_PROVIDERS:
            raise UserError(_("provider must be one of %s", ', '.join(INTAKE_PROVIDERS)))
        if event_type not in INTAKE_EVENT_TYPES:
            raise UserError(_("event_type must be one of %s", ', '.join(INTAKE_EVENT_TYPES)))
        if not event_id or len(str(event_id)) > 255:
            raise UserError(_("event_id is required (max 255 characters)"))
        try:
            event_at = parse_datetime(payload.get('event_time'))
        except ValueError as exc:
            raise UserError(_("event_time is not a valid ISO-8601 datetime: %s", exc)) from exc
        person = payload.get('person') or {}
        event, duplicate = self._snaphomz_accept(
            provider, str(event_id), event_type, event_at, payload,
            person_uuid=person.get('person_uuid'), acquisition_uuid=payload.get('acquisition_uuid'))
        if not duplicate:
            event._snaphomz_process()
        return event._snaphomz_api_result(duplicate)

    @api.model
    def preview_intake(self, payload):
        """Dry run: report how a payload would be matched, without writing anything."""
        self._snaphomz_check_api_access()
        with self.env.cr.savepoint() as savepoint:
            normalized = self.sudo()._snaphomz_normalize_intake(payload)
            partner, conflicts, reason = self.sudo()._snaphomz_match_person(normalized)
            lead = partner and self.sudo()._snaphomz_find_acquisition(partner, normalized)
            result = {
                'action': 'conflict' if conflicts else ('update' if partner else 'create'),
                'reason': reason or '',
                'partner_id': partner.id if partner else False,
                'partner_name': partner.name if partner else False,
                'lead_id': lead.id if lead else False,
                'lead_active': bool(lead and lead.active),
                'conflict_partner_ids': conflicts.ids if conflicts else [],
                'email': normalized['email'],
                'phone': normalized['phone'],
            }
            savepoint.rollback()
        return result

    @api.model
    def find_missing_events(self, provider, event_ids):
        """Return {"missing": [...]}: the event_ids not yet received (daily reconciliation)."""
        self._snaphomz_check_api_access()
        wanted = [str(e) for e in event_ids or []]
        found = set(self.sudo().search([('provider', '=', provider), ('event_id', 'in', wanted)]).mapped('event_id'))
        return {'missing': [e for e in wanted if e not in found]}

    @api.model
    def report_integration_failure(self, workflow, error, execution_id=None, execution_url=None, node=None):
        """Called by the n8n error workflow so failures surface in Odoo."""
        self._snaphomz_check_api_access()
        event, _dup = self._snaphomz_accept(
            'n8n', f"n8n:{execution_id or uuid.uuid4()}", 'workflow_error', fields.Datetime.now(),
            {'workflow': workflow, 'node': node, 'error': error, 'execution_url': execution_url})
        event.sudo().write({'state': 'failed', 'error': str(error)[:4000], 'result': workflow})
        event._snaphomz_notify_technical_owner()
        return {'status': 'recorded', 'id': event.id}

    def _snaphomz_check_api_access(self):
        user = self.env.user
        if not (self.env.su or user.has_group('snaphomz_crm.group_snaphomz_integration') or user.has_group('base.group_system')):
            raise AccessError(_("Only the Snaphomz integration user may call this method."))

    def _snaphomz_api_result(self, duplicate):
        if not self:
            # Same event stored by a concurrent request that committed after
            # this transaction started: it exists but is not visible here.
            return {'status': 'duplicate', 'id': False, 'state': 'unknown', 'result': '',
                    'lead_id': False, 'acquisition_uuid': False, 'person_uuid': False}
        self.ensure_one()
        return {
            'status': 'duplicate' if duplicate else 'accepted',
            'id': self.id,
            'state': self.state,
            'result': self.result or '',
            'lead_id': self.lead_id.id or False,
            'acquisition_uuid': self.lead_id.acquisition_uuid or False,
            'person_uuid': self.partner_id.snaphomz_person_uuid or False,
        }

    # ------------------------------------------------------------------
    # Accept, process, retry
    # ------------------------------------------------------------------

    @api.model
    def _snaphomz_accept(self, provider, event_id, event_type, event_at, payload, **extra):
        """Store the event once. Returns (event, is_duplicate)."""
        Event = self.sudo()
        existing = Event.search([('provider', '=', provider), ('event_id', '=', event_id)], limit=1)
        if existing:
            return existing, True
        vals = {
            'provider': provider,
            'event_id': event_id,
            'event_type': event_type,
            'event_at': event_at or fields.Datetime.now(),
            'payload': payload,
            'person_uuid': extra.get('person_uuid') or False,
            'acquisition_uuid': extra.get('acquisition_uuid') or False,
        }
        try:
            with self.env.cr.savepoint():
                event = Event.create(vals)
        except psycopg2.IntegrityError:
            # A concurrent delivery of the same event was stored first.
            return Event.browse(), True
        return event, False

    def _snaphomz_process(self):
        now = fields.Datetime.now()
        for event in self.sudo():
            if event.state in ('done', 'ignored'):
                continue
            event.attempts += 1
            try:
                with self.env.cr.savepoint():
                    outcome = event._snaphomz_dispatch()
            except (RetryLater, psycopg2.IntegrityError, psycopg2.errors.SerializationFailure,
                    psycopg2.errors.LockNotAvailable, psycopg2.errors.DeadlockDetected) as exc:
                event._snaphomz_schedule_retry(str(exc) or exc.__class__.__name__)
            except (UserError, ValidationError, AccessError) as exc:
                # The payload or a business rule needs a person: no blind retry.
                event._snaphomz_mark_failed(str(exc))
            except Exception as exc:  # noqa: BLE001 - keep the event, retry later
                _logger.exception("Processing inbound event %s/%s failed", event.provider, event.event_id)
                event._snaphomz_schedule_retry(repr(exc))
            else:
                values = {
                    'state': outcome.get('state', 'done'),
                    'result': outcome.get('summary', ''),
                    'processed_at': now,
                    'next_attempt_at': False,
                    'error': False,
                }
                for key in ('partner_id', 'lead_id', 'review_reason'):
                    if outcome.get(key):
                        values[key] = outcome[key]
                if outcome.get('conflict_partner_ids'):
                    values['conflict_partner_ids'] = [(6, 0, outcome['conflict_partner_ids'])]
                event.write(values)
                if values['state'] == 'review':
                    event._snaphomz_notify_managers(
                        _("Buyer intake needs review"),
                        _("Event %(event)s (%(provider)s) needs a manager: %(summary)s",
                          event=event.event_id, provider=event.provider, summary=values['result']))
        return True

    def _snaphomz_dispatch(self):
        self.ensure_one()
        if self.provider == 'loops':
            return self._snaphomz_process_loops()
        if self.provider in INTAKE_PROVIDERS:
            return self._snaphomz_process_intake()
        return {'state': 'ignored', 'summary': 'No processor for this provider'}

    def _snaphomz_schedule_retry(self, error):
        self.ensure_one()
        if self.attempts >= MAX_ATTEMPTS:
            self._snaphomz_mark_failed(error)
            return
        delay = RETRY_BACKOFF_MINUTES[min(self.attempts, len(RETRY_BACKOFF_MINUTES)) - 1]
        self.write({
            'state': 'pending',
            'error': error[:4000],
            'next_attempt_at': fields.Datetime.now() + timedelta(minutes=delay),
        })

    def _snaphomz_mark_failed(self, error):
        self.ensure_one()
        self.write({'state': 'failed', 'error': error[:4000], 'next_attempt_at': False})
        self._snaphomz_notify_technical_owner()

    @api.model
    def _cron_process_pending(self, limit=200):
        now = fields.Datetime.now()
        events = self.sudo().search([
            ('state', '=', 'pending'),
            '|', ('next_attempt_at', '=', False), ('next_attempt_at', '<=', now),
        ], order='id', limit=limit)
        Cron = self.env['ir.cron']
        for event in events:
            event._snaphomz_process()
            Cron._commit_progress(processed=1)

    @api.model
    def _cron_cleanup(self):
        """Drop old marketing events that matched no buyer; keep everything else."""
        cutoff = fields.Datetime.now() - timedelta(days=30)
        self.sudo().search([('state', '=', 'ignored'), ('received_at', '<', cutoff)], limit=10000).unlink()

    # ------------------------------------------------------------------
    # Manager actions
    # ------------------------------------------------------------------

    def action_replay(self):
        """Controlled replay: reprocess once, keeping the same event identity."""
        for event in self.sudo().filtered(lambda e: e.state in ('failed', 'review', 'pending')):
            event.write({'state': 'pending', 'attempts': 0, 'next_attempt_at': False, 'error': False})
            event._snaphomz_process()
        return True

    def action_ignore(self):
        self.sudo().filtered(lambda e: e.state != 'done').write({'state': 'ignored', 'next_attempt_at': False})
        return True

    def action_open_resolve(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Resolve buyer identity'),
            'res_model': 'snaphomz.resolve.event',
            'view_mode': 'form',
            'target': 'new',
            'context': {'default_event_id': self.id},
        }

    # ------------------------------------------------------------------
    # Notifications
    # ------------------------------------------------------------------

    def _snaphomz_notify(self, users, subject, body):
        partners = users.filtered('active').partner_id
        if not partners:
            return
        for event in self:
            target = event.lead_id
            if target:
                target.sudo().message_notify(partner_ids=partners.ids, subject=subject, body=body)
            else:
                self.env['mail.thread'].sudo().message_notify(
                    model=self._name, res_id=event.id, partner_ids=partners.ids, subject=subject, body=body)

    def _snaphomz_notify_managers(self, subject, body):
        team = self.env['crm.team']._snaphomz_buyer_team()
        managers = team.user_id or self.env.ref('sales_team.group_sale_manager').sudo().user_ids.filtered(
            lambda u: not u.share and u.id != self.env.ref('base.user_root').id)[:3]
        self._snaphomz_notify(managers, subject, html_escape(body))

    def _snaphomz_notify_technical_owner(self):
        param = self.env['ir.config_parameter'].sudo().get_param('snaphomz_crm.technical_owner_id')
        owner = self.env['res.users'].sudo().browse(int(param)).exists() if param and param.isdigit() else False
        owner = owner or self.env.ref('base.user_admin', raise_if_not_found=False)
        for event in self:
            event._snaphomz_notify(owner, _("Integration failure"), html_escape(_(
                "%(provider)s event %(event)s failed: %(error)s",
                provider=event.provider, event=event.event_id, error=(event.error or '')[:500])))
