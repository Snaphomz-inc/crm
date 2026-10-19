from odoo import fields, models

from .common import BUYER_STATUSES, PROVIDERS


class SnaphomzNurtureReason(models.Model):
    _name = 'snaphomz.nurture.reason'
    _description = 'Nurture reason'
    _order = 'sequence, id'

    name = fields.Char(required=True, translate=True)
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)


class SnaphomzInquiry(models.Model):
    """One row per buyer inquiry, appended on every intake."""
    _name = 'snaphomz.inquiry'
    _description = 'Buyer inquiry'
    _order = 'inquiry_at desc, id desc'
    _rec_name = 'display_label'

    lead_id = fields.Many2one('crm.lead', required=True, ondelete='cascade', index=True)
    partner_id = fields.Many2one('res.partner', ondelete='set null', index=True)
    user_id = fields.Many2one(related='lead_id.user_id', store=True, string='Salesperson')
    event_id = fields.Many2one('snaphomz.inbound.event', ondelete='set null', string='Inbound event')
    provider = fields.Selection(PROVIDERS, required=True)
    event_type = fields.Char(required=True)
    inquiry_at = fields.Datetime(required=True, index=True)
    property_ref = fields.Char('Property / listing')
    listing_url = fields.Char('Listing URL')
    message = fields.Text('Inquiry text')
    source = fields.Char()
    medium = fields.Char()
    campaign = fields.Char()
    meta_form_id = fields.Char('Meta form ID')
    meta_ad_id = fields.Char('Meta ad ID')
    landing_page = fields.Char()
    display_label = fields.Char(compute='_compute_display_label')

    def _compute_display_label(self):
        for inquiry in self:
            inquiry.display_label = ' · '.join(filter(None, [
                dict(PROVIDERS).get(inquiry.provider), inquiry.event_type, inquiry.property_ref]))


class SnaphomzStageHistory(models.Model):
    """Append-only log of business status/stage changes for duration and conversion reporting."""
    _name = 'snaphomz.stage.history'
    _description = 'Buyer stage history'
    _order = 'changed_at desc, id desc'

    lead_id = fields.Many2one('crm.lead', required=True, ondelete='cascade', index=True)
    user_id = fields.Many2one(related='lead_id.user_id', store=True, string='Salesperson')
    kind = fields.Selection([('status', 'Lead status'), ('stage', 'Opportunity stage')], required=True)
    old_status = fields.Selection(BUYER_STATUSES)
    new_status = fields.Selection(BUYER_STATUSES)
    old_stage_id = fields.Many2one('crm.stage', ondelete='set null')
    new_stage_id = fields.Many2one('crm.stage', ondelete='set null')
    changed_at = fields.Datetime(required=True, default=fields.Datetime.now, index=True)
    actor_id = fields.Many2one('res.users', string='Changed by', required=True, default=lambda self: self.env.user)
    origin = fields.Char(help="ui, integration, automation or the provider that caused the change")
