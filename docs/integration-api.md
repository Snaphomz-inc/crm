# Integration API

All integrations authenticate as the **Snaphomz Integration** user with an API key
(`scripts/create_integration_key.sh`). Keys never go to browsers: the website calls Odoo
from its backend only.

Odoo 19 JSON-2 endpoint: `POST https://crm.snaphomz.com/json/2/<model>/<method>`

| Header | Value |
|---|---|
| `Authorization` | `bearer <integration API key>` |
| `Content-Type` | `application/json` |
| `X-Odoo-Database` | `snaphomz` (optional with a single database) |

Errors return a non-2xx status with `{"name", "message", ...}`.

## 1. Submit an intake event (website backend, n8n, import)

`POST /json/2/snaphomz.inbound.event/submit_intake` with body `{"payload": {...}}`.

```json
{
  "payload": {
    "provider": "website",
    "event_type": "inquiry",
    "event_id": "web-inquiry-8f3c2a",
    "event_time": "2026-10-19T14:02:11Z",
    "acquisition_uuid": null,
    "person": {
      "snaphomz_user_id": "usr_123",
      "person_uuid": null,
      "first_name": "Jane",
      "last_name": "Buyer",
      "email": "jane@example.com",
      "phone": "+1 212 555 0101",
      "country_code": "US",
      "timezone": "America/New_York",
      "preferred_contact_method": "phone"
    },
    "inquiry": {"property_ref": "MLS-123", "listing_url": "https://snaphomz.com/homes/123", "message": "Is it available?"},
    "attribution": {
      "source": "google", "medium": "cpc", "campaign": "fall-buyers", "content": null, "term": null,
      "landing_page": "https://snaphomz.com/homes/123", "referrer": null,
      "meta": {"page_id": null, "form_id": null, "campaign_id": null, "adset_id": null, "ad_id": null, "lead_id": null}
    },
    "buyer_needs": {
      "locations": ["Austin, TX"], "home_type": "single_family", "budget_min": 300000, "budget_max": 450000,
      "monthly_payment_comfort": 2800, "buying_timeline": "0_3", "tour_ready": "soon",
      "financing_status": "preapproved", "existing_representation": "none"
    },
    "consent": {"marketing_email": true, "source": "website inquiry form", "captured_at": "2026-10-19T14:02:11Z"},
    "consultation": {"start_at": "2026-10-21T15:00:00Z", "booking_id": "B-77"},
    "bra": {"agreement_id": "AG-7", "expires_at": "2027-04-19T00:00:00Z"},
    "answers": {"Any question label": "raw answer"}
  }
}
```

Only `provider`, `event_type`, `event_id` and one identifier (email, phone, Snaphomz user ID,
person UUID or acquisition UUID) are required. Send what you have; omit the rest.

| Field | Values |
|---|---|
| `provider` | `website`, `meta`, `signing`, `import` |
| `event_type` | `inquiry`, `lead_form`, `consultation_request`, `consultation_booked` (create or update a sales lead); `registration` (lead only if the setting is on); `newsletter_signup` (never a lead); `consultation_completed`, `consultation_cancelled`, `bra_sent`, `bra_signed`, `bra_cancelled`, `bra_expired` (milestones on an existing buyer) |
| `event_id` | Unique per provider and stable across retries (max 255). Meta: the lead ID. |
| `event_time` | ISO-8601 with offset, or Unix seconds. Stored as UTC. |
| `buying_timeline` | `0_3`, `3_6`, `6_12`, `12_plus`, `unknown` |
| `financing_status` | `cash`, `preapproved`, `prequalified`, `not_started`, `unknown` |
| `home_type` | `single_family`, `condo`, `townhouse`, `multi_family`, `land`, `other` |
| `tour_ready` | `yes`, `soon`, `no`; `existing_representation`: `none`, `has_agent`, `unknown` |

Response (HTTP 200):

```json
{"status": "accepted", "id": 42, "state": "done", "result": "created buyer acquisition",
 "lead_id": 17, "acquisition_uuid": "…", "person_uuid": "…"}
```

