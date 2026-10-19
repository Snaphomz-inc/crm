"""Generate the n8n workflow exports in n8n/workflows/.

No secrets: credentials are referenced by ID and name and filled in the n8n editor.

    python3 n8n/generate_workflows.py
    scripts/import_n8n_workflows.sh
"""
import json
import sys
import uuid
from pathlib import Path

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "workflows"
ODOO = "http://odoo:8069"
# Meta Graph API version for the HTTP Request nodes (n8n's Facebook Trigger pins its own).
GRAPH = "https://graph.facebook.com/v26.0"
ODOO_CRED = {"httpHeaderAuth": {"id": "odoo-integration-key", "name": "Odoo integration API key"}}
LOOPS_CRED = {"httpHeaderAuth": {"id": "loops-api-key", "name": "Loops API key"}}
# App ID|secret: registers the Page webhook and verifies Meta's signature on each delivery.
META_APP_CRED = {"facebookGraphAppApi": {"id": "meta-app", "name": "Meta app (webhooks)"}}
# Never-expiring Meta Business system-user token: lists the Pages and reads their leads.
META_GRAPH_CRED = {"facebookGraphApi": {"id": "meta-graph", "name": "Meta Graph API (system user)"}}
LEAD_FIELDS = "id,created_time,field_data,form_id,ad_id,adset_id,campaign_id,platform,is_organic"

META_MAPPING_JS = r"""
// Map a Meta lead (Graph API lead with field_data) to the canonical Snaphomz
// intake payload. Odoo enforces identity and ownership rules; this node only
// reshapes data.
const STANDARD = new Set(['full_name', 'first_name', 'last_name', 'email', 'phone_number', 'phone',
  'city', 'state', 'zip_code', 'post_code', 'country']);

function flatten(lead) {
  const out = {};
  for (const f of lead.field_data || []) out[f.name] = (f.values || [])[0] ?? null;
  return out;
}

return $input.all().map(({ json: lead }) => {
  const d = flatten(lead);
  const pick = (...keys) => keys.map(k => d[k]).find(v => v !== undefined && v !== null && v !== '') ?? null;
  const answers = {};
  for (const [k, v] of Object.entries(d)) if (!STANDARD.has(k)) answers[k] = v;
  // A custom checkbox whose key contains "consent" records marketing consent.
  const consentKey = Object.keys(answers).find(k => k.toLowerCase().includes('consent'));
  const consent = consentKey ? ['yes', 'true', '1', 'i agree'].includes(String(answers[consentKey]).toLowerCase()) : false;
  const id = (v) => (v === undefined || v === null || v === '') ? null : String(v);
  return {
    json: {
      payload: {
        provider: 'meta',
        event_type: 'lead_form',
        event_id: String(lead.id),
        event_time: lead.created_time,
        person: {
          name: pick('full_name'),
          first_name: pick('first_name'),
          last_name: pick('last_name'),
          email: pick('email'),
          phone: pick('phone_number', 'phone'),
          country_code: pick('country'),
        },
        buyer_needs: { locations: pick('city', 'zip_code', 'post_code') },
        attribution: {
          source: lead.platform === 'ig' ? 'instagram' : 'facebook',
          medium: lead.is_organic ? 'social' : 'paid_social',
          campaign: lead.campaign_name || null,
          meta: {
            page_id: id(lead.page_id),
            form_id: id(lead.form_id),
            campaign_id: id(lead.campaign_id),
            adset_id: id(lead.adset_id),
            ad_id: id(lead.ad_id),
            lead_id: String(lead.id),
          },
        },
        consent: consent ? { marketing_email: true, source: 'meta lead form', captured_at: lead.created_time } : {},
        answers,
      },
    },
  };
});
""".strip()


def node(name, type_, version, params, pos, **extra):
    data = {
        "parameters": params,
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"snaphomz/{name}")),
        "name": name,
        "type": type_,
        "typeVersion": version,
        "position": pos,
    }
    data.update(extra)
    return data


def odoo_call(name, method_path, body_expr, pos, **extra):
    """HTTP Request calling Odoo JSON-2 with the integration API key."""
    return node(name, "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST",
        "url": f"{ODOO}/json/2/{method_path}",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": True,
        "headerParameters": {"parameters": [{"name": "X-Odoo-Database", "value": "snaphomz"}]},
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": body_expr,
        "options": {"timeout": 20000},
    }, pos, credentials=ODOO_CRED, retryOnFail=True, maxTries=5, waitBetweenTries=5000, **extra)


