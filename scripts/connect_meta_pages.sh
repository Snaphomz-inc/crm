#!/usr/bin/env bash
# Connect every Facebook Page the Meta system user manages to the Snaphomz app
# (subscribes the Page to new-lead events) and list its lead forms. Safe to
# re-run: run it again whenever a Page is added. Prints only the summary: the
# workflow's other steps hold Page access tokens.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
# A one-off run needs its own task-runner port next to the running n8n.
docker compose exec -T -e N8N_RUNNERS_BROKER_PORT=5691 n8n \
  n8n execute --id=SnzMetaPages0001 --rawOutput >"$OUT" 2>/dev/null || true

python3 - "$OUT" <<'PY'
import json
import sys

raw = open(sys.argv[1]).read()
# n8n prints log lines first; the run result is the JSON object starting on its own line.
start = 0 if raw.startswith("{") else raw.find("\n{\n") + 1
if start <= 0 and not raw.startswith("{"):
    sys.exit("n8n returned no result. Is the workflow imported (scripts/import_n8n_workflows.sh)?")
run, _ = json.JSONDecoder().raw_decode(raw, start)
result = run["data"]["resultData"]
if result.get("error"):
    error = result["error"]
    detail = " ".join(filter(None, [error.get("message"), error.get("description")]))
    sys.exit(f"Failed at '{result.get('lastNodeExecuted')}': {detail}")
summary = result["runData"].get("Summary")
if not summary:
    sys.exit("The system user manages no Facebook Pages: assign the Page to it in Meta Business Settings.")
for item in summary[0]["data"]["main"][0]:
    page = item["json"]
    state = "subscribed to new leads" if page["subscribed_to_leads"] else "NOT subscribed (check the system user's Page access)"
    print(f"{page['page']}: {state}")
    for form in page["forms"] or ["(no lead forms yet)"]:
        print(f"  form: {form}")
PY