* `status`: `accepted` (stored now) or `duplicate` (already stored; stop retrying).
* `state`: `done`, `pending` (stored; Odoo retries processing itself, typically within a
  minute, e.g. when two events for the same person arrive at once), `review` (identity
  conflict for a manager), `failed` (bad payload or business rule; technical owner notified),
  `ignored` (no buyer intent).
* Once you have a 200 with either status, the event is durable. **Retry only on non-2xx or
  network errors**, with backoff, and keep failed deliveries in your own outbox until then.

### Website backend example (Node)

```js
async function sendToCrm(payload) {
  const res = await fetch(`${process.env.CRM_URL}/json/2/snaphomz.inbound.event/submit_intake`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `bearer ${process.env.CRM_API_KEY}`},
    body: JSON.stringify({payload}),
  });
  if (!res.ok) throw new Error(`CRM intake failed: ${res.status} ${await res.text()}`); // keep in outbox, retry
  return res.json();
}
```

### Rules the add-on applies

* Matching order: Snaphomz user ID / person UUID, then normalised email, then phone (only
  if it cannot contradict a different email). Conflicts go to **Manager › Intake review**.
* One active acquisition per person. Repeat inquiries are appended; owner, original
  attribution, qualification and suppression are preserved; latest-inquiry fields update.
* Unowned buyers go to the designated intake salesperson, then the backup, else the
  unassigned queue (team leader owns the first-contact task).
* A closed buyer who inquires again is reopened, unless they asked not to be contacted:
  then the inquiry is attached and the record is flagged for manager review.
* Form answers fill blank buyer-needs fields only; a salesperson's entries win.

## 2. Dry run (imports)

`POST /json/2/snaphomz.inbound.event/preview_intake` with `{"payload": {...}}` returns
`{"action": "create" | "update" | "conflict", "reason", "partner_id", "lead_id", ...}` and
writes nothing. Used by `scripts/import_buyers.py`.

## 3. Reconciliation

`POST /json/2/snaphomz.inbound.event/find_missing_events` with
`{"provider": "meta", "event_ids": ["…"]}` returns `{"missing": [...]}`.

## 4. Loops outbound queue (n8n worker)

* `POST /json/2/snaphomz.outbound.queue/claim_batch` `{"limit": 20}` →
  `{"items": [{"queue_id", "version", "method": "PUT", "path": "/api/v1/contacts/update", "body": {...}}]}`.
  Claims are leased for 15 minutes; one entry per buyer at a time.
* `POST /json/2/snaphomz.outbound.queue/report_result`
  `{"queue_id", "success", "status_code", "error", "loops_contact_id"}`. 408/409/425/429/5xx and
  network errors retry with backoff (up to 8 attempts); other 4xx fail and notify the technical owner.

Body sent to Loops (never includes `subscribed`, so unsubscribes are preserved):

| Loops property | Value |
|---|---|
| `email` | normalised email (contact key) |
| `crmPersonId` | person UUID |
| `buyerStage` | `new`, `attempting`, `connected`, `qualified`, `consultation_booked`, `consultation_completed`, `bra_sent`, `bra_signed`, `nurture`, `lost` |
| `buyerReadiness` | `ready_now`, `needs_preparation`, `exploring`, `unqualified`, or empty |
| `salesOwnerName` | salesperson display name |
| `consultationBooked` | true when a confirmed booking exists and was not cancelled |
| `braSigned` | true while the signed BRA is valid |
| `salesSequenceEligible` | false once lost/unqualified or do-not-contact |

## 5. Loops webhooks

`POST /snaphomz/webhooks/loops` verifies the `Webhook-Signature` on the raw body (Standard
Webhooks, `whsec_` secret in Settings › CRM), rejects timestamps older than 5 minutes,
de-duplicates on `Webhook-Id`, stores the event, then returns 200. 401 = bad signature.
Point Loops at it directly, or at the n8n relay (`https://hooks.snaphomz.com/webhook/loops`)
when other systems also need Loops events.

Effects: unsubscribe / hard bounce / spam complaint / resubscribe update the buyer's email
status (older events never override newer ones); clicks set last marketing engagement;
opens set a weak "last email open". Marketing events never touch owner, stage, next action
or the human contact clocks, and never trigger an outbound update.
