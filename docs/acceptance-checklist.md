# Acceptance checklist status

Evidence from the local build (19 October 2026): `scripts/run_tests.sh` → **93 tests, 0
failures** on Odoo 19.0-20261015 / PostgreSQL 17.11; `scripts/smoke_test.py` → all checks
passed against the running stack; n8n workflows imported and run against a mock Loops
endpoint; backup encrypted, restored into a separate database and verified.

QA must still run each item in the **test environment with real accounts** and record the
evidence below. Items marked *needs live access* cannot be completed without production
Meta, Loops or mailbox access.

| # | Test | Automated evidence | Still to do in test environment |
|---|---|---|---|
| 1 | Real Meta lead | `TestIntake.test_meta_lead_creates_one_assigned_buyer_and_task` | *Needs live access*: Meta testing tool + one genuine live-form submission; record latency |
| 2 | Repeat inquiry | `TestIntake.test_repeat_inquiry_website_then_meta`, `test_snaphomz_user_id_matches_before_email` | Repeat with the real website form and a Meta form |
| 3 | Event replay and concurrency | `test_replayed_event_is_ignored`, `TestMilestones.test_bra_signature_marks_won_once`; smoke test: 5 identical + 5 different simultaneous deliveries → 1 contact, 1 acquisition, 6 inquiries | Re-run `smoke_test.py` on the test server |
| 4 | Sales update | `TestOutcome.test_log_spoke`; verified in the browser (Log outcome → Attempting contact, retry proposed) | Salesperson and manager run it with their own logins |
| 5 | Required fields | `test_next_action_required_on_form_and_api_writes`, `TestApi.test_api_write_without_next_action_fails`, nurture/lost reason tests | Try in the form |
| 6 | Permissions | `TestPermissions` (search, direct read, export, contacts, attachments, messages, activities, reassignment) | Try direct URLs between two real rep logins |
| 7 | Loops sync and exits | `TestLoopsSync` (payload, coalescing, claim/report, marketing events never touch human clocks); n8n worker run against a mock | *Needs live access*: create properties, test sequence exits on booking and signature |
| 8 | Suppression | `test_do_not_contact_removes_sequence_eligibility`, `test_creation_policy`, phone-only test | Unsubscribe and bounce a test contact in Loops |
| 9 | Reply matching | `TestMailbox` (matched reply moved to buyer; unknown sender → owned unmatched queue) | *Needs live access*: reply to a real test campaign via the sales mailbox |
| 10 | Working hours | `TestWorkingHours` incl. the 1 Nov 2026 DST boundary and an out-of-hours / other-timezone buyer | Repeat once real staffed hours are entered |
| 11 | Failure and recovery | Retry/backoff and failed-state tests; smoke test simulated Loops outage; invalid signatures rejected (unit, route, and through the n8n relay) | Stop Odoo briefly while sending; confirm retries and single processing |
| 12 | History and reporting | `test_qualify_ready_now_converts_once`, `test_stage_history_records_actor_and_origin`, report counts in `test_bra_signature_marks_won_once` | Compare the report with the sample records |
| 13 | Backup restore | Local: encrypted backup → restore into `snaphomz_restore`; attachment checksum, manager login and 5 n8n workflows verified | Restore on the test server from the off-server copy |

## Added: branding and Microsoft sign-in

| # | Test | Automated evidence | Still to do in test environment |
|---|---|---|---|
| 14 | Snaphomz branding | `TestBranding`, `TestEntraFlow.test_login_page`; checked in the browser (login page, navbar, tab title, buttons) | Review on a phone and in a received email |
| 15 | Microsoft sign-in, Snaphomz accounts only | `TestEntraRules` (other tenant, other app, replayed nonce, expired, guest, non-Snaphomz domain, unknown/inactive/integration/portal users, one-time login token); `TestEntraFlow` (PKCE request, full sign-in, forged state, refused domain, token errors) | *Needs live access*: real Entra app; sign in as a member, a guest, an unassigned user and a personal Microsoft account |
| 16 | Password sign-in switched off | `test_enforcement_blocks_passwords_and_passkeys`; live check: salesperson password refused, break-glass admin allowed, smoke test (API keys) still passing | Repeat on the test server after enabling *Require Microsoft sign-in* |

Record every deferred issue with its workaround and named owner before production use.
