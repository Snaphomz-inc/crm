# Decisions, interpretations and open items

## Implementation choices

* **Odoo 19 Community** (`19.0-20261015`) as the plan proposes. Odoo 20 images were
  published on 15 October 2026; staying on 19 until 20 has matured and the add-on is tested
  against it.
* **PostgreSQL 17.11** for both databases (n8n 2.43 warns that 16 is outside its supported
  range; Odoo 19 needs 13+). Separate servers, users and volumes for Odoo and n8n.
* **Integration API** is Odoo 19's JSON-2 (`/json/2/<model>/<method>`, bearer API key), the
  supported external API in this release; XML-RPC/JSON-RPC are deprecated.
* **Loops webhooks are verified in Odoo**, not n8n, so the security check lives next to the
  data and is unit-tested. n8n only relays raw bodies when another consumer needs the events.
* **Meta leads use a Business system user** (decided 19 Oct 2026), not n8n's Facebook Lead
  Ads node: that node reads every lead with a personal Facebook sign-in, which Meta expires
  after about 60 days. n8n's generic Facebook Trigger receives the Page `leadgen` webhook
  (app ID and secret); the lead is then read from Meta with the Page token derived from the
  never-expiring system-user token. One workflow serves every Page and form the system user
  manages; the daily reconciliation discovers the forms itself. Website forms keep calling
  the intake API directly; Meta is the only source routed through n8n.
* **Concurrency**: events are stored first (unique provider + event ID), then processed;
  identity keys and "one active acquisition per person" are unique indexes. A losing
  concurrent transaction is deferred and retried by the minute job, so there are no duplicates.
* **Lead status vs stages**: a custom lead status for leads, Odoo opportunity stages for
  qualified buyers. Lost = Odoo's standard lost (archived with a reason).
* **Qualification is human-only**: the integration user cannot write readiness; the generic
  "Convert to opportunity" button is hidden for buyers in favour of **Qualify**.
* Odoo's default rule that lets salespeople see **unassigned** leads is disabled on install;
  contacts of other salespeople's buyers are hidden; a reassigned salesperson is unsubscribed
  from the buyer's conversation.
* Public sign-up on the login page is turned off (Odoo's default allows it).
* **Assignment is manager-controlled** (decided 19 Oct 2026): no automatic intake
  salesperson; inquiries wait in the Unassigned intake queue until a manager (currently
  Phani or Nrupen) assigns them. Only users with *Sales: All Documents* can create buyers or
  change the salesperson. Manager alerts go to the team leader plus every team member with
  manager access. Either manager can authorise; a two-person approval was not built.
* **Branding** comes from the Snaphomz web app: logo files from
  `Snaphomz-frontend-prod-prod-feature/public/assets/images` (`logo-01.svg`, recoloured for
  dark backgrounds) and the favicon. Snaphomz black `#171717` for the navbar and primary
  buttons, Snaphomz lime `#d4f776` as the highlight (navbar rule, the "CRM" label, the current
  status step), white backgrounds, and dark olive `#4b6600` for links. Lime has almost no
  contrast on white (1.2:1), so it is only used on black or behind black text (14.8:1).
  Odoo is themed through its own SCSS variables and view inheritance, so upgrades stay
  clean. Existing company name/logo are only replaced while they are still Odoo's defaults.
* **Web addresses** use `/app` instead of Odoo's `/odoo` (e.g. `/app/unassigned`,
  `/app/buyers/12`) through Odoo's documented router patch points; old `/odoo` links still
  work. After sign-in people land on their role's main list (salespeople: *My new leads*,
  managers: *Unassigned intake*, admin: *All active buyers*) unless they set a personal
  Home Action. `admin` holds every internal permission (re-granted on each upgrade) and
  Odoo's onboarding tours are off for it, because they hijack direct links.
* **Microsoft sign-in** is built into `snaphomz_crm` rather than using Odoo's `auth_oauth`:
  `auth_oauth` uses the implicit flow (tokens in the browser URL) and does not check which
  app a token was issued to. This implementation uses the authorization-code flow with
  PKCE and a client secret against the Snaphomz tenant only, validates tenant, audience,
  nonce, expiry, guest status and email domain, and only signs in users who already exist.

## Interpretations to confirm

| Topic | What was built | Who decides |
|---|---|---|
| First-contact due time | Due 15 staffed minutes after the inquiry (the owner-reminder threshold); after hours, 15 minutes after the next opening. Manager escalation at 30. | Antony / sales owner |
| Staffed hours | **Placeholder**: Mon–Fri 09:00–18:00 America/New_York. The reminder job is **disabled** until real hours are entered. | Antony / sales owner |
| New Loops contacts | Created only for buyers with recorded marketing consent (setting: never / consent / always). Existing Loops contacts are always updated. `subscribed` is never sent. | Marketing owner |
| Meta consent | A custom form question whose key contains "consent" and answer yes/true counts as marketing consent. | Marketing owner |
| Registrations | Do not create sales leads (setting). Inquiries, consultation requests/bookings and Meta forms do. | Antony |
| "Wrong details" outcome | Counts as an attempt and keeps the buyer active with "Verify contact details" as next action; close it with Lost if unreachable. | Sales owner |
| Do-not-contact buyer inquires again | Inquiry attached, record stays closed, flagged for manager review. Other lost buyers reopen automatically. | Antony |
| `buyerReadiness` / `buyerStage` values | Sent as codes (`ready_now`, `consultation_booked`, …) rather than labels, so renaming labels cannot break Loops filters. | Marketing owner |
| BRA signed without prior qualification | Treated as proof of readiness: converts once and marks won. | Sales owner |
| Active BRA count | `bra_status = active`; expires automatically at `bra_expires_at` when the signing system supplies it. | Sales owner |

## Known limitations (each needs a named owner)

| Limitation | Workaround |
|---|---|
| Not yet deployed: server, DNS, HTTPS, mailbox, Meta app, Loops settings need production access | `docs/deployment.md` |
| Live Meta, Loops-sequence-exit and real reply-matching tests not run (acceptance 1, 7, 8, 9 partly) | Run in the test environment |
| No automatic Dialpad call logging | Log outcome manually (by design for phase 1) |
| Campaign spend and cost per BRA not reported | Needs spend import and attribution rules |
| Conversion rates are shown as counts per cohort, not computed percentages | Divide by *Unique buyers* in the pivot; add charts once data is reliable |
| One buyer team and one staffed-hours calendar | Add teams/calendars when coverage expands |
| Merging two buyers moves inquiries/history and keeps both UUIDs, but identity keys of the removed contact are not re-pointed | Merge contacts with Odoo's contact merge as well, then re-save the email |
| Microsoft sign-in tested against a simulated Entra token endpoint only; no real tenant was available | Follow `docs/deployment.md` §3a and test with a real staff account before ticking *Require Microsoft sign-in* |
| With Microsoft sign-in required, staff cannot use Odoo screens that ask to re-enter a password (e.g. creating personal API keys) | Administrators do this from the break-glass account |
| Odoo sessions stay valid until they expire or the CRM user is archived; disabling someone in Entra alone does not end an open session | Offboarding = disable in Entra **and** archive the CRM user (`docs/operations.md`) |

Separately estimated follow-up work (out of scope): automatic Dialpad logging, AI scoring,
Meta conversion feedback, external-agent portals, transaction management.
