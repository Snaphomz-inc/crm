#!/usr/bin/env bash
# LOCAL / TEST ENVIRONMENT ONLY. Creates the database, installs snaphomz_crm,
# creates a test manager and salesperson, configures intake, sets a test
# Loops signing secret and writes generated credentials into .env
# (git-ignored). Then starts the stack and seeds synthetic buyers.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
DB="${ODOO_DB_NAME:-snaphomz}"

gen() { openssl rand -hex 12; }
setenv() {  # setenv KEY VALUE  -> add or replace in .env
  if grep -q "^$1=" .env; then sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; else echo "$1=$2" >> .env; fi
}
[[ -n "${DEV_ADMIN_PASSWORD:-}" ]] || { DEV_ADMIN_PASSWORD="$(gen)"; setenv DEV_ADMIN_PASSWORD "$DEV_ADMIN_PASSWORD"; }
[[ -n "${DEV_MANAGER_PASSWORD:-}" ]] || { DEV_MANAGER_PASSWORD="$(gen)"; setenv DEV_MANAGER_PASSWORD "$DEV_MANAGER_PASSWORD"; }
[[ -n "${DEV_SALES_PASSWORD:-}" ]] || { DEV_SALES_PASSWORD="$(gen)"; setenv DEV_SALES_PASSWORD "$DEV_SALES_PASSWORD"; }
[[ -n "${DEV_LOOPS_SECRET:-}" ]] || { DEV_LOOPS_SECRET="whsec_$(openssl rand -base64 32)"; setenv DEV_LOOPS_SECRET "$DEV_LOOPS_SECRET"; }

docker compose up -d --wait odoo-db n8n-db
docker compose stop odoo >/dev/null 2>&1 || true
docker compose run --rm --no-deps odoo odoo --config=/etc/odoo/odoo.conf -d "$DB" -i snaphomz_crm \
  --workers=0 --max-cron-threads=0 --stop-after-init --log-level=warn

OUT=$(docker compose run --rm --no-deps -T odoo odoo shell --config=/etc/odoo/odoo.conf -d "$DB" --no-http --log-level=warn <<PY
from datetime import datetime, timedelta
Users = env['res.users'].with_context(no_reset_password=True)
env.ref('base.user_admin').write({'password': "$DEV_ADMIN_PASSWORD", 'tz': 'America/New_York'})
def user(login, name, groups, password):
    u = Users.search([('login', '=', login)])
    vals = {'name': name, 'login': login, 'email': login, 'password': password, 'tz': 'America/New_York',
            'group_ids': [(6, 0, [env.ref(g).id for g in groups])]}
    return u.write(vals) and u if u else Users.create(vals)
manager = user('manager@snaphomz.test', 'Test Manager',
               ['sales_team.group_sale_salesman_all_leads', 'base.group_partner_manager', 'base.group_allow_export'],
               "$DEV_MANAGER_PASSWORD")
rep = user('sales@snaphomz.test', 'Test Salesperson',
           ['sales_team.group_sale_salesman', 'base.group_partner_manager'], "$DEV_SALES_PASSWORD")
team = env.ref('snaphomz_crm.team_buyer_acquisition')
team.write({'user_id': manager.id, 'snaphomz_intake_user_id': rep.id, 'member_ids': [(6, 0, [rep.id])]})
ICP = env['ir.config_parameter'].sudo()
ICP.set_param('snaphomz_crm.loops_signing_secret', "$DEV_LOOPS_SECRET")
ICP.set_param('snaphomz_crm.technical_owner_id', str(env.ref('base.user_admin').id))
integration = env.ref('snaphomz_crm.user_snaphomz_integration')
key = env['res.users.apikeys'].with_user(integration).sudo()._generate(None, 'local dev', datetime.now() + timedelta(days=30))
env.cr.commit()
print('DEV_API_KEY=' + key)
PY
)
setenv DEV_API_KEY "$(printf '%s\n' "$OUT" | sed -n 's/^DEV_API_KEY=//p' | tail -1)"
echo "Created users manager@snaphomz.test and sales@snaphomz.test (passwords in .env)."
docker compose up -d odoo n8n
echo "Odoo: http://localhost:8069  n8n editor: http://localhost:5678"
