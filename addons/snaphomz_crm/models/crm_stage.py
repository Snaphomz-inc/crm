from odoo import fields, models

from .common import STAGE_CODES


class CrmStage(models.Model):
    _inherit = 'crm.stage'

    snaphomz_code = fields.Selection(
        STAGE_CODES, string='Acquisition milestone', copy=False,
        help="Business meaning of the stage, used by automations, reports and Loops.")

    def _snaphomz_get(self, code):
        return self.search([('snaphomz_code', '=', code)], order='sequence', limit=1)
