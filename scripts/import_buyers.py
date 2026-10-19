#!/usr/bin/env python3
"""Import selected existing buyers through the same intake path as live leads.

Dry run (default) writes a report of matches, conflicts and new buyers and
changes nothing. --apply submits each row as an "import" event; re-running
the same file is safe because every row has a stable event ID.

  ODOO_URL=https://crm.trysnaphomz.com ODOO_API_KEY=... \
      scripts/import_buyers.py buyers.csv --report report.csv
  ... scripts/import_buyers.py buyers.csv --apply

CSV columns (header row, all optional except one identifier):
  email, phone, first_name, last_name, name, snaphomz_user_id, timezone,
  property_ref, message, source, campaign, locations, buying_timeline,
  financing_status, marketing_consent (yes/no), consent_source, inquiry_date
"""
import argparse
import csv
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

TIMELINES = {'0_3', '3_6', '6_12', '12_plus', 'unknown'}
FINANCING = {'cash', 'preapproved', 'prequalified', 'not_started', 'unknown'}


def call(method, **kwargs):
    url = f"{os.environ['ODOO_URL'].rstrip('/')}/json/2/snaphomz.inbound.event/{method}"
    request = urllib.request.Request(url, data=json.dumps(kwargs).encode(), method='POST', headers={
        'Content-Type': 'application/json',
        'Authorization': f"bearer {os.environ['ODOO_API_KEY']}",
        'X-Odoo-Database': os.environ.get('ODOO_DB', 'snaphomz'),
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors='replace')
        try:
            body = json.loads(body).get('message', body)
        except ValueError:
            pass
        return {'error': f"HTTP {exc.code}: {body}"}


def row_payload(row, file_hash, index):
    get = lambda key: (row.get(key) or '').strip() or None  # noqa: E731
    stable = get('email') or get('phone') or get('snaphomz_user_id') or str(index)
    payload = {
        'provider': 'import',
        'event_type': 'inquiry',
        'event_id': f"import:{file_hash}:{hashlib.sha1(stable.lower().encode()).hexdigest()[:16]}",
        'event_time': get('inquiry_date'),
        'person': {
            'email': get('email'), 'phone': get('phone'), 'name': get('name'),
            'first_name': get('first_name'), 'last_name': get('last_name'),
            'snaphomz_user_id': get('snaphomz_user_id'), 'timezone': get('timezone'),
        },
        'inquiry': {'property_ref': get('property_ref'), 'message': get('message')},
        'attribution': {'source': get('source') or 'import', 'campaign': get('campaign')},
        'buyer_needs': {
            'locations': get('locations'),
            'buying_timeline': get('buying_timeline') if get('buying_timeline') in TIMELINES else None,
            'financing_status': get('financing_status') if get('financing_status') in FINANCING else None,
        },
    }
    if (get('marketing_consent') or '').lower() in ('yes', 'true', '1'):
        payload['consent'] = {'marketing_email': True, 'source': get('consent_source') or 'import'}
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('csv_file')
    parser.add_argument('--apply', action='store_true', help='submit rows (default is a dry run)')
    parser.add_argument('--report', default='import-report.csv')
    args = parser.parse_args()
    for var in ('ODOO_URL', 'ODOO_API_KEY'):
        if not os.environ.get(var):
            sys.exit(f"Set {var}")

    raw = open(args.csv_file, 'rb').read()
    file_hash = hashlib.sha1(raw).hexdigest()[:10]
    rows = list(csv.DictReader(raw.decode('utf-8-sig').splitlines()))
    results = []
    for index, row in enumerate(rows, start=2):
        payload = row_payload(row, file_hash, index)
        if args.apply:
            outcome = call('submit_intake', payload=payload)
            action = outcome.get('error') and 'error' or outcome.get('state')
            detail = outcome.get('error') or outcome.get('result', '')
        else:
            outcome = call('preview_intake', payload=payload)
            action = outcome.get('error') and 'error' or outcome.get('action')
            detail = outcome.get('error') or outcome.get('reason', '')
        results.append({'line': index, 'email': payload['person']['email'] or '', 'phone': payload['person']['phone'] or '',
                        'action': action, 'detail': detail, 'lead_id': outcome.get('lead_id') or ''})

    with open(args.report, 'w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['line', 'email', 'phone', 'action', 'detail', 'lead_id'])
        writer.writeheader()
        writer.writerows(results)
    summary = {}
    for result in results:
        summary[result['action']] = summary.get(result['action'], 0) + 1
    print(f"{'Imported' if args.apply else 'Dry run of'} {len(rows)} rows: {summary}. Report: {args.report}")


if __name__ == '__main__':
    main()
