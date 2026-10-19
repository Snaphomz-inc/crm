#!/usr/bin/env python3
"""End-to-end smoke test against a running stack (test environment only).

Exercises the real HTTP paths: JSON-2 intake, replay, simultaneous
deliveries for the same person, the signed Loops webhook route and the
outbound queue API. Uses synthetic @example.com buyers.

  ODOO_URL=http://localhost:8069 ODOO_API_KEY=... LOOPS_SECRET=whsec_... scripts/smoke_test.py
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

URL = os.environ.get('ODOO_URL', 'http://localhost:8069').rstrip('/')
KEY = os.environ['ODOO_API_KEY']
DB = os.environ.get('ODOO_DB', 'snaphomz')
RUN = uuid.uuid4().hex[:8]
failures = []


def post(path, body, headers=None, raw=False):
    data = body if raw else json.dumps(body).encode()
    request = urllib.request.Request(f"{URL}{path}", data=data, method='POST', headers={
        'Content-Type': 'application/json', 'X-Odoo-Database': DB, **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b'null')
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode(errors='replace')


def rpc(model, method, **kwargs):
    return post(f"/json/2/{model}/{method}", kwargs, {'Authorization': f'bearer {KEY}'})


def check(name, condition, detail=''):
    print(f"{'PASS' if condition else 'FAIL'}  {name}{'  ' + str(detail) if detail and not condition else ''}")
    if not condition:
        failures.append(name)


def intake(event_id, email, provider='website', phone=None):
    return rpc('snaphomz.inbound.event', 'submit_intake', payload={
        'provider': provider, 'event_type': 'inquiry' if provider != 'meta' else 'lead_form',
        'event_id': event_id, 'event_time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'person': {'name': 'Smoke Buyer', 'email': email, 'phone': phone},
        'inquiry': {'property_ref': 'SMOKE-1', 'message': 'smoke test'},
        'consent': {'marketing_email': True, 'source': 'smoke test'},
    })


# 1. Intake and replay
email = f"smoke-{RUN}@example.com"
status, first = intake(f"smoke-{RUN}-1", email)
check('intake accepted', status == 200 and first.get('status') == 'accepted' and first.get('state') == 'done', first)
status, again = intake(f"smoke-{RUN}-1", email)
check('replay is duplicate', status == 200 and again.get('status') == 'duplicate', again)

# 2. Simultaneous deliveries: same event x5 and different events for one new person x5
concurrent_email = f"smoke-concurrent-{RUN}@example.com"
with ThreadPoolExecutor(max_workers=10) as pool:
    same = list(pool.map(lambda _i: intake(f"smoke-{RUN}-same", concurrent_email), range(5)))
    different = list(pool.map(lambda i: intake(f"smoke-{RUN}-diff-{i}", concurrent_email,
                                               provider='meta' if i % 2 else 'website'), range(5)))
accepted_same = [r for s, r in same if s == 200 and r.get('status') == 'accepted']
check('same event accepted exactly once', len(accepted_same) == 1, same)
check('all simultaneous deliveries answered 200', all(s == 200 for s, _r in same + different), same + different)
lead_ids = {r.get('lead_id') for s, r in same + different if s == 200 and r.get('lead_id')}
pending = [r for s, r in different if s == 200 and r.get('state') == 'pending']
check('one acquisition record for the person (pending retries allowed)', len(lead_ids) <= 1, lead_ids)
if pending:
    print(f"INFO  {len(pending)} concurrent event(s) deferred to the retry cron (expected under contention)")

# 3. Loops webhook route
secret = os.environ.get('LOOPS_SECRET')
if secret:
    body = json.dumps({'eventName': 'email.clicked', 'eventTime': int(time.time()),
                       'contactIdentity': {'id': f'smoke-{RUN}', 'email': email}}).encode()
    webhook_id, ts = f"msg_smoke_{RUN}", str(int(time.time()))
    key = base64.b64decode(secret.removeprefix('whsec_'))
    signature = base64.b64encode(hmac.new(key, f"{webhook_id}.{ts}.".encode() + body, hashlib.sha256).digest()).decode()
    headers = {'webhook-id': webhook_id, 'webhook-timestamp': ts, 'webhook-signature': f"v1,{signature}"}
    status, result = post('/snaphomz/webhooks/loops', body, headers, raw=True)
    check('signed Loops webhook accepted', status == 200, result)
    status, result = post('/snaphomz/webhooks/loops', body, headers, raw=True)
    check('Loops webhook replay is duplicate', status == 200 and result.get('status') == 'duplicate', result)
    headers['webhook-signature'] = 'v1,' + base64.b64encode(b'x' * 32).decode()
    headers['webhook-id'] = webhook_id + '_bad'
    status, result = post('/snaphomz/webhooks/loops', body, headers, raw=True)
    check('invalid Loops signature rejected', status == 401, result)
else:
    print("SKIP  Loops webhook checks (set LOOPS_SECRET)")

# 4. Outbound queue contract (claims are released by the stale-claim cron)
status, batch = rpc('snaphomz.outbound.queue', 'claim_batch', limit=1)
check('queue claim works', status == 200 and isinstance(batch, dict) and 'items' in batch, batch)
if status == 200 and batch.get('items'):
    item = batch['items'][0]
    check('queue body has no subscribed flag', 'subscribed' not in item['body'], item)
    status, result = rpc('snaphomz.outbound.queue', 'report_result', queue_id=item['queue_id'],
                         success=False, status_code=503, error='smoke test: simulated Loops outage')
    check('simulated Loops outage is retried', status == 200 and result.get('status') == 'retry', result)

print(f"\n{len(failures)} failure(s)" if failures else "\nAll smoke checks passed")
sys.exit(1 if failures else 0)
