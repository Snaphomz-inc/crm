from odoo import fields, models, tools

from ..models.common import BUYER_STATUSES, PROVIDERS


class SnaphomzBuyerReport(models.Model):
    """One row per buyer acquisition (one per person), dated by first inquiry.

    Rates are computed from these counts within an intake cohort (filter on
    Intake date), so a buyer who inquires three times still counts once.
    """
    _name = 'snaphomz.buyer.report'
    _description = 'Buyer acquisition analysis'
    _auto = False
    _rec_name = 'lead_id'
    _order = 'intake_date desc'
    _depends = {
        'crm.lead': [
            'partner_id', 'user_id', 'team_id', 'origin_at', 'origin_provider', 'origin_source',
            'origin_campaign', 'origin_meta_form_id', 'source_id', 'campaign_id', 'buyer_status',
            'stage_id', 'lost_reason_id', 'nurture_reason_id', 'active', 'inquiry_count',
            'first_human_attempt_at', 'last_two_way_contact_at', 'type', 'consultation_booked_at',
            'consultation_completed_at', 'bra_sent_at', 'bra_signed_at', 'bra_status', 'next_action_at',
            'acquisition_uuid',
        ],
    }

    lead_id = fields.Many2one('crm.lead', 'Buyer acquisition', readonly=True)
    partner_id = fields.Many2one('res.partner', 'Buyer', readonly=True)
    user_id = fields.Many2one('res.users', 'Salesperson', readonly=True)
    team_id = fields.Many2one('crm.team', 'Sales team', readonly=True)
    intake_date = fields.Datetime('Intake date', readonly=True)
    origin_provider = fields.Selection(PROVIDERS + [('manual', 'Manual entry')], 'Original channel', readonly=True)
    origin_source = fields.Char('Original source', readonly=True)
    origin_campaign = fields.Char('Original campaign', readonly=True)
    origin_meta_form_id = fields.Char('Meta form', readonly=True)
    source_id = fields.Many2one('utm.source', 'UTM source', readonly=True)
    campaign_id = fields.Many2one('utm.campaign', 'UTM campaign', readonly=True)
    buyer_status = fields.Selection(BUYER_STATUSES, 'Lead status', readonly=True)
    stage_id = fields.Many2one('crm.stage', 'Stage', readonly=True)
    lost_reason_id = fields.Many2one('crm.lost.reason', 'Lost reason', readonly=True)
    nurture_reason_id = fields.Many2one('snaphomz.nurture.reason', 'Nurture reason', readonly=True)
    active = fields.Boolean(readonly=True)

    inquiry_count = fields.Integer('Inquiries', readonly=True)
    buyer_count = fields.Integer('Unique buyers', readonly=True)
    first_attempt_minutes = fields.Float('Minutes to first attempt', readonly=True, aggregator='avg')
    attempted_count = fields.Integer('Buyers attempted', readonly=True)
    two_way_count = fields.Integer('Buyers reached (two-way)', readonly=True)
    qualified_count = fields.Integer('Qualified buyers', readonly=True)
    consultation_booked_count = fields.Integer('Consultations booked', readonly=True)
    consultation_attended_count = fields.Integer('Consultations attended', readonly=True)
    bra_sent_count = fields.Integer('BRAs sent', readonly=True)
    bra_signed_count = fields.Integer('BRAs signed', readonly=True)
    bra_active_count = fields.Integer('Active BRAs', readonly=True)
    overdue_count = fields.Integer('Overdue next actions', readonly=True)
    nurture_count = fields.Integer('In nurture', readonly=True)
    lost_count = fields.Integer('Unqualified or lost', readonly=True)

    def init(self):
        tools.drop_view_if_exists(self.env.cr, self._table)
        self.env.cr.execute(f"""
            CREATE OR REPLACE VIEW {self._table} AS (
                SELECT
                    l.id AS id,
                    l.id AS lead_id,
                    l.partner_id,
                    l.user_id,
                    l.team_id,
                    COALESCE(l.origin_at, l.create_date) AS intake_date,
                    l.origin_provider,
                    l.origin_source,
                    l.origin_campaign,
                    l.origin_meta_form_id,
                    l.source_id,
                    l.campaign_id,
                    l.buyer_status,
                    l.stage_id,
                    l.lost_reason_id,
                    l.nurture_reason_id,
                    l.active,
                    l.inquiry_count,
                    1 AS buyer_count,
                    CASE WHEN l.first_human_attempt_at IS NOT NULL THEN
                        GREATEST(EXTRACT(EPOCH FROM (l.first_human_attempt_at - COALESCE(l.origin_at, l.create_date))) / 60.0, 0)
                    END AS first_attempt_minutes,
                    (l.first_human_attempt_at IS NOT NULL)::int AS attempted_count,
                    (l.last_two_way_contact_at IS NOT NULL)::int AS two_way_count,
                    (l.type = 'opportunity')::int AS qualified_count,
                    (l.consultation_booked_at IS NOT NULL)::int AS consultation_booked_count,
                    (l.consultation_completed_at IS NOT NULL)::int AS consultation_attended_count,
                    (l.bra_sent_at IS NOT NULL)::int AS bra_sent_count,
                    (l.bra_signed_at IS NOT NULL)::int AS bra_signed_count,
                    (l.bra_status = 'active')::int AS bra_active_count,
                    (l.active AND l.next_action_at < (NOW() AT TIME ZONE 'UTC'))::int AS overdue_count,
                    (l.buyer_status = 'nurture')::int AS nurture_count,
                    (l.buyer_status = 'lost')::int AS lost_count
                FROM crm_lead l
                WHERE l.acquisition_uuid IS NOT NULL
            )
        """)
