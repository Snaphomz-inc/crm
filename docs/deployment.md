# Deployment

Ordered steps for the implementation owner. Record the deployed versions and access
details in the handover as you go.

## 1. Server

* One VM, about 4 vCPU / 8 GB RAM / 80 GB SSD (starting estimate; watch usage and resize).
  Ubuntu 24.04 LTS, Docker Engine with the compose plugin, `gpg`, `rclone`, `git`.
* Firewall: allow 22 (restricted to the team's IPs), 80 and 443. Nothing else.
* DNS (subject to availability): `crm.snaphomz.com` and `hooks.snaphomz.com` → VM public IP.
* A separate **test** environment (a second VM, or a second checkout with another compose
  project name and hostnames) with synthetic data only.

## 2. Stack

```bash
git clone <repo> /opt/snaphomz-crm && cd /opt/snaphomz-crm
```

```bash
cp .env.example .env && chmod 600 .env
```

Fill `.env` with values from the secret store (`openssl rand -base64 32` for passwords and
`N8N_ENCRYPTION_KEY`). **Store `N8N_ENCRYPTION_KEY` in the secret store**: without it,
restored n8n credentials cannot be decrypted.

```bash
docker compose up -d --wait odoo-db n8n-db
```

```bash
docker compose run --rm --no-deps odoo odoo --config=/etc/odoo/odoo.conf -d snaphomz -i snaphomz_crm --workers=0 --stop-after-init
```

```bash
docker compose --profile proxy up -d
```

Caddy obtains HTTPS certificates automatically. Only these routes are public:
`https://crm.snaphomz.com` (Odoo, with the database manager blocked) and
`https://hooks.snaphomz.com/webhook/*` (n8n production webhooks). The n8n editor is
reachable only through an SSH tunnel:

```bash
ssh -L 5678:127.0.0.1:5678 deploy@crm.snaphomz.com
```

Pinned versions: Odoo `19.0-20261015`, PostgreSQL `17.11`, n8n `2.43.8`, Caddy `2.11.7`.
Upgrade deliberately: change the tag, run the test suite (`scripts/run_tests.sh`) against
the new image on the test environment, take a backup, then deploy.

## 3. Odoo configuration (as administrator)

1. Sign in at `https://crm.snaphomz.com` as `admin` (password `admin` on a new database):
   **change it immediately** to a long random password kept in the secret store (this is
   the break-glass account once Microsoft sign-in is required), and set the company
   country and timezone. Snaphomz name, logo and colours are applied on install.
2. **Users**: one named login per salesperson (*Sales: User: Own Documents Only*) and per
   manager (*Sales: User: All Documents*; add *Administrator* only for whoever configures
   stages). **The login must be the person's Microsoft work email** (e.g.
   `jane@snaphomz.com`): Microsoft sign-in links to it on first use. Never share logins.
   Add *Allow export* only to people who need exports.
3. **CRM › Configuration › Sales Teams › Buyer Acquisition**: team leader = sales manager;
   *Buyer intake* tab: designated intake salesperson, backup, staffed hours.
4. **Staffed hours**: edit the working-hours calendar *Snaphomz buyer coverage (CONFIRM
   BEFORE GO-LIVE)*: set the timezone, days and hours Antony and the sales owner agree,
   and add public holidays as global time off. Then enable the scheduled action
   *Snaphomz: first-contact reminders and escalation* (Settings › Technical › Scheduled Actions).
5. **Settings › CRM › Snaphomz buyer intake**: Loops webhook secret, new-Loops-contact
   policy, registrations rule, default phone country, technical owner.
6. **Outgoing mail**: Settings › Technical › Outgoing Mail Servers (the sales mailbox's
   SMTP). Set the catch-all/bounce aliases and the company email domain.
7. **Incoming mail** (reply matching): Settings › Technical › Incoming Mail Servers. Add the
   monitored sales mailbox (IMAP, SSL) with *Create a New Record* = **Sales mailbox email**.
   Replies to emails sent from Odoo thread onto the buyer automatically; other mail (e.g.
   Loops campaign replies) is matched by sender, or lands in **Manager › Unmatched emails**.
8. Confirm background jobs run: Settings › Technical › Scheduled Actions shows recent
   *last run* times for *process pending inbound events* (every minute).
9. Integration key:

```bash
scripts/create_integration_key.sh
```

Put the key in the secret store, the n8n credential (below) and the website backend.
It expires after one year: rotate before then.

## 3a. Microsoft sign-in (Entra ID), Snaphomz accounts only

Needs a Microsoft Entra administrator. In the Entra admin center:

1. **App registrations › New registration**: name *Snaphomz CRM*; supported account types
   **Accounts in this organizational directory only (single tenant)**; redirect URI
   platform **Web**: `https://crm.snaphomz.com/snaphomz/auth/entra/callback` (Odoo shows
   the exact value under Settings › CRM › Microsoft sign-in).
2. Copy the **Application (client) ID** and **Directory (tenant) ID**.
3. **Certificates & secrets › New client secret** (24 months). Copy the secret *Value*
   into the secret store. Put a reminder to rotate it before it expires: sign-in stops
   working on expiry (the break-glass admin still works).
