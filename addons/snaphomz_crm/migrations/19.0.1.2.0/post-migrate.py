from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    """Snaphomz highlight colour changed from orange to lime (#d4f776)."""
    env = api.Environment(cr, SUPERUSER_ID, {})
    companies = env['res.company'].search([('secondary_color', '=', '#e8804c')])
    companies.write({'secondary_color': '#d4f776'})
