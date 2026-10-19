"""Canonical buyer intake: normalise, identify the person, find the active
acquisition record, append the inquiry and assign only if unowned."""
import uuid

import pytz

from odoo import _, fields, models
from odoo.exceptions import UserError
from odoo.tools import html_escape

from .common import (
    BRA_EVENT_TYPES, CONSULTATION_EVENT_TYPES, LEAD_EVENT_TYPES,
    clean_text, normalize_email, normalize_phone, parse_datetime,
)

CONTACT_METHODS = ('phone', 'sms', 'email', 'whatsapp')
NEED_SELECTIONS = {
    'home_type': ('single_family', 'condo', 'townhouse', 'multi_family', 'land', 'other'),
    'buying_timeline': ('0_3', '3_6', '6_12', '12_plus', 'unknown'),
    'tour_ready': ('yes', 'soon', 'no'),
    'financing_status': ('cash', 'preapproved', 'prequalified', 'not_started', 'unknown'),
    'existing_representation': ('none', 'has_agent', 'unknown'),
}
NEED_NUMBERS = ('budget_min', 'budget_max', 'monthly_payment_comfort')


class SnaphomzInboundEventIntake(models.Model):
    _inherit = 'snaphomz.inbound.event'

    # ------------------------------------------------------------------
    # Normalisation
    # ------------------------------------------------------------------

    def _snaphomz_normalize_intake(self, payload):
        payload = payload or {}
        person = payload.get('person') or {}
        inquiry = payload.get('inquiry') or {}
        attribution = payload.get('attribution') or {}
        meta = attribution.get('meta') or {}
        consent = payload.get('consent') or {}
        needs = payload.get('buyer_needs') or {}
        booking = payload.get('consultation') or {}
        bra = payload.get('bra') or {}

        name = clean_text(person.get('name'), 255) or clean_text(' '.join(filter(None, [
            clean_text(person.get('first_name')), clean_text(person.get('last_name'))])), 255)
        tz = person.get('timezone')
        clean_needs = {}
        for key, allowed in NEED_SELECTIONS.items():
            if needs.get(key) in allowed:
                clean_needs[key] = needs[key]
        for key in NEED_NUMBERS:
            try:
                if needs.get(key) not in (None, ''):
                    clean_needs[key] = float(needs[key])
            except (TypeError, ValueError):
                pass
        if clean_text(needs.get('locations')):
            locations = needs['locations']
            clean_needs['buyer_locations'] = ', '.join(locations) if isinstance(locations, list) else clean_text(locations, 255)

        return {
            'provider': payload.get('provider'),
            'event_type': payload.get('event_type'),
            'event_at': parse_datetime(payload.get('event_time')) or fields.Datetime.now(),
            'acquisition_uuid': clean_text(payload.get('acquisition_uuid'), 64),
            'person_uuid': clean_text(person.get('person_uuid'), 64),
            'snaphomz_user_id': clean_text(person.get('snaphomz_user_id'), 128),
            'name': name,
            'email': normalize_email(person.get('email')),
            'raw_email': clean_text(person.get('email'), 255),
            'phone': normalize_phone(self.env, person.get('phone'), person.get('country_code')),
            'raw_phone': clean_text(person.get('phone'), 64),
            'tz': tz if tz in pytz.all_timezones_set else False,
            'preferred_contact_method': person.get('preferred_contact_method') if person.get('preferred_contact_method') in CONTACT_METHODS else False,
            'inquiry': {
                'property_ref': clean_text(inquiry.get('property_ref'), 255),
                'listing_url': clean_text(inquiry.get('listing_url'), 1024),
                'message': clean_text(inquiry.get('message'), 10000),
            },
            'attribution': {
                'source': clean_text(attribution.get('source'), 255),
                'medium': clean_text(attribution.get('medium'), 255),
                'campaign': clean_text(attribution.get('campaign'), 255),
                'content': clean_text(attribution.get('content'), 255),
                'term': clean_text(attribution.get('term'), 255),
                'landing_page': clean_text(attribution.get('landing_page'), 1024),
                'referrer': clean_text(attribution.get('referrer'), 1024),
                'meta_page_id': clean_text(meta.get('page_id'), 64),
                'meta_form_id': clean_text(meta.get('form_id'), 64),
                'meta_campaign_id': clean_text(meta.get('campaign_id'), 64),
                'meta_adset_id': clean_text(meta.get('adset_id'), 64),
                'meta_ad_id': clean_text(meta.get('ad_id'), 64),
                'meta_lead_id': clean_text(meta.get('lead_id'), 64),
            },
            'consent': {
                'marketing_email': consent.get('marketing_email') is True,
                'source': clean_text(consent.get('source'), 255),
                'captured_at': parse_datetime(consent.get('captured_at')),
            },
            'needs': clean_needs,
            'booking': {
                'start_at': parse_datetime(booking.get('start_at')),
                'booking_id': clean_text(booking.get('booking_id'), 128),
            },
            'bra': {
                'reference': clean_text(bra.get('agreement_id'), 128),
                'expires_at': parse_datetime(bra.get('expires_at')),
            },
            'answers': payload.get('answers') if isinstance(payload.get('answers'), dict) else {},
        }

    # ------------------------------------------------------------------
    # Identity
    # ------------------------------------------------------------------

    def _snaphomz_key_partner(self, kind, value):
        if not value:
            return self.env['res.partner']
        key = self.env['snaphomz.identity.key'].sudo().search([('kind', '=', kind), ('value', '=', value)], limit=1)
        return key.partner_id

    def _snaphomz_match_person(self, n):
        """Return (partner, conflict_partners, reason).

        Trusted Snaphomz user ID or person UUID first, then normalised email,
        then phone (only when it cannot contradict an email).
        """
        Partner = self.env['res.partner'].sudo()
        none = Partner.browse()
        if self.forced_partner_id:
            return self.forced_partner_id, none, 'resolved by manager'
        if self.force_new_person:
            return none, none, 'resolved as new person'

        by_user = Partner.search([('snaphomz_user_id', '=', n['snaphomz_user_id'])], limit=1) if n['snaphomz_user_id'] else none
        by_uuid = Partner.search([('snaphomz_person_uuid', '=', n['person_uuid'])], limit=1) if n['person_uuid'] else none
        by_email = self._snaphomz_key_partner('email', n['email'])
        by_phone = self._snaphomz_key_partner('phone', n['phone'])

        strong = by_user | by_uuid
        if len(strong) > 1:
            return none, strong, 'Snaphomz user ID and person UUID point to different buyers'
        if strong:
            if by_email and by_email != strong:
                return none, strong | by_email, 'email belongs to a different buyer than the Snaphomz user ID'
            if n['snaphomz_user_id'] and strong.snaphomz_user_id and strong.snaphomz_user_id != n['snaphomz_user_id']:
                return none, strong, 'buyer already has a different Snaphomz user ID'
            return strong, none, 'matched by Snaphomz ID'
        if by_email:
            if n['snaphomz_user_id'] and by_email.snaphomz_user_id and by_email.snaphomz_user_id != n['snaphomz_user_id']:
                return none, by_email, 'email belongs to a buyer with a different Snaphomz user ID'
            return by_email, none, 'matched by email'
        if by_phone:
            phone_owner_email = normalize_email(by_phone.email)
            if n['email'] and phone_owner_email and phone_owner_email != n['email']:
                return none, by_phone, 'phone belongs to a buyer with a different email'
            return by_phone, none, 'matched by phone'
        return none, none, 'new person'

    def _snaphomz_find_acquisition(self, partner, n):
        Lead = self.env['crm.lead'].sudo().with_context(active_test=False)
        if n.get('acquisition_uuid'):
            uid = n['acquisition_uuid']
            lead = Lead.search(['|', ('acquisition_uuid', '=', uid), ('merged_acquisition_uuids', 'ilike', uid)], limit=1)
            if lead:
                return lead
        if not partner:
            return Lead.browse()
        active = Lead.search([('partner_id', '=', partner.id), ('acquisition_uuid', '!=', False), ('active', '=', True)], limit=1)
        if active:
            return active
        return Lead.search([('partner_id', '=', partner.id), ('acquisition_uuid', '!=', False), ('active', '=', False)],
                           order='write_date desc, id desc', limit=1)

    def _snaphomz_upsert_person(self, partner, n):
        """Create the person or fill blanks; never overwrite existing contact details."""
        Partner = self.env['res.partner'].sudo()
        consent = n['consent']
        if not partner and self.force_new_person:
            # Manager confirmed a different person: identifiers held by another buyer stay with them.
            n = dict(n)
            if self._snaphomz_key_partner('email', n['email']):
                n['email'] = False
            if n['snaphomz_user_id'] and Partner.search_count([('snaphomz_user_id', '=', n['snaphomz_user_id'])]):
                n['snaphomz_user_id'] = False
        if not partner:
            vals = {
                'name': n['name'] or n['raw_email'] or n['raw_phone'] or _('Unknown buyer'),
                'email': n['email'] or False,
                'phone': n['phone'] or False,
                'tz': n['tz'] or False,
                'preferred_contact_method': n['preferred_contact_method'],
                'snaphomz_user_id': n['snaphomz_user_id'],
                'snaphomz_person_uuid': n['person_uuid'] or str(uuid.uuid4()),
            }
            if consent['marketing_email']:
                vals.update(marketing_consent=True, consent_source=consent['source'] or n['provider'],
                            consent_at=consent['captured_at'] or n['event_at'])
            return Partner.create(vals)

        vals = {}
        for fname, value in (('email', n['email']), ('phone', n['phone']), ('tz', n['tz']),
                             ('preferred_contact_method', n['preferred_contact_method']),
                             ('snaphomz_user_id', n['snaphomz_user_id'])):
            if value and not partner[fname]:
                vals[fname] = value
        if n['name'] and (not partner.name or partner.name in (partner.email, partner.phone, _('Unknown buyer'))):
            vals['name'] = n['name']
        if consent['marketing_email'] and not partner.marketing_consent:
            vals.update(marketing_consent=True, consent_source=consent['source'] or n['provider'],
                        consent_at=consent['captured_at'] or n['event_at'])
        if vals:
            partner.write(vals)
        partner._snaphomz_ensure_person()
        partner._snaphomz_sync_identity_keys()
        return partner

    # ------------------------------------------------------------------
    # Processing
    # ------------------------------------------------------------------

    def _snaphomz_process_intake(self):
        self.ensure_one()
        n = self._snaphomz_normalize_intake(self.payload)
        if not (n['email'] or n['phone'] or n['snaphomz_user_id'] or n['person_uuid'] or n['acquisition_uuid']):
            raise UserError(_("No usable identifier: provide an email, a phone number or a Snaphomz user ID."))

        partner, conflicts, reason = self._snaphomz_match_person(n)
        if conflicts:
            return {'state': 'review', 'review_reason': 'identity_conflict', 'summary': reason,
                    'conflict_partner_ids': conflicts.ids}

        lead = self._snaphomz_find_acquisition(partner, n)
        if lead and partner and lead.partner_id and lead.partner_id != partner:
            return {'state': 'review', 'review_reason': 'acquisition_conflict',
                    'summary': _('acquisition UUID belongs to another person'),
                    'conflict_partner_ids': (partner | lead.partner_id).ids}
        if not partner and lead.partner_id:
            partner = lead.partner_id

        event_type = n['event_type']
        if event_type in BRA_EVENT_TYPES or event_type in ('consultation_completed', 'consultation_cancelled'):
            if not lead:
                return {'state': 'review', 'review_reason': 'unknown_buyer',
                        'summary': _('%s for a buyer without an acquisition record', event_type)}
            summary = lead._snaphomz_apply_milestone(event_type, n, self)
            return {'state': 'done', 'summary': summary, 'partner_id': lead.partner_id.id, 'lead_id': lead.id}

        if not self._snaphomz_has_buyer_intent(event_type):
            # Newsletter sign-ups (and registrations unless enabled) never create sales leads.
            if partner:
                partner = self._snaphomz_upsert_person(partner, n)
                return {'state': 'done', 'summary': _('recorded on existing buyer; no sales lead'),
                        'partner_id': partner.id, 'lead_id': lead.id or False}
            return {'state': 'ignored', 'summary': _('no buyer intent; no sales lead created')}

        partner = self._snaphomz_upsert_person(partner, n)
        team = self.env['crm.team']._snaphomz_buyer_team()
        sla = self._snaphomz_sla_values(team, n['event_at'])
        repeat = False

        if not lead:
            lead = self._snaphomz_create_acquisition(partner, n, team, sla)
            summary = _('created buyer acquisition')
        elif not lead.active:
            if partner.do_not_contact:
                lead._snaphomz_append_inquiry(self, n)
                lead.write({
                    'snaphomz_needs_review': True,
                    'snaphomz_review_note': _('Do-not-contact buyer sent a new %s. Decide whether to reopen.', event_type),
                })
                self._snaphomz_notify_managers(
                    _("Do-not-contact buyer inquired again"),
                    _("%s sent a new inquiry. The record stays closed until a manager decides.", partner.display_name))
                return {'state': 'done', 'summary': _('inquiry from do-not-contact buyer flagged for review'),
                        'partner_id': partner.id, 'lead_id': lead.id}
            lead = lead.with_context(snaphomz_origin=self.provider,
                                     snaphomz_next_activity_type='snaphomz_crm.activity_type_first_contact')
            lead.action_unarchive()
            if not (lead.user_id and lead.user_id.active):
                lead.user_id = team._snaphomz_pick_intake_owner()
            lead.write(dict(sla, next_action=_('First contact'), next_action_at=sla['sla_owner_alert_at']))
            summary = _('reopened closed buyer acquisition')
        else:
            repeat = True
            summary = _('appended inquiry to existing acquisition')
            if not lead.user_id:
                owner = team._snaphomz_pick_intake_owner()
                if owner:
                    lead.user_id = owner

        lead._snaphomz_append_inquiry(self, n)
        lead._snaphomz_fill_needs(n['needs'])
        if repeat:
            lead._snaphomz_handle_repeat_inquiry(n, sla)
        if event_type == 'consultation_booked':
            lead._snaphomz_apply_milestone(event_type, n, self)
        if not lead.user_id:
            self._snaphomz_notify_managers(
                _("Unassigned buyer intake"),
                _("%s is in the unassigned intake queue: no intake salesperson is available.", lead.display_name))
        return {'state': 'done', 'summary': summary, 'partner_id': partner.id, 'lead_id': lead.id}

    def _snaphomz_has_buyer_intent(self, event_type):
        if event_type in LEAD_EVENT_TYPES:
            return True
        if event_type == 'registration':
            param = self.env['ir.config_parameter'].sudo().get_param('snaphomz_crm.registration_creates_lead', 'False')
            return param.lower() in ('1', 'true', 'yes')
        return False

    def _snaphomz_sla_values(self, team, event_at):
        """The staffed clock starts at the next staffed moment (after-hours inquiries
        wait for the opening). First contact is due when the owner reminder fires."""
        start = team._snaphomz_plan(max(event_at, fields.Datetime.now()), 0)
        return {
            'sla_start_at': start,
            'sla_owner_alert_at': team._snaphomz_plan(start, team.snaphomz_first_contact_minutes or 15),
            'sla_manager_alert_at': team._snaphomz_plan(start, team.snaphomz_escalation_minutes or 30),
            'sla_owner_alerted': False,
            'sla_manager_alerted': False,
        }

    def _snaphomz_create_acquisition(self, partner, n, team, sla):
        attribution = n['attribution']
        utm = self.env['utm.mixin'].sudo()
        owner = team._snaphomz_pick_intake_owner()
        vals = dict(sla, **{
            'name': partner.name or n['email'] or n['phone'],
            'type': 'lead',
            'partner_id': partner.id,
            'team_id': team.id,
            'user_id': owner.id or False,
            'buyer_status': 'new',
            'acquisition_uuid': n['acquisition_uuid'] or str(uuid.uuid4()),
            'next_action': _('First contact'),
            'next_action_at': sla['sla_owner_alert_at'],
            'origin_provider': n['provider'],
            'origin_event_type': n['event_type'],
            'origin_at': n['event_at'],
            'origin_source': attribution['source'],
            'origin_medium': attribution['medium'],
            'origin_campaign': attribution['campaign'],
            'origin_content': attribution['content'],
            'origin_term': attribution['term'],
            'origin_landing_page': attribution['landing_page'],
            'origin_referrer': attribution['referrer'],
            'origin_meta_page_id': attribution['meta_page_id'],
            'origin_meta_form_id': attribution['meta_form_id'],
            'origin_meta_campaign_id': attribution['meta_campaign_id'],
            'origin_meta_adset_id': attribution['meta_adset_id'],
            'origin_meta_ad_id': attribution['meta_ad_id'],
            'origin_meta_lead_id': attribution['meta_lead_id'],
        })
        source = attribution['source'] or {'meta': 'facebook', 'website': 'snaphomz.com'}.get(n['provider'])
        if source:
            vals['source_id'] = utm._find_or_create_record('utm.source', source).id
        if attribution['medium']:
            vals['medium_id'] = utm._find_or_create_record('utm.medium', attribution['medium']).id
        if attribution['campaign']:
            vals['campaign_id'] = utm._find_or_create_record('utm.campaign', attribution['campaign']).id
        vals.update({k: v for k, v in n['needs'].items()})
        return self.env['crm.lead'].sudo().with_context(
            snaphomz_intake=True, snaphomz_origin=n['provider'], mail_create_nosubscribe=True,
        ).create(vals)


