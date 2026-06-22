# Snaphomz Real Estate CRM — Full Documentation

## Table of Contents
1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Environment Variables](#environment-variables)
4. [Data Models](#data-models)
5. [API Reference](#api-reference)
6. [Business Logic](#business-logic)
7. [AI Integrations](#ai-integrations)
8. [External Integrations](#external-integrations)
9. [Components](#components)
10. [Pages](#pages)

---

## Overview

AI-powered real estate CRM for managing leads, property transactions, and daily agent workflows. Core capabilities:

- Natural language lead capture via AI assistant chat
- Lead-to-property matching (buyers) and valuation insights (sellers)
- Transaction lifecycle management with stage-gated checklist system
- Smart alerts for overdue tasks, deal inactivity, closing deadlines
- Daily plan builder with drag-and-drop scheduling

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| Database | MongoDB (in-memory stub when no `MONGO_URL`) |
| AI | OpenAI gpt-4o-mini + o1-mini / Groq (fallback) |
| UI | React 18, Tailwind CSS, Radix UI, shadcn/ui |
| Charts | Recharts |
| Forms | React Hook Form + Zod |
| Tables | TanStack Table |
| Notifications | Sonner |
| Property API | RealEstateAPI.com v2 |

---

## Environment Variables

```env
# Database
MONGO_URL=mongodb://localhost:27017
DB_NAME=realestatecrm

# AI provider — "openai" or "groq"
AI_PROVIDER=openai

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Groq (alternative)
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama3-8b-8192
GROQ_COST_PER_1K_INPUT=0.0001
GROQ_COST_PER_1K_OUTPUT=0.0001

# Real Estate API
REAL_ESTATE_API_KEY=your-key
REAL_ESTATE_MLS_API_KEY=your-mls-key   # falls back to REAL_ESTATE_API_KEY
REAL_ESTATE_USER_ID=CRMApp

# Optional overrides
PROPERTY_SEARCH_URL=https://api.realestateapi.com/v2/MLSSearch
TRANSCRIPTION_BASE_URL=

# Frontend
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
```

**Required to run with AI features:** `OPENAI_API_KEY` (or `GROQ_API_KEY` + `AI_PROVIDER=groq`)  
**Optional:** `MONGO_URL` — falls back to in-memory store with seed data  
**Optional:** `REAL_ESTATE_API_KEY` — property search returns empty without it

---

## Data Models

### `leads`

```json
{
  "id": "uuid",
  "name": "string",
  "email": "string",
  "phone": "string",
  "lead_type": "buyer | seller",
  "status": "new | active | closed",
  "assigned_agent": "string",
  "tags": ["string"],
  "ai_insights": "string (markdown)",
  "source": "manual | assistant",
  "preferences": {
    // BUYER
    "zipcode": "string",
    "min_price": "number",
    "max_price": "number",
    "bedrooms": "number",
    "bathrooms": "number",

    // SELLER
    "seller_address": "string",
    "seller_price": "number",
    "seller_property_type": "string",
    "seller_bedrooms": "number",
    "seller_bathrooms": "number",
    "seller_year_built": "number",
    "seller_square_feet": "number",
    "seller_lot_size": "number",
    "seller_condition": "needs_work | average | good | excellent",
    "seller_occupancy": "owner | tenant | vacant",
    "seller_timeline": "asap | 30_60 | 60_90 | 90_plus",
    "seller_hoa_fee": "number",
    "seller_description": "string"
  },
  "created_at": "datetime",
  "updated_at": "datetime",
  "last_matched_at": "datetime"
}
```

### `transactions`

```json
{
  "id": "uuid",
  "property_address": "string",
  "client_name": "string",
  "client_email": "string",
  "client_phone": "string",
  "transaction_type": "sale | purchase | lease",
  "current_stage": "string (see stage flows below)",
  "assigned_agent": "string",
  "lead_id": "uuid (optional)",
  "price": "number",
  "listing_price": "number",
  "contract_price": "number",
  "closing_date": "datetime (optional)",
  "stage_history": [
    {
      "stage": "string",
      "entered_at": "datetime",
      "transitioned_from": "string",
      "validation_result": "object"
    }
  ],
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

### `checklist_items`

```json
{
  "id": "uuid",
  "transaction_id": "uuid",
  "title": "string",
  "description": "string",
  "stage": "string",
  "status": "not_started | in_progress | completed | blocked",
  "completed": "boolean",
  "priority": "low | medium | high | urgent",
  "assignee": "string",
  "due_date": "datetime",
  "scheduled_start": "datetime",
  "scheduled_end": "datetime",
  "completed_date": "datetime",
  "notes": "string",
  "order": "number",
  "stage_order": "number",
  "dependencies": ["uuid"],
  "weight": "number",
  "parent_id": "uuid | null",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

Parent tasks can have subtasks (`parent_id = null` for parents). Parent completion = all children completed. Weights allow fractional subtask contribution.

### `smart_alerts`

```json
{
  "id": "uuid",
  "alert_type": "overdue_tasks | deal_inactivity | closing_approaching",
  "priority": "low | medium | high | urgent",
  "transaction_id": "uuid",
  "property_address": "string",
  "client_name": "string",
  "assigned_agent": "string",
  "title": "string",
  "message": "string",
  "details": {
    "overdue_count": "number",
    "days_inactive": "number",
    "days_to_closing": "number",
    "incomplete_tasks": "number"
  },
  "status": "active | dismissed",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

### `pmd_plans` (Daily Plans)

```json
{
  "id": "uuid",
  "date": "YYYY-MM-DD",
  "items": [{ "id": "task_id", "order": "number" }],
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

---

## API Reference

All routes: `/api/*`

### Leads

| Method | Path | Description |
|---|---|---|
| GET | `/api/leads` | List all leads. Query: `search`, `lead_type` |
| POST | `/api/leads` | Create lead (dedupes by email/phone, generates AI insights) |
| GET | `/api/leads/:id` | Get single lead |
| PUT | `/api/leads/:id` | Update lead |
| DELETE | `/api/leads/:id` | Delete lead |
| POST | `/api/leads/:id/match` | AI match — buyers get properties, sellers get valuation insights |

### Transactions

| Method | Path | Description |
|---|---|---|
| GET | `/api/transactions` | List all transactions |
| POST | `/api/transactions` | Create transaction, auto-generates stage checklist |
| GET | `/api/transactions/:id` | Get transaction |
| PUT | `/api/transactions/:id` | Update transaction |
| DELETE | `/api/transactions/:id` | Delete transaction + all checklist items |
| POST | `/api/transactions/:id/stage-transition` | Advance to next stage. Body: `{ target_stage, force? }`. Validates checklist completion (AI + fallback), auto-creates new stage tasks |

### Checklist

| Method | Path | Description |
|---|---|---|
| GET | `/api/checklist` | List items. Query: `transaction_id` |
| GET | `/api/transactions/:id/checklist` | All checklist items for a transaction |
| GET | `/api/checklist/:id` | Single item |
| PUT | `/api/checklist/:id` | Update item (status, dates, notes, assignee) |
| POST | `/api/checklist/:id/complete` | Mark complete |
| DELETE | `/api/checklist/:id` | Delete item |

### Properties

| Method | Path | Description |
|---|---|---|
| GET | `/api/properties` | Search. Query: `location`, `beds`, `baths`, `min_price`, `max_price`, `property_type`, `sort_by`, `limit`, `offset` |
| POST | `/api/properties/search` | Advanced search with saved filters |
| GET | `/api/properties/:id` | Property detail |

### AI Assistant

| Method | Path | Description |
|---|---|---|
| POST | `/api/assistant/parse` | Parse natural language. Body: `{ message }`. Returns structured lead/property intent |
| POST | `/api/assistant/match` | Full match workflow — parse → create/update lead → search/recommend |

### Analytics & Alerts

| Method | Path | Description |
|---|---|---|
| GET | `/api/analytics/dashboard` | Stats: total/active/buyer/seller lead counts |
| GET | `/api/alerts/smart` | Active smart alerts |
| POST | `/api/alerts/generate` | Regenerate alerts from current transaction state |
| POST | `/api/alerts/dismiss/:id` | Dismiss alert |
| GET | `/api/deal/:id/summary` | AI deal summary: overview, critical actions, next steps |

### Daily Plan (PMD)

| Method | Path | Description |
|---|---|---|
| GET | `/api/pmd/tasks` | Tasks for a date. Query: `date=YYYY-MM-DD` |
| GET | `/api/pmd/plans/latest` | Latest saved plan for a date |
| POST | `/api/pmd/plans` | Save daily plan |
| POST | `/api/tasks/:id/snooze` | Snooze task. Body: `{ until: datetime }` |
| POST | `/api/tasks/:id/dismiss` | Dismiss task from suggestions |

---

## Business Logic

### Transaction Stage Flows

**SALE (Seller)** — 4 stages:
```
pre_listing → listing → under_contract → escrow_closing
```

| Stage | Key Tasks |
|---|---|
| Pre-Listing | Property assessment, CMA, pricing strategy, staging, photography, marketing materials, inspections, listing agreement |
| Active Listing | MLS entry, photos upload, property description, social media campaign, open house, showing management, lead follow-up |
| Under Contract | Purchase agreement review, earnest money, home inspection, appraisal, loan processing, repair negotiation, insurance |
| Escrow & Closing | Title coordination, closing disclosure, final walkthrough, closing docs, key transfer, utility transfer, post-closing |

**PURCHASE (Buyer)** — 5 stages:
```
pre_approval → home_search → offer → under_contract → escrow_closing
```

| Stage | Key Tasks |
|---|---|
| Pre-Approval | Lender intro, financial docs submission, pre-approval letter |
| Home Search | Define criteria, MLS alerts setup, schedule showings |
| Offer | Offer strategy, draft offer, submit, counter-offer review |
| Under Contract | Earnest money deposit, inspections, appraisal, loan processing |
| Escrow & Closing | Title review, closing disclosure, final walkthrough, signing, key receipt |

**LEASE** — Uses sale stage order as fallback.

### Stage Transition Validation

On `POST /api/transactions/:id/stage-transition`:

1. Loads all checklist items for current stage
2. Builds parent/child completion map (parent = complete only if all children complete)
3. Checks unmet task dependencies
4. Calls o1-mini to validate (falls back to rule-based if AI unavailable)
5. Rules: must advance in order, high/urgent incomplete tasks block transition
6. `force: true` bypasses validation
7. On success: updates `current_stage`, appends `stage_history`, auto-creates next stage tasks

### Smart Alert Rules

| Alert | Trigger | Priority |
|---|---|---|
| Overdue Tasks | Any task due >3 days ago and incomplete | urgent if any urgent task, else high |
| Deal Inactivity | `updated_at` > 7 days ago | medium |
| Closing Approaching | `closing_date` ≤ 7 days away with incomplete tasks | urgent if ≤3 days, else high |

### Buyer Property Matching

Progressive filter relaxation:
1. **Strict:** zipcode + beds + baths + price range
2. **Relax 1:** Allow unknown baths
3. **Relax 2:** Allow unknown beds and baths
4. **Relax 3:** Expand price range ±10%
5. **Fallback:** Return all results; AI notes mismatch

### Seller Matching

No property search. AI generates:
- Valuation context
- Pricing strategy
- Listing preparation guidance
- Next steps

### Natural Language Parsing (Assistant)

Extracts from free-form text:
- Lead name, email, phone
- Lead type (buyer/seller via keyword detection: "selling", "listing", "my house" → seller)
- Buyer: location, beds, baths, price range
- Seller: address, asking price, property type, condition, timeline, HOA, sqft, lot size, occupancy, year built
- Intent: `find_properties | create_lead | update_preferences | create_transaction | other`
- Price patterns: `$500k`, `1.2 million`, `$800,000`

---

## AI Integrations

### Models Used

| Model | Purpose |
|---|---|
| `gpt-4o-mini` | Lead insight generation, property match recommendations, NL parsing, seller market analysis |
| `o1-mini` | Stage transition validation, deal summary generation |
| Groq (configurable) | Drop-in OpenAI replacement via `AI_PROVIDER=groq` |

### AI Utility Features

- Token counting (approx: 1 token ≈ 4 chars)
- Daily cost tracking ($50/day default budget)
- Exponential backoff retry (3 retries max)
- Request logging
- Streaming response support
- Error classification (rate limit, quota, model unavailable)
- Graceful fallback to rule-based logic when AI unavailable

---

## External Integrations

### RealEstateAPI.com

**MLS Search** — `POST https://api.realestateapi.com/v2/MLSSearch`  
Params: `size`, `active`, `sold`, `has_photos`, `include_photos`, `bedrooms_min`, `bathrooms_min`, price range, `resultIndex` (pagination)

**Property Detail** — `POST https://api.realestateapi.com/v2/PropertyDetail`  
Used for fetching detailed property data and images. Tries multiple query shapes (by id, address, city+state+zip). Falls back to alternate endpoints (`PropertyDetails`, `Property`).

**Image Extraction:** Recursive depth-limited search (max depth 5) through nested API response objects for any URL fields (`url`, `href`, `src`, `photo`, `thumbnail`, etc.)

**Timeout:** 10 seconds per request (AbortController). Falls back to mock/empty on failure.

---

## Components

### `AssistantChat.js`
AI chat interface. Accepts natural language input → parses → creates/updates lead → matches properties or generates seller insights. Renders lead cards, property results, AI markdown responses. Handles slot-filling for incomplete seller data.

### `AssistantPanel.js`
Dashboard overview panel alongside the assistant.

### `PropertySearch.js`
Advanced property search UI. Filters: location, beds, baths, price, type, sort. Debounced search. Results pagination. Image gallery modal with keyboard navigation (ESC, arrow keys).

### `TransactionManagement.js`
Transaction list with search and stage filtering. Stage badges (color-coded). Create/delete dialogs. Click → opens timeline view.

### `TransactionTimeline.js`
Interactive stage timeline. Shows all stages with progress bars. Checklist items grouped by stage with parent/child nesting. Task status management (not_started → in_progress → completed → blocked). Inline editing, drag-to-reorder, subtask expansion. Stage advance button with validation.

### `DealSummary.js`
Two exports:
- **DealCommand** — command palette for deal analysis. Shows AI summary, critical actions, next steps, overdue tasks, recommendations.
- **SmartAlerts** — alert center. Groups by priority. Dismissible. Refresh to regenerate.

### `ChatPropertyResults.js`
Compact property card grid for assistant chat results (top 5 matches).

### `NotificationCenter.jsx`
Bell icon toggle with notification list and timestamps.

### `PlanDayGrid.jsx`
Visual 9AM–5PM day planner. Drag-and-drop tasks to time slots. Editable slot durations.

---

## Pages

### `/` — Main Dashboard (`app/page.js`)

Four tabs:

**Assistant**
- Chat with AI to create leads and match properties
- Supports buyer and seller flows
- Renders structured results inline

**Leads**
- Stats bar: total, active, buyers, sellers
- Searchable, filterable lead list
- Per-lead actions: Edit, AI Match, Start Transaction, Delete
- AI insights displayed on each card

**Transactions**
- Search + stage filter
- Transaction cards with type, agent, dates, price
- Click → Transaction Timeline with full checklist
- Create / delete transactions

**Properties**
- Advanced search with all filters
- Property cards: address, price, beds/baths/sqft, days on market, MLS#
- Image gallery

### `/plan` — Daily Plan (`app/plan/page.js`)

Two views:
- **List View:** Suggested tasks (left) → Selected for today (right). Snooze options (3PM today, 9AM tomorrow, next weekday, custom). Move up/down/remove. Estimated durations.
- **Grid View:** Visual calendar with drag-to-reschedule time blocks.

Date navigation: Prev / Today / Next / Date Picker  
SSE live updates when transaction tasks change.
