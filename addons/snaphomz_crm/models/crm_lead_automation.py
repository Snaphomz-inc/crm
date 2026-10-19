"""Scheduled automations: first-contact reminders, overdue digests, BRA expiry."""
from collections import defaultdict

from odoo import _, api, fields, models
from odoo.tools import format_datetime, html_escape


class CrmLeadAutomation(models.Model):
    _inherit = 'crm.lead'

    def _snaphomz_record_url(self):
        base_url = self.get_base_url()
        return f"{base_url}/mail/view?model=crm.lead&res_id={self.id}"

    @api.model
    def _cron_snaphomz_first_contact_alerts(self):
        """Owner reminder after 15 staffed minutes without a human attempt; manager after 30.

        Disabled by default: enable only once staffed hours are confirmed.
        """
        now = fields.Datetime.now()
        Lead = self.sudo().with_context(snaphomz_skip_validation=True)
        base = [
            ('active', '=', True), ('buyer_status', '=', 'new'),
            ('first_human_attempt_at', '=', False), ('consultation_booked_at', '=', False),
        ]
        for lead in Lead.search(base + [('sla_owner_alerted', '=', False), ('sla_owner_alert_at', '<=', now)]):
            target = lead.user_id or lead.team_id.user_id
            if target:
                lead.message_notify(
                    partner_ids=target.partner_id.ids,
                    subject=_('First contact overdue: %s', lead.display_name),
                    body=html_escape(_('No contact attempt has been logged since the inquiry. Call now and use Log outcome.')))
            lead.sla_owner_alerted = True
        for lead in Lead.search(base + [('sla_manager_alerted', '=', False), ('sla_manager_alert_at', '<=', now)]):
            managers = lead.team_id._snaphomz_managers() if lead.team_id else self.env['res.users']
            if managers:
                lead.message_notify(
                    partner_ids=managers.partner_id.ids,
                    subject=_('Escalation: %s not contacted', lead.display_name),
                    body=html_escape(_('Owner: %(owner)s. Inquiry received %(at)s. No contact attempt logged.',
                                       owner=lead.user_id.name or _('unassigned'),
                                       at=format_datetime(self.env, lead.origin_at or lead.create_date,
                                                          tz=managers[0].tz))))
            lead.sla_manager_alerted = True

    @api.model
    def _cron_snaphomz_overdue_digest(self):
        """Daily digest of overdue next actions for each owner and for the manager."""
        now = fields.Datetime.now()
        overdue = self.sudo().search([('active', '=', True), ('next_action_at', '<', now)], order='next_action_at')
        if not overdue:
            return
        by_user = defaultdict(lambda: self.browse())
        for lead in overdue:
            by_user[lead.user_id] |= lead

        def table(leads, tz):
            rows = ''.join(
                f"<tr><td><a href='{html_escape(lead._snaphomz_record_url())}'>{html_escape(lead.display_name)}</a></td>"
                f"<td>{html_escape(lead.next_action or '')}</td>"
                f"<td>{html_escape(format_datetime(self.env, lead.next_action_at, tz=tz))}</td>"
                f"<td>{html_escape(lead.user_id.name or _('Unassigned'))}</td></tr>"
                for lead in leads)
            return (f"<table class='table table-sm'><tr><th>{_('Buyer')}</th><th>{_('Next action')}</th>"
                    f"<th>{_('Due')}</th><th>{_('Owner')}</th></tr>{rows}</table>")

        Thread = self.env['mail.thread'].sudo()
        team = self.env['crm.team']._snaphomz_buyer_team()
        for user, leads in by_user.items():
            if user and user.active:
                Thread.message_notify(
                    model='crm.team', res_id=team.id, partner_ids=user.partner_id.ids,
                    subject=_('%s overdue follow-ups', len(leads)), body=table(leads, user.tz))
        managers = team._snaphomz_managers() if team else self.env['res.users']
        if managers:
            Thread.message_notify(
                model='crm.team', res_id=team.id, partner_ids=managers.partner_id.ids,
                subject=_('Team overdue follow-ups: %s', len(overdue)),
                body=table(overdue.sorted(lambda l: (l.user_id.name or '', l.next_action_at)), managers[0].tz))

    @api.model
    def _cron_snaphomz_bra_expiry(self):
        now = fields.Datetime.now()
        expired = self.sudo().with_context(active_test=False).search([
            ('bra_status', '=', 'active'), ('bra_expires_at', '!=', False), ('bra_expires_at', '<=', now)])
        for lead in expired:
            lead.with_context(snaphomz_skip_validation=True, snaphomz_origin='automation').write(
                {'bra_status': 'expired', 'bra_ended_at': lead.bra_expires_at})
            lead.message_post(body=html_escape(_('BRA %s expired.', lead.bra_reference or '')),
                              subtype_xmlid='mail.mt_note')