class CrmLeadIntake(models.Model):
    _inherit = 'crm.lead'

    def _snaphomz_append_inquiry(self, event, n):
        self.ensure_one()
        attribution, inquiry = n['attribution'], n['inquiry']
        self.env['snaphomz.inquiry'].sudo().create({
            'lead_id': self.id,
            'partner_id': self.partner_id.id,
            'event_id': event.id,
            'provider': n['provider'],
            'event_type': n['event_type'],
            'inquiry_at': n['event_at'],
            'property_ref': inquiry['property_ref'],
            'listing_url': inquiry['listing_url'],
            'message': inquiry['message'],
            'source': attribution['source'],
            'medium': attribution['medium'],
            'campaign': attribution['campaign'],
            'meta_form_id': attribution['meta_form_id'],
            'meta_ad_id': attribution['meta_ad_id'],
            'landing_page': attribution['landing_page'],
        })
        if not self.latest_inquiry_at or n['event_at'] >= self.latest_inquiry_at:
            self.sudo().with_context(snaphomz_skip_validation=True).write({
                'latest_inquiry_provider': n['provider'],
                'latest_inquiry_source': attribution['source'] or n['provider'],
                'latest_inquiry_campaign': attribution['campaign'] or attribution['meta_campaign_id'],
                'latest_property_ref': inquiry['property_ref'],
                'latest_inquiry_at': n['event_at'],
                'latest_inquiry_text': inquiry['message'],
            })
        lines = [_('New %(type)s via %(provider)s', type=n['event_type'], provider=n['provider'])]
        if inquiry['property_ref']:
            lines.append(_('Property: %s', inquiry['property_ref']))
        if inquiry['message']:
            lines.append(inquiry['message'])
        for question, answer in (n['answers'] or {}).items():
            lines.append(f"{question}: {answer}")
        if n['raw_email'] and not n['email']:
            lines.append(_('Unusable email supplied: %s', n['raw_email']))
        if n['raw_phone'] and not n['phone']:
            lines.append(_('Unusable phone supplied: %s', n['raw_phone']))
        self.sudo().message_post(
            body='<br/>'.join(html_escape(line) for line in lines), subtype_xmlid='mail.mt_note')

    def _snaphomz_fill_needs(self, needs):
        """Form answers fill blanks only; a salesperson's entries win."""
        vals = {k: v for k, v in (needs or {}).items() if not self[k]}
        if vals:
            self.sudo().with_context(snaphomz_skip_validation=True).write(vals)

    def _snaphomz_handle_repeat_inquiry(self, n, sla):
        """Notify the owner and make sure the new inquiry gets a timely response."""
        self.ensure_one()
        owner = self.user_id or self.team_id.user_id
        if owner:
            self.sudo().message_notify(
                partner_ids=owner.partner_id.ids,
                subject=_('New inquiry from %s', self.partner_id.display_name),
                body=html_escape(_('%(buyer)s sent a new %(type)s. Their record already has an owner.',
                                   buyer=self.partner_id.display_name, type=n['event_type'])))
        due = sla['sla_owner_alert_at']
        if self.active and (not self.next_action_at or self.next_action_at > due):
            self.env['mail.activity'].sudo().create({
                'res_model_id': self.env['ir.model']._get_id('crm.lead'),
                'res_id': self.id,
                'activity_type_id': self.env.ref('snaphomz_crm.activity_type_first_contact').id,
                'summary': _('Respond to new inquiry'),
                'snaphomz_due_at': due,
                'date_deadline': self.env['mail.activity']._snaphomz_local_date(due, self._snaphomz_activity_owner()),
                'user_id': self._snaphomz_activity_owner().id,
            })

    def _snaphomz_apply_milestone(self, event_type, n, event):
        """Consultation and BRA events from the website / signing system. Idempotent."""
        self.ensure_one()
        lead = self.sudo().with_context(snaphomz_origin=n['provider'])
        Stage = self.env['crm.stage'].sudo()
        at = n['event_at']
        booking, bra = n['booking'], n['bra']

        if event_type == 'consultation_booked':
            vals = {'consultation_booked_at': lead.consultation_booked_at or at, 'consultation_cancelled_at': False}
            if booking['start_at']:
                vals['consultation_at'] = booking['start_at']
            lead.with_context(snaphomz_skip_validation=True).write(vals)
            if booking['start_at']:
                # A confirmed booking supplies the next action; obsolete call retries stop.
                lead._snaphomz_stop_contact_retries(_('Consultation booked'))
                lead.write({'next_action': _('Consultation'), 'next_action_at': booking['start_at']})
            if lead.type == 'opportunity' and lead.stage_code == 'qualified':
                lead.write({'stage_id': Stage._snaphomz_get('consultation_booked').id})
            return _('consultation booking recorded')

        if event_type == 'consultation_completed':
            lead.with_context(snaphomz_skip_validation=True).write({'consultation_completed_at': lead.consultation_completed_at or at})
            if lead.type == 'opportunity' and lead.stage_code in ('qualified', 'consultation_booked'):
                lead.write({'stage_id': Stage._snaphomz_get('consultation_completed').id})
            return _('consultation completion recorded')

        if event_type == 'consultation_cancelled':
            lead.with_context(snaphomz_skip_validation=True).write({'consultation_cancelled_at': at})
            owner = lead.user_id or lead.team_id.user_id
            if owner:
                lead.message_notify(partner_ids=owner.partner_id.ids, subject=_('Consultation cancelled'),
                                    body=html_escape(_('%s cancelled the consultation.', lead.partner_id.display_name)))
            return _('consultation cancellation recorded')

        if event_type == 'bra_sent':
            vals = {'bra_sent_at': lead.bra_sent_at or at}
            if bra['reference']:
                vals['bra_reference'] = lead.bra_reference or bra['reference']
            if lead.bra_status in ('none', 'cancelled', 'expired'):
                vals['bra_status'] = 'sent'
            lead.with_context(snaphomz_skip_validation=True).write(vals)
            if lead.type == 'opportunity' and lead.stage_code in ('qualified', 'consultation_booked', 'consultation_completed'):
                lead.write({'stage_id': Stage._snaphomz_get('bra_sent').id})
            return _('BRA sent recorded')

        if event_type == 'bra_signed':
            if not bra['reference']:
                raise UserError(_("bra_signed requires bra.agreement_id"))
            if lead.bra_signed_at and lead.bra_reference == bra['reference'] and lead.bra_status == 'active':
                return _('BRA signature already recorded')
            vals = {
                'bra_reference': bra['reference'],
                'bra_signed_at': at,
                'bra_sent_at': lead.bra_sent_at or at,
                'bra_status': 'active',
                'bra_expires_at': bra['expires_at'] or False,
                'bra_ended_at': False,
            }
            if not lead.active:
                lead.with_context(snaphomz_skip_validation=True).action_unarchive()
            if lead.type == 'lead':
                # A signed agreement is proof of qualification; the record becomes an opportunity once.
                vals.update(type='opportunity', buyer_status='qualified', date_conversion=fields.Datetime.now())
            vals['stage_id'] = Stage._snaphomz_get('bra_signed').id
            lead.with_context(snaphomz_qualifying=True, snaphomz_skip_validation=True).write(vals)
            lead.message_post(body=html_escape(_('BRA %s signed: acquisition won.', bra['reference'])),
                              subtype_xmlid='mail.mt_note')
            return _('BRA signature recorded; acquisition won')

        if event_type in ('bra_cancelled', 'bra_expired'):
            if bra['reference'] and lead.bra_reference and bra['reference'] != lead.bra_reference:
                raise UserError(_("Agreement %(ref)s does not match the recorded agreement %(current)s",
                                  ref=bra['reference'], current=lead.bra_reference))
            status = 'cancelled' if event_type == 'bra_cancelled' else 'expired'
            if lead.bra_status == status:
                return _('BRA status already recorded')
            lead.with_context(snaphomz_skip_validation=True).write({'bra_status': status, 'bra_ended_at': at})
            return _('BRA %s recorded', status)

        return _('no milestone change')

    def _snaphomz_stop_contact_retries(self, reason):
        retry_types = self.env.ref('snaphomz_crm.activity_type_first_contact') | self.env.ref('snaphomz_crm.activity_type_call_retry')
        for lead in self:
            obsolete = lead._snaphomz_open_followups().filtered(lambda a: a.activity_type_id in retry_types)
            if obsolete:
                obsolete.with_context(snaphomz_activity_sync=True).unlink()
                lead.message_post(body=html_escape(_('Stopped %(count)s contact follow-up(s): %(reason)s',
                                                     count=len(obsolete), reason=reason)),
                                  subtype_xmlid='mail.mt_note')