def graph_call(name, path_expr, query, pos, method="GET", page_token=None, options=None, **extra):
    """HTTP Request to the Meta Graph API.

    Without `page_token` it authenticates with the system-user credential; with it,
    it sends that Page access token (an expression) instead.
    """
    params = [{"name": key, "value": value} for key, value in query.items()]
    auth = {"authentication": "predefinedCredentialType", "nodeCredentialType": "facebookGraphApi"}
    if page_token:
        params.append({"name": "access_token", "value": page_token})
        auth = {"authentication": "none"}
    else:
        extra["credentials"] = META_GRAPH_CRED
    return node(name, "n8n-nodes-base.httpRequest", 4.2, {
        "method": method,
        "url": f"={GRAPH}/{path_expr}",
        **auth,
        "sendQuery": True,
        "queryParameters": {"parameters": params},
        "options": {"timeout": 15000, **(options or {})},
    }, pos, **extra)


def connect(*pairs):
    conns = {}
    for src, dst in pairs:
        conns.setdefault(src, {"main": [[]]})["main"][0].append({"node": dst, "type": "main", "index": 0})
    return conns


ERROR_WORKFLOW_ID = "SnzErrorAlert001"


def workflow(name, nodes, connections, tags, wf_id, **settings_overrides):
    settings = {"executionOrder": "v1", "saveDataErrorExecution": "all", "saveDataSuccessExecution": "none"}
    if wf_id != ERROR_WORKFLOW_ID:
        settings["errorWorkflow"] = ERROR_WORKFLOW_ID
    settings.update(settings_overrides)
    return {
        "id": wf_id,
        "name": name,
        "nodes": nodes,
        "connections": connections,
        "settings": settings,
        "active": False,
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": False},
        "tags": [],
        "staticData": None,
    }


def write(filename, wf):
    (OUT / filename).write_text(json.dumps(wf, indent=2) + "\n")


# Pages the system user manages, one item per Page (with its Page access token).
def pages_nodes(x):
    return [
        graph_call("Pages the system user manages", "me/accounts",
                   {"fields": "id,name,access_token", "limit": "100"}, [x, 0]),
        node("One item per page", "n8n-nodes-base.splitOut", 1, {"fieldToSplitOut": "data", "options": {}},
             [x + 220, 0]),
    ]


# 1. Meta Lead Ads -> Odoo -------------------------------------------------
LEADGEN_JS = r"""
// One delivery can carry several Page changes; keep the new lead-form leads.
const leads = [];
for (const { json: entry } of $input.all()) {
  for (const change of entry.changes || []) {
    const v = change.value || {};
    if (change.field !== 'leadgen' || !v.leadgen_id) continue;
    leads.push({ json: {
      leadgen_id: String(v.leadgen_id),
      page_id: String(v.page_id || entry.id),
      form_id: v.form_id ? String(v.form_id) : null,
      ad_id: v.ad_id ? String(v.ad_id) : null,
      adset_id: v.adgroup_id ? String(v.adgroup_id) : null,
    } });
  }
}
return leads;
""".strip()

COMBINE_JS = r"""
const event = $('One item per lead').item.json;
const lead = $('Fetch lead').item.json;
const names = $json.error ? {} : $json;  // campaign name is best effort
return { json: {
  ...lead,
  page_id: event.page_id,
  form_id: lead.form_id || event.form_id,
  ad_id: lead.ad_id || event.ad_id,
  adset_id: lead.adset_id || event.adset_id,
  campaign_name: names.campaign_name || null,
} };
""".strip()

