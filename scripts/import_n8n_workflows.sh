#!/usr/bin/env bash
# Import (or update) the version-controlled workflows into n8n. Workflows are
# imported inactive; attach credentials in the editor, then activate.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose cp n8n/workflows/. n8n:/tmp/snaphomz-workflows
docker compose exec -T n8n n8n import:workflow --separate --input=/tmp/snaphomz-workflows
docker compose exec -T -u root n8n rm -rf /tmp/snaphomz-workflows
