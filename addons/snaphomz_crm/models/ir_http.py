from odoo import models

# Landing page after sign-in for users without a personal Home Action,
# checked in order: first matching role wins.
ROLE_HOME_ACTIONS = (
    ('base.group_system', 'snaphomz_crm.action_all_active_buyers'),
    ('sales_team.group_sale_salesman_all_leads', 'snaphomz_crm.action_unassigned_intake'),
    ('sales_team.group_sale_salesman', 'snaphomz_crm.action_my_new_leads'),
)


class IrHttp(models.AbstractModel):
    _inherit = 'ir.http'

    def session_info(self):
        info = super().session_info()
        user = self.env.user
        if not info.get('home_action_id') and user and not user.share:
            for group, xmlid in ROLE_HOME_ACTIONS:
                action = self.env.ref(xmlid, raise_if_not_found=False)
                if action and user.has_group(group):
                    info['home_action_id'] = action.id
                    break
        return info
