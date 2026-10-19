# Operations runbook

## Daily during the first live week

* **Manager › Unassigned intake** and **Overdue by owner**: clear or reassign.
* **Manager › Intake review**: resolve identity conflicts (*Resolve identity* → existing
  buyer or different person). The event is reprocessed once.
* **Manager › Failed integrations** and **Failed Loops updates**: read the error, fix the
  cause, then *Replay* / *Retry*.
* **Unmatched emails**: attach each to the right buyer or ignore it.
* Reconcile intake: compare the number of Meta leads in Meta Business Suite and website
  inquiries in the website admin with **CRM › Integrations › Inbound events** for the day.
  The *Meta daily reconciliation* workflow re-submits anything missed automatically.

## Failure and replay

| Symptom | What happens automatically | What to do |
|---|---|---|
| Odoo down or slow | Website/n8n get non-2xx and retry; Loops retries its webhook for ~28 h; the Loops worker keeps entries pending | Restore service. Nothing to replay unless retries were exhausted. |
| Processing error on an event | Event stays *pending* and is retried at 1, 2, 5, 15, 60, 240 min; then *failed* and the technical owner is notified | Fix the cause (bad payload, configuration), then *Replay* in Failed integrations. |
| Identity conflict | Event goes to *Intake review*; managers notified | Resolve identity. |
| Loops API outage / 429 / 5xx | Queue entry retries with exponential backoff (up to 8 attempts) | None unless it ends *failed*: then *Retry*. |
| Loops 4xx (e.g. unknown property) | Entry *failed*, technical owner notified | Fix the property in Loops, then *Retry*. |
| Meta token or permission failure | n8n execution errors; *Integration error alert* records it in Odoo and notifies | Reconnect the credential; reconciliation catches up the next morning, or run it manually. |
| n8n down | Meta retries its webhook; reconciliation recovers the rest; Loops queue waits in Odoo | Restart n8n. |

To pause an automation: deactivate the n8n workflow (the Odoo queue keeps building and is
sent later), or deactivate the Odoo scheduled action. Use the CSV import or manual updates
meanwhile; nothing is lost.

## Rollback

Roll back the application only with a matching database + filestore backup, or a tested
compatible migration. Never restore over newer buyer activity blindly: if buyers were
worked since the backup, export those records first or prefer a forward fix.

1. Take a fresh backup (`scripts/backup.sh`).
2. Check out the previous tag, `docker compose up -d odoo`, run
   `odoo -u snaphomz_crm` if the add-on version changed.
3. If data must go back too: `scripts/restore.sh <archive> snaphomz` with `NEUTRALIZE=0`
   (production restore keeps mail and crons on). Without `NEUTRALIZE=0` the restored
   database is neutralised for testing.

## Backup and restore

* `scripts/backup.sh`: Odoo DB + filestore, n8n DB + data, `.env` and config, GPG-encrypted,
  copied off-server, 14 copies kept.
* `scripts/restore.sh <archive> [target_db]`: restores into this stack (test environment).
  Verify: sign in, open a buyer with attachments, open n8n and check credentials decrypt.

## Staff access (Microsoft sign-in)

* **New starter**: add them to the *Snaphomz CRM users* group in Entra, then create the CRM
  user with login = their Microsoft email and the right sales role. They click **Sign in
  with Microsoft**; the account links on first use.
* **Leaver**: disable or unassign them in Entra (stops new sign-ins immediately) **and**
  archive the CRM user (ends their open CRM sessions). Reassign their buyers first:
  Manager › All active buyers, group by salesperson.
* **"This CRM user is linked to a different Microsoft account"**: an administrator clears
  *Microsoft account ID* on the user form (Settings › Users) so it re-links on next sign-in.
* **Microsoft sign-in broken** (expired client secret, Entra outage): sign in as the
  break-glass admin at `/web/login?local=1`, fix the secret in Settings › CRM, or untick
  *Require Microsoft sign-in* temporarily. If the admin password is lost too:

```bash
docker compose run --rm --no-deps -T odoo odoo shell --config=/etc/odoo/odoo.conf -d snaphomz --no-http <<< "env['ir.config_parameter'].sudo().set_param('snaphomz_crm.sso_enforce', False); env.cr.commit()"
```

## Secrets and rotation

| Secret | Where | Rotate |
|---|---|---|
| Integration API key | Secret store, n8n credential, website backend | Yearly (expires); revoke in the integration user's preferences |
| Loops API key | Secret store, n8n credential | On staff change |
| Loops signing secret | Odoo settings | After rotating in Loops, enter old and new separated by a space for 24 h |
| Meta tokens | n8n credentials | Per Meta policy / on owner change |
| Entra client secret | Secret store, Odoo Settings › CRM › Microsoft sign-in | Before it expires (max 24 months): add a new secret in Entra, paste it in Odoo, test, then delete the old one |
| Break-glass admin password | Secret store only | Yearly and after every use |
| DB passwords, `N8N_ENCRYPTION_KEY` | `.env` + secret store | Encryption key: never rotate without re-entering credentials |

## Useful commands

```bash
docker compose logs -f --since 10m odoo
```

```bash
docker compose run --rm --no-deps odoo odoo --config=/etc/odoo/odoo.conf -d snaphomz -u snaphomz_crm --workers=0 --stop-after-init
```

```bash
ODOO_URL=https://crm.snaphomz.com ODOO_API_KEY=... scripts/import_buyers.py buyers.csv --report dry-run.csv
```
