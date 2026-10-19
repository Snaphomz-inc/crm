#!/usr/bin/env bash
# Run the snaphomz_crm test suite in a throwaway database.
#   scripts/run_tests.sh                # all module tests
#   scripts/run_tests.sh TestIntake     # one class (or Class.test_method)
set -euo pipefail
cd "$(dirname "$0")/.."

DB=snaphomz_test
TAGS="/snaphomz_crm"
if [[ $# -gt 0 ]]; then
  TAGS="/snaphomz_crm:$1"
fi

docker compose up -d --wait odoo-db >/dev/null
docker compose exec -T odoo-db dropdb -U "${ODOO_DB_USER:-odoo}" --if-exists "$DB"
docker compose run --rm --no-deps odoo odoo --config=/etc/odoo/odoo.conf \
  -d "$DB" --db-filter='.*' -i snaphomz_crm --workers=0 --max-cron-threads=0 \
  --test-enable --test-tags "$TAGS" --log-level=test --stop-after-init
