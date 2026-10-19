#!/usr/bin/env bash
# Daily encrypted backup: Odoo DB + filestore, n8n DB + data volume, config and
# secrets (.env). Encrypted with GPG for BACKUP_GPG_RECIPIENT and copied
# off-server with rclone to BACKUP_REMOTE (an rclone remote such as
# "offsite:bucket/path", or an absolute local path for a mounted disk).
# Keeps BACKUP_RETENTION_DAYS copies.
#
# Cron (as the deploy user):  15 3 * * * /opt/snaphomz-crm/scripts/backup.sh >> /var/log/snaphomz-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DEST="$WORK/snaphomz-crm-$STAMP"
mkdir -p "$DEST"

echo "[$STAMP] dumping Odoo database ${ODOO_DB_NAME}"
docker compose exec -T odoo-db pg_dump -U "$ODOO_DB_USER" -Fc "$ODOO_DB_NAME" > "$DEST/odoo.dump"

echo "[$STAMP] dumping n8n database ${N8N_DB_NAME}"
docker compose exec -T n8n-db pg_dump -U "$N8N_DB_USER" -Fc "$N8N_DB_NAME" > "$DEST/n8n.dump"

echo "[$STAMP] archiving Odoo filestore and n8n data"
docker compose exec -T odoo tar czf - -C /var/lib/odoo filestore/"$ODOO_DB_NAME" > "$DEST/odoo-filestore.tar.gz"
docker compose exec -T n8n tar czf - -C /home/node .n8n > "$DEST/n8n-data.tar.gz"

echo "[$STAMP] adding configuration and secrets"
cp .env "$DEST/env"
cp config/odoo.conf "$DEST/odoo.conf"
git rev-parse HEAD > "$DEST/git-revision" 2>/dev/null || true
docker compose images --format json > "$DEST/images.json" 2>/dev/null || docker compose images > "$DEST/images.txt"

ARCHIVE="$WORK/snaphomz-crm-$STAMP.tar.gz.gpg"
tar czf - -C "$WORK" "snaphomz-crm-$STAMP" | gpg --batch --yes --trust-model always \
  --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$ARCHIVE"

echo "[$STAMP] uploading to $BACKUP_REMOTE"
if [[ "$BACKUP_REMOTE" == /* ]]; then
  mkdir -p "$BACKUP_REMOTE"
  cp "$ARCHIVE" "$BACKUP_REMOTE/"
  find "$BACKUP_REMOTE" -name 'snaphomz-crm-*.tar.gz.gpg' -mtime "+${BACKUP_RETENTION_DAYS:-14}" -delete
else
  rclone copy "$ARCHIVE" "$BACKUP_REMOTE/"
  rclone delete --min-age "${BACKUP_RETENTION_DAYS:-14}d" --include 'snaphomz-crm-*.tar.gz.gpg' "$BACKUP_REMOTE/"
fi
echo "[$STAMP] done: $(basename "$ARCHIVE")"
