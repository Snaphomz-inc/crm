from odoo import SUPERUSER_ID, api

from odoo.addons.snaphomz_crm.hooks import apply_branding


def migrate(cr, version):
    """Existing databases get the Snaphomz branding when upgrading to 1.1."""
    apply_branding(api.Environment(cr, SUPERUSER_ID, {}))
