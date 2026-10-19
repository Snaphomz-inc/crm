import base64
import logging

from odoo.tools import file_open

_logger = logging.getLogger(__name__)

BRAND = {
    'name': 'Snaphomz',
    'app_name': 'Snaphomz CRM',
    'primary_color': '#171717',
    'secondary_color': '#e8804c',
    'logo': 'snaphomz_crm/static/src/img/snaphomz-logo.png',
}

# Odoo's default rule lets "own documents" salespeople read every unassigned
# lead. Snaphomz salespeople may only see buyers assigned to them; unassigned
# intake is a manager queue.
PERMISSIVE_RULES = (
    'crm.crm_rule_personal_lead',
    'crm.crm_activity_report_rule_personal_activities',
)

DEFAULT_CRM_STAGES = (
    'crm.stage_lead1',
    'crm.stage_lead2',
    'crm.stage_lead3',
    'crm.stage_lead4',
)


def apply_branding(env):
    """Snaphomz name, logo and colours, without overwriting later customisation."""
    company = env.ref('base.main_company')
    vals = {
        'primary_color': BRAND['primary_color'],
        'secondary_color': BRAND['secondary_color'],
        # Email buttons: white text on Snaphomz black.
        'email_primary_color': '#FFFFFF',
        'email_secondary_color': BRAND['primary_color'],
    }
    if not company.name or company.name in ('My Company', 'YourCompany'):
        vals['name'] = BRAND['name']
    if company.uses_default_logo:
        with file_open(BRAND['logo'], 'rb') as logo:
            vals['logo'] = base64.b64encode(logo.read())
    company.write(vals)
    env['ir.config_parameter'].sudo().set_param('web.web_app_name', BRAND['app_name'])
    bot = env.ref('base.partner_root', raise_if_not_found=False)
    if bot and bot.name == 'OdooBot':
        bot.name = 'Snaphomz Bot'


def post_init_hook(env):
    apply_branding(env)
    for xmlid in PERMISSIVE_RULES:
        rule = env.ref(xmlid, raise_if_not_found=False)
        if rule:
            rule.active = False

    # Lead mode: inquiries start as leads and become opportunities once a
    # salesperson confirms readiness.
    env.ref('base.group_user').write({
        'implied_ids': [(4, env.ref('crm.group_use_lead').id)],
    })

    # Replace Odoo's generic pipeline with the buyer-acquisition stages when
    # the generic stages are still unused (fresh database).
    Lead = env['crm.lead'].with_context(active_test=False)
    for xmlid in DEFAULT_CRM_STAGES:
        stage = env.ref(xmlid, raise_if_not_found=False)
        if stage and not Lead.search_count([('stage_id', '=', stage.id)], limit=1):
            stage.unlink()
        elif stage:
            _logger.warning("Keeping default CRM stage %s: it is used by existing leads", xmlid)


def uninstall_hook(env):
    for xmlid in PERMISSIVE_RULES:
        rule = env.ref(xmlid, raise_if_not_found=False)
        if rule:
            rule.active = True
