from odoo import fields, models


class SnaphomzIdentityKey(models.Model):
    """Normalised identifiers that point at exactly one buyer contact.

    The unique (kind, value) index is the database-level guarantee that two
    concurrent intakes for the same email or user ID cannot both create a
    contact: the second insert fails and its event is retried.
    """
    _name = 'snaphomz.identity.key'
    _description = 'Buyer identity key'
    _rec_name = 'value'
    _order = 'kind, value'

    kind = fields.Selection([
        ('email', 'Email'),
        ('phone', 'Phone'),
        ('snaphomz_user', 'Snaphomz user ID'),
    ], required=True, index=True)
    value = fields.Char(required=True, index=True)
    partner_id = fields.Many2one('res.partner', required=True, ondelete='cascade', index=True)

    _kind_value_uniq = models.Constraint('UNIQUE(kind, value)', 'This identifier already belongs to a buyer.')
