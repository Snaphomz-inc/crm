{
    'name': 'Snaphomz CRM',
    'version': '19.0.1.1.0',
    'category': 'Sales/CRM',
    'summary': 'Buyer acquisition workflow, intake, Loops sync, Snaphomz branding and Microsoft sign-in',
    'description': """
Snaphomz buyer-acquisition CRM
==============================

* Buyer fields on leads and contacts (identity, origin, needs, qualification,
  human follow-up clocks, marketing suppression, BRA milestones).
* One canonical intake path for Meta Lead Ads, the Snaphomz website and imports,
  with durable, de-duplicated inbound events and identity matching.
* "Log outcome" action, required next actions and lead-status workflow.
* Loops webhook receiver (signature verified) and outbound property queue.
* Working-hours aware first-contact reminders, overdue digests and
  management views and reports.
* Snaphomz branding (logo, colours, login page, emails) and Microsoft Entra ID
  sign-in restricted to Snaphomz accounts.
""",
    'author': 'Snaphomz',
    'license': 'LGPL-3',
    'depends': [
        'web',
        'auth_signup',
        'crm',
        'mail',
        'resource',
        'utm',
        'phone_validation',
        'rpc',
    ],
    'data': [
        'security/snaphomz_security.xml',
        'security/ir.model.access.csv',
        'data/resource_calendar_data.xml',
        'data/crm_team_data.xml',
        'data/crm_stage_data.xml',
        'data/crm_lost_reason_data.xml',
        'data/snaphomz_nurture_reason_data.xml',
        'data/mail_activity_type_data.xml',
        'data/ir_config_parameter_data.xml',
        'data/res_users_data.xml',
        'data/ir_cron_data.xml',
        'wizard/snaphomz_log_outcome_views.xml',
        'wizard/snaphomz_qualify_views.xml',
        'wizard/snaphomz_resolve_event_views.xml',
        'views/crm_lead_views.xml',
        'views/res_partner_views.xml',
        'views/crm_team_views.xml',
        'views/snaphomz_integration_views.xml',
        'views/res_config_settings_views.xml',
        'views/res_users_views.xml',
        'views/snaphomz_branding_templates.xml',
        'report/snaphomz_buyer_report_views.xml',
        'views/snaphomz_menus.xml',
    ],
    'assets': {
        'web._assets_primary_variables': [
            ('before', 'web/static/src/scss/primary_variables.scss',
             'snaphomz_crm/static/src/scss/primary_variables.scss'),
        ],
        'web.assets_backend': [
            'snaphomz_crm/static/src/scss/snaphomz_backend.scss',
            'snaphomz_crm/static/src/xml/navbar.xml',
            'snaphomz_crm/static/src/js/title_service.js',
        ],
        'web.assets_frontend': [
            'snaphomz_crm/static/src/scss/snaphomz_frontend.scss',
        ],
    },
    'post_init_hook': 'post_init_hook',
    'uninstall_hook': 'uninstall_hook',
    'installable': True,
    'application': False,
}