write("10-meta-lead-ads-to-odoo.json", workflow(
    "Snaphomz | Meta Lead Ads -> Odoo intake",
    [
        node("Meta Page leads", "n8n-nodes-base.facebookTrigger", 1, {
            "authType": "accessToken",
            "appId": "REPLACE_WITH_META_APP_ID",
            "object": "page",
            "fields": ["leadgen"],
            "options": {"includeValues": True},
        }, [0, 0], credentials=META_APP_CRED,
            webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "snaphomz/meta-page-hook"))),
        node("One item per lead", "n8n-nodes-base.code", 2, {"jsCode": LEADGEN_JS}, [220, 0]),
        graph_call("Page access token", "{{ $json.page_id }}", {"fields": "access_token"}, [440, 0],
                   retryOnFail=True, maxTries=3, waitBetweenTries=5000),
        graph_call("Fetch lead", "{{ $('One item per lead').item.json.leadgen_id }}", {"fields": LEAD_FIELDS},
                   [660, 0], page_token="={{ $json.access_token }}",
                   retryOnFail=True, maxTries=5, waitBetweenTries=5000),
        graph_call("Campaign name", "{{ $json.id }}", {"fields": "campaign_name"}, [880, 0],
                   onError="continueRegularOutput"),
        node("Combine", "n8n-nodes-base.code", 2, {"mode": "runOnceForEachItem", "jsCode": COMBINE_JS},
             [1100, 0]),
        node("Map to intake payload", "n8n-nodes-base.code", 2, {"jsCode": META_MAPPING_JS}, [1320, 0]),
        odoo_call("Submit to Odoo", "snaphomz.inbound.event/submit_intake",
                  "={{ JSON.stringify({ payload: $json.payload }) }}", [1540, 0]),
    ],
    connect(("Meta Page leads", "One item per lead"), ("One item per lead", "Page access token"),
            ("Page access token", "Fetch lead"), ("Fetch lead", "Campaign name"),
            ("Campaign name", "Combine"), ("Combine", "Map to intake payload"),
            ("Map to intake payload", "Submit to Odoo")),
    ["snaphomz", "meta"], "SnzMetaIntake001",
))

# 1b. Connect Meta Pages to the app (run once, and again when a Page is added) ----
PAGE_SUMMARY_JS = r"""
const page = $('One item per page').item.json;
return { json: {
  page: `${page.name} (${page.id})`,
  subscribed_to_leads: $('Subscribe page to lead events').item.json.success === true,
  forms: ($json.data || []).map(f => `${f.name} (${f.id}, ${f.status})`),
} };
""".strip()

write("15-meta-page-connection.json", workflow(
    "Snaphomz | Meta Page connection (run once)",
    [
        node("Run manually", "n8n-nodes-base.manualTrigger", 1, {}, [0, 0]),
        *pages_nodes(220),
        graph_call("Subscribe page to lead events", "{{ $json.id }}/subscribed_apps",
                   {"subscribed_fields": "leadgen"}, [660, 0], method="POST",
                   page_token="={{ $json.access_token }}"),
        graph_call("Lead forms on the page", "{{ $('One item per page').item.json.id }}/leadgen_forms",
                   {"fields": "id,name,status", "limit": "100"}, [880, 0],
                   page_token="={{ $('One item per page').item.json.access_token }}"),
        node("Summary", "n8n-nodes-base.code", 2, {"mode": "runOnceForEachItem", "jsCode": PAGE_SUMMARY_JS},
             [1100, 0]),
    ],
    connect(("Run manually", "Pages the system user manages"),
            ("Pages the system user manages", "One item per page"),
            ("One item per page", "Subscribe page to lead events"),
            ("Subscribe page to lead events", "Lead forms on the page"),
            ("Lead forms on the page", "Summary")),
    ["snaphomz", "meta"], "SnzMetaPages0001",
    # Node outputs hold Page access tokens: don't keep manual runs.
    saveManualExecutions=False,
))

