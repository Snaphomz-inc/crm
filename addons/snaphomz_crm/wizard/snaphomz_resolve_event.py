from odoo import _, fields, models
from odoo.exceptions import UserError


class SnaphomzResolveEvent(models.TransientModel):
    _name = 'snaphomz.resolve.event'
    _description = 'Resolve conflicting buyer identity'

    event_id = fields.Many2one('snaphomz.inbound.event', required=True, ondelete='cascade')
    conflict_partner_ids = fields.Many2many(related='event_id.conflict_partner_ids')
    review_reason = fields.Selection(related='event_id.review_reason')
    resolution = fields.Selection([
        ('existing', 'This inquiry belongs to an existing buyer'),
        ('new', 'This is a different person'),
    ], required=True, default='existing')
    partner_id = fields.Many2one('res.partner', 'Buyer', domain="[('snaphomz_person_uuid', '!=', False)]")

    def action_apply(self):
        self.ensure_one()
        if self.resolution == 'existing' and not self.partner_id:
            raise UserError(_("Choose the buyer this inquiry belongs to."))
        self.event_id.sudo().write({
            'forced_partner_id': self.partner_id.id if self.resolution == 'existing' else False,
            'force_new_person': self.resolution == 'new',
        })
        self.event_id.action_replay()
        return {'type': 'ir.actions.act_window_close'}
