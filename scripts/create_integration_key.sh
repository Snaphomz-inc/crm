#!/usr/bin/env bash
# Generate a 1-year API key for the "Snaphomz Integration" user.
# The key is printed once: store it in the secret store, then in the n8n
# "Odoo integration API key" credential (header Authorization = "bearer <key>")
# and in the website backend's secret configuration. Rotate yearly.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${1:-snaphomz}"
LABEL="${2:-n8n and website backend}"

docker compose run --rm --no-deps -T odoo odoo shell --config=/etc/odoo/odoo.conf -d "$DB" --no-http --log-level=warn <<PY
from datetime import datetime, timedelta
user = env.ref('snaphomz_crm.user_snaphomz_integration')
key = env['res.users.apikeys'].with_user(user).sudo()._generate(None, """$LABEL""", datetime.now() + timedelta(days=365))
env.cr.commit()
print('SNAPHOMZ_INTEGRATION_API_KEY=' + key)
PY