# 2. Loops webhook relay ----------------------------------------------------
write("20-loops-webhook-relay.json", workflow(
    "Snaphomz | Loops webhook relay",
    [
        node("Loops webhook", "n8n-nodes-base.webhook", 2, {
            "httpMethod": "POST",
            "path": "loops",
            "responseMode": "responseNode",
            "options": {"rawBody": True},
        }, [0, 0], webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "snaphomz/loops-hook"))),
        node("Forward to Odoo (verifies signature)", "n8n-nodes-base.httpRequest", 4.2, {
            "method": "POST",
            "url": f"{ODOO}/snaphomz/webhooks/loops",
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "webhook-id", "value": "={{ $json.headers['webhook-id'] }}"},
                {"name": "webhook-timestamp", "value": "={{ $json.headers['webhook-timestamp'] }}"},
                {"name": "webhook-signature", "value": "={{ $json.headers['webhook-signature'] }}"},
                {"name": "Content-Type", "value": "application/json"},
                {"name": "X-Odoo-Database", "value": "snaphomz"},
            ]},
            "sendBody": True,
            "contentType": "binaryData",
            "inputDataFieldName": "data",
            "options": {"timeout": 12000, "response": {"response": {"fullResponse": True, "neverError": True}}},
        }, [260, 0], onError="continueRegularOutput"),
        node("Reply to Loops", "n8n-nodes-base.respondToWebhook", 1.1, {
            "respondWith": "json",
            "responseBody": "={{ typeof $json.body === 'string' ? $json.body : JSON.stringify($json.body || {status: 'error'}) }}",
            "options": {"responseCode": "={{ $json.statusCode || 500 }}"},
        }, [520, 0]),
        node("Accepted by Odoo?", "n8n-nodes-base.if", 2, {
            "conditions": {
                "options": {"caseSensitive": True, "typeValidation": "loose"},
                "conditions": [{
                    "leftValue": "={{ $('Forward to Odoo (verifies signature)').item.json.statusCode }}",
                    "rightValue": 200,
                    "operator": {"type": "number", "operation": "equals"},
                }],
                "combinator": "and",
            },
            "options": {},
        }, [780, 0]),
        node("Existing consumer (configure or delete)", "n8n-nodes-base.httpRequest", 4.2, {
            "method": "POST",
            "url": "https://REPLACE-WITH-EXISTING-LOOPS-WEBHOOK-CONSUMER",
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "webhook-id", "value": "={{ $('Loops webhook').item.json.headers['webhook-id'] }}"},
                {"name": "webhook-timestamp", "value": "={{ $('Loops webhook').item.json.headers['webhook-timestamp'] }}"},
                {"name": "webhook-signature", "value": "={{ $('Loops webhook').item.json.headers['webhook-signature'] }}"},
                {"name": "Content-Type", "value": "application/json"},
            ]},
            "sendBody": True,
            "contentType": "binaryData",
            "inputDataFieldName": "data",
            "options": {"timeout": 10000},
        }, [1040, -80], disabled=True, onError="continueRegularOutput"),
    ],
    connect(("Loops webhook", "Forward to Odoo (verifies signature)"),
            ("Forward to Odoo (verifies signature)", "Reply to Loops"),
            ("Reply to Loops", "Accepted by Odoo?"),
            ("Accepted by Odoo?", "Existing consumer (configure or delete)")),
    ["snaphomz", "loops"], "SnzLoopsRelay001",
))

# 3. Odoo outbound queue -> Loops ----------------------------------------------
REPORT_JS = r"""
// Turn one Loops API response into an Odoo queue result.
const claim = $('One item per buyer').item.json;
const res = $json;
const status = Number(res.statusCode || 0);
const body = (res.body && typeof res.body === 'object') ? res.body : {};
const ok = status >= 200 && status < 300 && body.success !== false;
return {
  json: {
    queue_id: claim.queue_id,
    success: ok,
    status_code: status,
    error: ok ? null : String(body.message || res.error?.message || `HTTP ${status}`),
    loops_contact_id: ok ? (body.id || null) : null,
  },
};
""".strip()

write("30-loops-outbound-sync.json", workflow(
    "Snaphomz | Odoo -> Loops contact properties",
    [
        node("Every minute", "n8n-nodes-base.scheduleTrigger", 1.2, {
            "rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]},
        }, [0, 0]),
        odoo_call("Claim Loops batch", "snaphomz.outbound.queue/claim_batch", "={{ JSON.stringify({ limit: 20 }) }}", [240, 0]),
        node("One item per buyer", "n8n-nodes-base.splitOut", 1, {"fieldToSplitOut": "items", "options": {}}, [360, 0]),
        node("Update Loops contact", "n8n-nodes-base.httpRequest", 4.2, {
            "method": "PUT",
            "url": "https://app.loops.so/api/v1/contacts/update",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.body) }}",
            "options": {
                "timeout": 15000,
                "batching": {"batch": {"batchSize": 5, "batchInterval": 1000}},
                "response": {"response": {"fullResponse": True, "neverError": True}},
            },
        }, [480, 0], credentials=LOOPS_CRED, onError="continueRegularOutput"),
        node("Build results", "n8n-nodes-base.code", 2, {"mode": "runOnceForEachItem", "jsCode": REPORT_JS}, [720, 0]),
        odoo_call("Report to Odoo", "snaphomz.outbound.queue/report_result", "={{ JSON.stringify($json) }}", [960, 0]),
    ],
    connect(("Every minute", "Claim Loops batch"), ("Claim Loops batch", "One item per buyer"),
            ("One item per buyer", "Update Loops contact"),
            ("Update Loops contact", "Build results"), ("Build results", "Report to Odoo")),
    ["snaphomz", "loops"], "SnzLoopsSync0001",
))

# 4. Daily Meta reconciliation -----------------------------------------------
FORMS_JS = r"""
// Every form on every connected Page that can still hold recent leads.
const since = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;  // last 3 days
const forms = [];
$input.all().forEach((item, i) => {
  const page = $('One item per page').itemMatching(i).json;
  for (const form of item.json.data || []) {
    if (['DELETED', 'DRAFT'].includes(form.status)) continue;
    forms.push({ json: { form_id: String(form.id), page_id: String(page.id), page_token: page.access_token, since } });
  }
});
return forms;
""".strip()

