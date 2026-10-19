#!/usr/bin/env bash
# Import (or update) the version-controlled workflows into n8n, and create empty
# placeholders for the credentials they use (existing credentials are never
# touched). Workflows are imported UNPUBLISHED, including ones that were live:
# publish them again afterwards (editor, or `n8n publish:workflow --id=...`),
# then restart n8n.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose cp n8n/workflows/. n8n:/tmp/snaphomz-workflows
docker compose exec -T n8n n8n import:workflow --separate --input=/tmp/snaphomz-workflows
docker compose exec -T -u root n8n rm -rf /tmp/snaphomz-workflows

existing="$(docker compose exec -T n8n-db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select id from credentials_entity"')"
placeholders="$(EXISTING="$existing" python3 - <<'PY'
import json, os
existing = set(os.environ["EXISTING"].split())
creds = [
    ("odoo-integration-key", "Odoo integration API key", "httpHeaderAuth", {"name": "Authorization", "value": ""}),
    ("loops-api-key", "Loops API key", "httpHeaderAuth", {"name": "Authorization", "value": ""}),
    ("meta-app", "Meta app (webhooks)", "facebookGraphAppApi", {"accessToken": "", "appSecret": ""}),
    ("meta-graph", "Meta Graph API (system user)", "facebookGraphApi", {"accessToken": ""}),
]
missing = [{"id": i, "name": n, "type": t, "data": d} for i, n, t, d in creds if i not in existing]
print(json.dumps(missing) if missing else "")
PY
)"
if [ -n "$placeholders" ]; then
  printf '%s' "$placeholders" | docker compose exec -T n8n sh -c \
    'cat > /tmp/snaphomz-creds.json && n8n import:credentials --input=/tmp/snaphomz-creds.json; rm -f /tmp/snaphomz-creds.json'
fi
