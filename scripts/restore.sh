#!/usr/bin/env bash
# Restore a backup made by backup.sh into THIS stack (run it on the test
# environment). Never run against production with newer buyer activity
# unless you intend to lose it.
#
#   scripts/restore.sh snaphomz-crm-20261019T031500Z.tar.gz.gpg [target_odoo_db]
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

ARCHIVE="${1:?usage: restore.sh <archive.tar.gz.gpg> [target_db]}"
TARGET_DB="${2:-$ODOO_DB_NAME}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ ! -f "$ARCHIVE" && "$BACKUP_REMOTE" == /* ]]; then
  ARCHIVE="$BACKUP_REMOTE/$ARCHIVE"
elif [[ ! -f "$ARCHIVE" ]]; then
  rclone copy "$BACKUP_REMOTE/$ARCHIVE" "$WORK/"
  ARCHIVE="$WORK/$(basename "$ARCHIVE")"
fi
gpg --batch --decrypt "$ARCHIVE" | tar xzf - -C "$WORK"
SRC="$(find "$WORK" -maxdepth 1 -type d -name 'snaphomz-crm-*' | head -1)"
SOURCE_DB="$(grep '^ODOO_DB_NAME=' "$SRC/env" | cut -d= -f2)"

read -r -p "Restore into Odoo database '$TARGET_DB' and replace n8n data on $(hostname)? Type RESTORE: " answer
[[ "$answer" == "RESTORE" ]] || { echo "aborted"; exit 1; }

echo "Stopping application containers"
docker compose stop odoo n8n

echo "Restoring Odoo database -> $TARGET_DB"
docker compose exec -T odoo-db dropdb -U "$ODOO_DB_USER" --if-exists "$TARGET_DB"
docker compose exec -T odoo-db createdb -U "$ODOO_DB_USER" "$TARGET_DB"
docker compose exec -T odoo-db pg_restore -U "$ODOO_DB_USER" -d "$TARGET_DB" --no-owner < "$SRC/odoo.dump"

echo "Restoring Odoo filestore"
# Unpack into a staging directory first so another database's filestore on
# this volume is never overwritten.
docker compose run --rm --no-deps -T --entrypoint sh odoo -c \
  "set -e; STAGE=/var/lib/odoo/.restore-\$\$; mkdir -p \$STAGE /var/lib/odoo/filestore; tar xzf - -C \$STAGE; \
   rm -rf /var/lib/odoo/filestore/$TARGET_DB; mv \$STAGE/filestore/$SOURCE_DB /var/lib/odoo/filestore/$TARGET_DB; rm -rf \$STAGE" \
  < "$SRC/odoo-filestore.tar.gz"

echo "Restoring n8n database and data"
docker compose exec -T n8n-db dropdb -U "$N8N_DB_USER" --if-exists "$N8N_DB_NAME"
docker compose exec -T n8n-db createdb -U "$N8N_DB_USER" "$N8N_DB_NAME"
docker compose exec -T n8n-db pg_restore -U "$N8N_DB_USER" -d "$N8N_DB_NAME" --no-owner < "$SRC/n8n.dump"
docker compose run --rm --no-deps -T --entrypoint sh n8n -c "find /home/node/.n8n -mindepth 1 -delete && tar xzf - -C /home/node" \
  < "$SRC/n8n-data.tar.gz"

if ! cmp -s <(grep '^N8N_ENCRYPTION_KEY=' "$SRC/env") <(grep '^N8N_ENCRYPTION_KEY=' .env); then
  echo "WARNING: N8N_ENCRYPTION_KEY differs from the backup. n8n credentials will not decrypt until"
  echo "         .env uses the key stored in the backup / secret store."
fi

if [[ "$TARGET_DB" != "$ODOO_DB_NAME" || "${NEUTRALIZE:-1}" == "1" ]]; then
  echo "Neutralising the restored database (no outgoing mail, crons off)"
  docker compose run --rm --no-deps -T odoo odoo neutralize --config=/etc/odoo/odoo.conf -d "$TARGET_DB"
fi

docker compose start odoo n8n
echo "Restore complete. Verify: logins, attachments on a buyer, n8n credentials and workflows."
