# Snaphomz CRM

Odoo 19 Community as the shared sales workspace for buyer acquisition, with Meta lead
forms, Snaphomz website inquiries and Loops connected through one intake path.
Implements the *Snaphomz Odoo CRM Implementation Plan* (19 October 2026).

```
 Meta Lead Ads ──► n8n (map) ──┐                               ┌──► Loops API (contact properties)
 Website backend ──────────────┼─► Odoo JSON-2 submit_intake ──┤        ▲
 CSV import script ────────────┘    (snaphomz_crm add-on:      │   n8n worker (claim / report)
                                     dedupe, identity, owner,  │
 Loops webhooks ──► n8n relay ──► /snaphomz/webhooks/loops     └──► outbound queue
 Sales mailbox ──► Odoo incoming mail ──► reply matching / unmatched queue
```

Odoo enforces every rule (identity matching, one active acquisition per person, required
next actions, suppression, human-only clocks). n8n only moves data.

The CRM carries Snaphomz branding (logo, colours, login page, browser tab, emails) and staff
sign in with their Snaphomz Microsoft account (Entra ID); password sign-in can be switched
off for everyone except a break-glass admin. Setup: `docs/deployment.md` §3a.

## Repository

| Path | What it is |
|---|---|
| `addons/snaphomz_crm/` | The single version-controlled add-on: fields, workflow, intake, Loops sync, security, views, reports, tests |
| `docker-compose.yml`, `config/odoo.conf`, `caddy/Caddyfile` | Pinned stack: Odoo 19.0-20261015, PostgreSQL 17.11 (separate servers for Odoo and n8n), n8n 2.43.8, Caddy 2.11.7 |
| `n8n/` | Workflow exports without secrets (Meta intake, Meta Page connection, Loops relay, Loops outbound, Meta reconciliation, error alert) and the generator that writes them |
| `scripts/` | Tests, dev bootstrap, API key, n8n import, Meta Page connection, backup/restore, CSV import, smoke test, sample data |
| `docs/` | Deployment, Meta lead ads setup, integration API, field dictionary, operations runbook, salesperson guide, acceptance status, decisions |

## Local quick start

```bash
cp .env.example .env
```

```bash
scripts/dev_setup.sh
```

This creates the database, installs the add-on, creates `manager@snaphomz.test` and
`sales@snaphomz.test` (generated passwords are written to `.env`), sets a test Loops secret
and an integration API key, and starts Odoo on http://localhost:8069 and n8n on
http://localhost:5678.

```bash
set -a; source .env; set +a; ODOO_URL=http://localhost:8069 ODOO_API_KEY="$DEV_API_KEY" scripts/seed_sample_buyers.py
```

## Tests

```bash
scripts/run_tests.sh
```

93 automated tests cover the acceptance checklist, branding and Microsoft sign-in (see
`docs/acceptance-checklist.md`).
`scripts/smoke_test.py` exercises the live HTTP paths, including simultaneous deliveries.

## Where things stand

Built and verified locally: the add-on, the stack, the n8n workflows (imported and run
against a mock Loops endpoint), backup and restore. Not done here because they need
production access: server/DNS, Meta app and forms, Loops account settings, the sales
mailbox, real staffed hours. See `docs/deployment.md` and `docs/decisions.md`.
