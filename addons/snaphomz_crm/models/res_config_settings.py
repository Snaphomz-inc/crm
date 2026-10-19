from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    snaphomz_loops_signing_secret = fields.Char(
        'Loops webhook signing secret', config_parameter='snaphomz_crm.loops_signing_secret',
        help="whsec_… value from Loops › Settings › Webhooks. During a rotation, enter both secrets separated by a space.")
    snaphomz_loops_contact_creation = fields.Selection([
        ('never', 'Only update existing Loops contacts'),
        ('consent', 'Create contacts with recorded marketing consent'),
        ('always', 'Create contacts for every buyer with an email'),
    ], string='New Loops contacts', default='consent', config_parameter='snaphomz_crm.loops_contact_creation')
    snaphomz_default_country_code = fields.Char(
        'Default phone country', default='US', config_parameter='snaphomz_crm.default_country_code',
        help="ISO country code used to normalise phone numbers given without a country prefix.")
    snaphomz_registration_creates_lead = fields.Boolean(
        'Registrations create sales leads', config_parameter='snaphomz_crm.registration_creates_lead',
        help="When off, website registrations update known buyers but never open a new sales lead.")
    snaphomz_technical_owner_id = fields.Many2one(
        'res.users', 'Technical owner', config_parameter='snaphomz_crm.technical_owner_id',
        domain="[('share', '=', False)]", help="Notified when an integration event fails permanently.")
