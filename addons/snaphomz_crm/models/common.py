"""Shared constants and small helpers for the Snaphomz CRM add-on."""
from datetime import datetime, timezone

from odoo.tools import email_normalize

BUYER_STATUSES = [
    ('new', 'New'),
    ('attempting', 'Attempting contact'),
    ('connected', 'Connected'),
    ('qualified', 'Qualified'),
    ('nurture', 'Nurture'),
    ('lost', 'Unqualified or lost'),
]
# Statuses that require a dated next action.
ACTIVE_STATUSES = ('new', 'attempting', 'connected', 'qualified')

READINESS = [
    ('ready_now', 'Ready now'),
    ('needs_preparation', 'Needs preparation'),
    ('exploring', 'Exploring'),
    ('unqualified', 'Unqualified'),
]

OUTCOMES = [
    ('no_answer', 'No answer'),
    ('voicemail', 'Voicemail'),
    ('spoke', 'Spoke'),
    ('requested_callback', 'Requested callback'),
    ('wrong_details', 'Wrong details'),
    ('do_not_contact', 'Do not contact'),
]
# Outcomes that prove a two-way conversation with the buyer took place.
TWO_WAY_OUTCOMES = ('spoke', 'requested_callback')
# Outcomes where nobody was reached; the default next action is a retry.
RETRY_OUTCOMES = ('no_answer', 'voicemail')

STAGE_CODES = [
    ('qualified', 'Qualified'),
    ('consultation_booked', 'Consultation booked'),
    ('consultation_completed', 'Consultation completed'),
    ('bra_sent', 'BRA sent'),
    ('bra_signed', 'BRA signed'),
]

PROVIDERS = [
    ('meta', 'Meta Lead Ads'),
    ('website', 'Snaphomz website'),
    ('signing', 'Signing system'),
    ('import', 'Import'),
    ('loops', 'Loops'),
    ('n8n', 'n8n workflow'),
]
INTAKE_PROVIDERS = ('meta', 'website', 'signing', 'import')

# Intake event types and what they mean for sales.
LEAD_EVENT_TYPES = ('lead_form', 'inquiry', 'consultation_request', 'consultation_booked')
CONSULTATION_EVENT_TYPES = ('consultation_booked', 'consultation_completed', 'consultation_cancelled')
BRA_EVENT_TYPES = ('bra_sent', 'bra_signed', 'bra_cancelled', 'bra_expired')
INTAKE_EVENT_TYPES = (
    LEAD_EVENT_TYPES
    + ('registration', 'newsletter_signup', 'consultation_completed', 'consultation_cancelled')
    + BRA_EVENT_TYPES
)

EMAIL_SUBSCRIPTION_STATUSES = [
    ('unknown', 'Unknown'),
    ('subscribed', 'Subscribed'),
    ('unsubscribed', 'Unsubscribed'),
    ('bounced', 'Hard bounced'),
    ('spam_complaint', 'Marked as spam'),
]
SUPPRESSED_EMAIL_STATUSES = ('unsubscribed', 'bounced', 'spam_complaint')


def normalize_email(value):
    """Lower-cased bare address, or False."""
    if not value or not isinstance(value, str):
        return False
    return email_normalize(value.strip()) or False


def normalize_phone(env, value, country_code=None):
    """E.164 phone number, or False when it cannot be parsed."""
    if not value:
        return False
    value = str(value).strip()
    country = False
    if country_code:
        country = env['res.country'].search([('code', '=', country_code.upper())], limit=1)
    if not country:
        default_code = env['ir.config_parameter'].sudo().get_param('snaphomz_crm.default_country_code', 'US')
        country = env['res.country'].search([('code', '=', default_code)], limit=1)
    return env['res.partner']._phone_format_number(value, country=country, force_format='E164') or False


def parse_datetime(value):
    """Parse an ISO-8601 string or a Unix timestamp into a naive UTC datetime."""
    if value in (None, False, ''):
        return False
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, (int, float)):
        # Loops sends seconds; tolerate milliseconds.
        seconds = value / 1000 if value > 10_000_000_000 else value
        dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
    elif isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return parse_datetime(int(text))
        # Meta uses "+0000" offsets; fromisoformat needs "+00:00".
        if len(text) > 5 and text[-5] in '+-' and text[-4:].isdigit():
            text = f"{text[:-2]}:{text[-2:]}"
        dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
    else:
        raise ValueError(f"Unsupported datetime value: {value!r}")
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.replace(microsecond=0)


def clean_text(value, limit=None):
    if value in (None, False):
        return False
    text = str(value).strip()
    if not text:
        return False
    return text[:limit] if limit else text
