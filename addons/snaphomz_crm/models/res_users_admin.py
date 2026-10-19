from odoo import api, models


class ResUsersAdmin(models.Model):
    _inherit = 'res.users'

    @api.model
    def _snaphomz_grant_admin_full_access(self):
        """The `admin` account is the super administrator: every internal
        permission of every installed app. Runs on each install/upgrade so
        groups added by newly installed modules are granted too.

        Excluded: portal/public groups (incompatible with an internal user)
        and the integration service group (it would subject admin to the
        integration user's restrictions).
        """
        admin = self.env.ref('base.user_admin', raise_if_not_found=False)
        if not admin:
            return False
        Groups = self.env['res.groups'].sudo()
        external_roles = Groups.browse([
            self.env.ref(xmlid).id for xmlid in ('base.group_portal', 'base.group_public')
            if self.env.ref(xmlid, raise_if_not_found=False)])
        excluded = self.env.ref('snaphomz_crm.group_snaphomz_integration', raise_if_not_found=False)
        groups = Groups.search([('share', '=', False)]).filtered(
            lambda g: not (g.all_implied_ids & external_roles)) - (excluded or Groups)
        missing = groups - admin.sudo().all_group_ids
        if missing:
            admin.sudo().write({'group_ids': [(4, group.id) for group in missing]})
        # Odoo's onboarding tours start automatically for administrators and
        # click through the app menu, hijacking whatever page was opened.
        if 'tour_enabled' in admin._fields and admin.tour_enabled:
            admin.sudo().tour_enabled = False
        return True
