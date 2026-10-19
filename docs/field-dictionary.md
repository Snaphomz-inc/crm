# Field dictionary

Models: `crm.lead` = the inquiry / acquisition record (one active per person),
`res.partner` = the person, `mail.activity` = follow-ups, `snaphomz.*` = integration and
history records. *Writer* says who may change a value.

## Person (`res.partner`)

| Field | Label | Type | Writer / notes |
|---|---|---|---|
| `snaphomz_person_uuid` | Person UUID | char, unique | Set once at first intake; sent to Loops as `crmPersonId` |
| `snaphomz_user_id` | Snaphomz user ID | char, unique | Intake (trusted) |
| `loops_contact_id` | Loops contact ID | char | Loops webhooks / sync result |
| `name`, `email`, `phone` | standard | | Intake fills blanks only; people edit |
| `tz` | Buyer timezone | selection | Intake / people |
| `preferred_contact_method` | Preferred contact method | phone, sms, email, whatsapp | Intake / people |
| `do_not_contact`, `do_not_contact_at` | Do not contact | bool, datetime | Log outcome *Do not contact* / people. Distinct from unsubscribe and bounce |
| `email_subscription_status` | Email subscription | unknown, subscribed, unsubscribed, bounced, spam_complaint | Loops events only; never changed by sales stages |
| `email_status_event_at` | Subscription status as of | datetime | Guards against delayed webhooks |
| `marketing_consent`, `consent_source`, `consent_at` | Consent | bool, char, datetime | Intake when supplied |
| `last_marketing_engagement_at` | Last marketing engagement | datetime | Loops clicks, buyer email replies |
| `last_email_open_at` | Last email open | datetime | Loops opens (weak signal) |
| `snaphomz_owner_user_ids` | Assigned salespeople | m2m (computed) | Drives contact visibility for salespeople |
| `loops_synced_payload`, `loops_synced_version` | Loops sync state | json, int | Outbound queue |

Identity keys (`snaphomz.identity.key`): `kind` (email / phone / snaphomz_user) + normalised
`value`, unique. Email in lower case; phone in E.164 (default country from settings).

## Acquisition (`crm.lead`)

| Group | Field | Type / values | Writer / notes |
|---|---|---|---|
| Identity | `acquisition_uuid` | char, unique | Created once; `merged_acquisition_uuids` keeps merged ones |
| | `person_uuid`, `snaphomz_user_id` | related | |
| Ownership | `user_id`, `team_id` | standard | Intake assigns only when unowned; managers reassign |
| Status | `buyer_status` | new, attempting, connected, qualified, nurture, lost | Log outcome / Qualify / Lost; history recorded |
| | `stage_id` (`stage_code`) | Qualified → Consultation booked → Consultation completed → BRA sent → BRA signed (won) | Opportunities only; evidence required |
| Origin (preserved) | `origin_provider`, `origin_event_type`, `origin_at` | | First intake only |
| | `origin_source/medium/campaign/content/term`, `origin_landing_page`, `origin_referrer` | char | Raw UTM values as captured |
| | `source_id`, `medium_id`, `campaign_id` | standard UTM | Mapped from the same values |
| | `origin_meta_page_id/form_id/campaign_id/adset_id/ad_id/lead_id` | char | Meta identifiers |
| Latest inquiry | `latest_inquiry_provider/source/campaign`, `latest_property_ref`, `latest_inquiry_at`, `latest_inquiry_text` | | Every intake |
| | `inquiry_ids`, `inquiry_count` | `snaphomz.inquiry` rows | Appended every intake |
| Buyer needs | `buyer_locations`, `home_type`, `budget_min`, `budget_max`, `monthly_payment_comfort`, `buying_timeline`, `tour_ready`, `financing_status`, `existing_representation` | | Forms fill blanks; people edit |
| Qualification | `buyer_readiness` | ready_now, needs_preparation, exploring, unqualified | People only (Qualify). Integration writes are refused |
| | `qualification_reason`, `qualified_at`, `qualified_by_id` | | Set with readiness |
| Progress | `last_outcome`, `last_outcome_at` | outcomes | Log outcome |
| | `lost_reason_id` | standard | Required when lost |
| | `nurture_reason_id`, `nurture_review_date` | | Required in nurture |
| Follow-up | `next_action`, `next_action_at` | char, datetime (UTC) | Required for new/attempting/connected/qualified; mirrors the earliest open activity |
| | `is_overdue`, `is_due_today`, `missing_next_action`, `waiting_for_buyer`, `attempts_exhausted` | computed | Views and filters |
| Human clocks | `first_human_attempt_at`, `last_human_attempt_at`, `last_two_way_contact_at`, `last_buyer_response_at`, `attempt_count` | | **Only** Log outcome (and a matched buyer email reply for `last_buyer_response_at`) |
| Service level | `sla_start_at`, `sla_owner_alert_at`, `sla_manager_alert_at`, `sla_*_alerted` | | Intake (staffed time) |
| Marketing | `email_subscription_status`, `do_not_contact`, `marketing_consent`, `last_marketing_engagement_at` | related | |
| | `sales_sequence_eligible` | bool | False when lost or do-not-contact |
| Consultation | `consultation_booked_at`, `consultation_at`, `consultation_completed_at`, `consultation_cancelled_at` | datetime | Website events / people |
| BRA | `bra_sent_at`, `bra_signed_at`, `bra_reference`, `bra_status` (none, sent, active, expired, cancelled), `bra_expires_at`, `bra_ended_at`, `bra_active` | | Signing events / people; signed = won |
| Review | `snaphomz_needs_review`, `snaphomz_review_note` | | Intake flags; managers clear |

## Activities (`mail.activity`)

`snaphomz_due_at` (exact due time). Activity types: *First contact*, *Call retry*,
*Buyer follow-up*. Date-only activities are due at the end of that day in the assignee's
timezone.

## Integration records

| Model | Purpose | Key fields |
|---|---|---|
| `snaphomz.inbound.event` | Durable event log | `provider` + `event_id` unique, `event_type`, `event_at`, `received_at`, `person_uuid`, `acquisition_uuid`, `partner_id`, `lead_id`, `state` (pending, done, review, failed, ignored), `attempts`, `next_attempt_at`, `error`, `payload` |
| `snaphomz.outbound.queue` | Loops updates | `partner_id`, `payload`, `version` (per buyer, monotonic), `state`, `attempts`, `next_attempt_at`, `last_status_code`, `last_error` |
| `snaphomz.inquiry` | Every inquiry | `lead_id`, `provider`, `event_type`, `inquiry_at`, `property_ref`, `message`, attribution |
| `snaphomz.stage.history` | Status / stage changes | `kind`, old/new status or stage, `changed_at`, `actor_id`, `origin` |
| `snaphomz.inbound.email` | Sales mailbox fallback | `email_from`, `lead_id`, `state` (matched, unmatched, attached, ignored), `owner_id` |
| `snaphomz.buyer.report` | Management report (SQL view) | one row per acquisition with cohort counts |