4. **Token configuration › Add optional claim › ID**: `email`, `upn` and `acct` (lets the
   CRM recognise and refuse guest accounts explicitly).
5. **API permissions**: Microsoft Graph delegated `openid`, `profile`, `email`
   (`User.Read` is fine to keep) → **Grant admin consent**.
6. **Enterprise applications › Snaphomz CRM › Properties**: **Assignment required = Yes**;
   **Users and groups**: assign a *Snaphomz CRM users* group. Only assigned staff can get
   a token at all.
7. Optional, recommended: a Conditional Access policy requiring MFA for this app.

In Odoo (Settings › CRM › Microsoft sign-in): enable it, enter the tenant ID, client ID,
client secret and allowed domains (`snaphomz.com`), save, then sign out and test
**Sign in with Microsoft** with a real staff account. Only when that works, tick
**Require Microsoft sign-in**. From then on:

* Everyone signs in with Microsoft; passwords and passkeys are refused (API keys for
  scripts and the integration user keep working).
* Break-glass logins (default `admin`) sign in with a password at
  `https://crm.snaphomz.com/web/login?local=1`.
* New users get no "set your password" email: tell them to sign in with Microsoft.

What the CRM checks on every Microsoft sign-in: the Snaphomz tenant, that the token was
issued to this app, a one-time nonce and PKCE (no replay), that the account is a member
(not a guest), that its email is on an allowed domain, and that a CRM user with that
email already exists and is active. Nobody is created automatically.

## 4. n8n

```bash
scripts/import_n8n_workflows.sh
```

In the editor (via the SSH tunnel), create the owner account, then credentials:

| Credential | Type | Value |
|---|---|---|
| Odoo integration API key | Header Auth | name `Authorization`, value `bearer <integration key>` |
| Loops API key | Header Auth | name `Authorization`, value `Bearer <Loops API key>` |
| Meta Lead Ads | Facebook Lead Ads OAuth2 | Meta app client ID/secret; connect as the lead-access owner |
| Meta Graph API (system user) | Facebook Graph API | long-lived system-user token with `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `ads_read` |

Open each workflow, attach the credentials, then activate:

* **Meta Lead Ads -> Odoo intake**: one copy per live form (duplicate the workflow, set page
  and form). Test with Meta's Lead Ads Testing Tool, then one genuine live submission.
  Record the delivery latency (target: under two minutes).
* **Meta daily reconciliation**: list every live form ID in *Forms to check*.
* **Odoo -> Loops contact properties**: activate after the Loops properties exist.
* **Loops webhook relay**: activate only if Loops events must also reach another system;
  otherwise point Loops straight at Odoo (below) and leave it inactive. If you use it, set
  the existing consumer's URL in the disabled node and enable that node.
* **Integration error alert**: activate; the other workflows already name it as their
  error workflow.

## 5. Meta

Marketing supplies the Business, Page and form inventory and the lead-access owner. The
engineer verifies: the Meta app is live (not development mode) with *Leads Retrieval*
approved, the page is connected to the app and the CRM access in *Lead Access Manager*
includes the app/system user, and each form is reachable with the token. Keep the CSV
route (`scripts/import_buyers.py`) for interruptions.

## 6. Loops

1. **Check the existing webhook endpoint first** (Loops allows one). If another system uses
   it, keep it working through the n8n relay. Otherwise set the endpoint to
   `https://crm.snaphomz.com/snaphomz/webhooks/loops`. Subscribe to contact, sending,
   delivery, click, open, bounce, spam and unsubscribe events. Copy the signing secret into
   Odoo settings.
2. Create the contact properties: `crmPersonId` (string), `buyerStage` (string),
   `buyerReadiness` (string), `salesOwnerName` (string), `consultationBooked` (boolean),
   `braSigned` (boolean), `salesSequenceEligible` (boolean).
3. Sequences: add audience filters / exit conditions so that booking-request emails exit on
   `consultationBooked = true`, representation-request emails exit on `braSigned = true`,
   nurture sends only to `buyerStage = nurture`, and every sales sequence requires
   `salesSequenceEligible = true`. A property only works if the sequence checks it: test each exit.
4. Set the reply-to of relevant campaigns to the monitored sales mailbox.

## 7. Website backend

Send server-side `submit_intake` calls after an inquiry, consultation request, confirmed
booking, BRA event and (if agreed) registration. See `docs/integration-api.md`. Persist
failed deliveries and retry on non-2xx.

## 8. Backups and monitoring

```bash
crontab -e   # 15 3 * * * /opt/snaphomz-crm/scripts/backup.sh >> /var/log/snaphomz-backup.log 2>&1
```

Configure `rclone config` for the off-server destination and import the backup GPG public
key (the private key stays offline / in the secret store). Before launch, restore into the
test environment with `scripts/restore.sh` and record the evidence.

Monitor: HTTPS uptime of `https://crm.snaphomz.com/web/login` and
`https://hooks.snaphomz.com/webhook/` (404 expected = up), disk space, the daily backup log,
**Manager › Failed integrations**, **Failed Loops updates** and the n8n executions list.