COLLECT_JS = r"""
const leads = [];
$input.all().forEach((item, i) => {
  const form = $('Forms to check').itemMatching(i).json;
  for (const lead of item.json.data || []) leads.push({ ...lead, page_id: form.page_id });
});
return [{ json: { event_ids: leads.map(l => String(l.id)), leads } }];
""".strip()

MISSING_JS = r"""
const missing = new Set($json.missing || []);
const leads = $('Collect lead IDs').first().json.leads.filter(l => missing.has(String(l.id)));
return leads.map(json => ({ json }));
""".strip()

write("40-meta-daily-reconciliation.json", workflow(
    "Snaphomz | Meta daily reconciliation",
    [
        node("Daily 07:00 UTC", "n8n-nodes-base.scheduleTrigger", 1.2, {
            "rule": {"interval": [{"field": "cronExpression", "expression": "0 7 * * *"}]},
        }, [-220, 0]),
        *pages_nodes(0),
        graph_call("Lead forms on the page", "{{ $json.id }}/leadgen_forms",
                   {"fields": "id,name,status", "limit": "100"}, [440, 0],
                   page_token="={{ $json.access_token }}"),
        node("Forms to check", "n8n-nodes-base.code", 2, {"jsCode": FORMS_JS}, [660, 0]),
        graph_call("Recent form leads", "{{ $json.form_id }}/leads", {
            "fields": LEAD_FIELDS,
            "limit": "500",
            "filtering": "=[{\"field\":\"time_created\",\"operator\":\"GREATER_THAN\",\"value\":{{ $json.since }}}]",
        }, [880, 0], page_token="={{ $json.page_token }}", options={
            "timeout": 30000,
            "pagination": {"pagination": {
                "paginationMode": "responseContainsNextURL",
                "nextURL": "={{ $response.body.paging?.next }}",
                "paginationCompleteWhen": "other",
                "completeExpression": "={{ !$response.body.paging?.next }}",
            }},
        }),
        node("Collect lead IDs", "n8n-nodes-base.code", 2, {"jsCode": COLLECT_JS}, [1100, 0]),
        odoo_call("Find unprocessed", "snaphomz.inbound.event/find_missing_events",
                  "={{ JSON.stringify({ provider: 'meta', event_ids: $json.event_ids }) }}", [1320, 0]),
        node("Missing leads", "n8n-nodes-base.code", 2, {"jsCode": MISSING_JS}, [1540, 0]),
        node("Map to intake payload", "n8n-nodes-base.code", 2, {"jsCode": META_MAPPING_JS}, [1760, 0]),
        odoo_call("Submit missing to Odoo", "snaphomz.inbound.event/submit_intake",
                  "={{ JSON.stringify({ payload: $json.payload }) }}", [1980, 0]),
    ],
    connect(("Daily 07:00 UTC", "Pages the system user manages"),
            ("Pages the system user manages", "One item per page"),
            ("One item per page", "Lead forms on the page"),
            ("Lead forms on the page", "Forms to check"), ("Forms to check", "Recent form leads"),
            ("Recent form leads", "Collect lead IDs"), ("Collect lead IDs", "Find unprocessed"),
            ("Find unprocessed", "Missing leads"), ("Missing leads", "Map to intake payload"),
            ("Map to intake payload", "Submit missing to Odoo")),
    ["snaphomz", "meta"], "SnzMetaRecon0001",
))

# 5. Error workflow -----------------------------------------------------------
write("90-integration-error-alert.json", workflow(
    "Snaphomz | Integration error alert",
    [
        node("On workflow error", "n8n-nodes-base.errorTrigger", 1, {}, [0, 0]),
        odoo_call("Record failure in Odoo", "snaphomz.inbound.event/report_integration_failure",
                  "={{ JSON.stringify({ workflow: $json.workflow.name, error: $json.execution.error?.message || 'unknown error', "
                  "execution_id: String($json.execution.id || ''), execution_url: $json.execution.url || null, "
                  "node: $json.execution.lastNodeExecuted || null }) }}", [260, 0]),
    ],
    connect(("On workflow error", "Record failure in Odoo")),
    ["snaphomz"], ERROR_WORKFLOW_ID,
))
print("written:", sorted(p.name for p in OUT.glob("*.json")))
