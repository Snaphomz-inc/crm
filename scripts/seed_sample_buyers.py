#!/usr/bin/env python3
"""TEST ENVIRONMENT ONLY: submit a handful of synthetic buyers through the
real intake API so the salesperson and manager views have data for the
first-workday demo. All addresses use the reserved example.com domain.

  ODOO_URL=http://localhost:8069 ODOO_API_KEY=... scripts/seed_sample_buyers.py
"""
import json
import os
import urllib.request
from datetime import datetime, timedelta, timezone

URL = os.environ.get('ODOO_URL', 'http://localhost:8069').rstrip('/')
KEY = os.environ['ODOO_API_KEY']
NOW = datetime.now(timezone.utc)

BUYERS = [
    ('meta', 'lead_form', 'Maria Gonzalez', 'maria.gonzalez@example.com', '+1 512 555 0141', 'America/Chicago',
     None, 'Austin, TX', '0_3', 'preapproved', 'Fall buyers - Austin'),
    ('website', 'inquiry', 'Daniel Kim', 'daniel.kim@example.com', '+1 206 555 0177', 'America/Los_Angeles',
     'MLS-88231', 'Seattle, WA', '3_6', 'prequalified', 'listing-page'),
    ('website', 'consultation_request', 'Priya Natarajan', 'priya.n@example.com', '+1 908 555 0102', 'America/New_York',
     'MLS-55120', 'Edison, NJ', '0_3', 'cash', 'consultation-cta'),
    ('meta', 'lead_form', 'James Carter', None, '+1 404 555 0199', 'America/New_York',
     None, 'Atlanta, GA', '6_12', 'not_started', 'Fall buyers - Atlanta'),
    ('website', 'inquiry', 'Aisha Rahman', 'aisha.rahman@example.com', '+1 713 555 0123', 'America/Chicago',
     'MLS-77310', 'Houston, TX', '12_plus', 'unknown', 'blog-first-time-buyer'),
    ('import', 'inquiry', 'Tom Becker', 'tom.becker@example.com', '+1 303 555 0150', 'America/Denver',
     None, 'Denver, CO', '3_6', 'preapproved', 'past-website-signups'),
]

for i, (provider, kind, name, email, phone, tz, prop, city, timeline, financing, campaign) in enumerate(BUYERS):
    payload = {
        'provider': provider, 'event_type': kind, 'event_id': f"seed-{provider}-{i}",
        'event_time': (NOW - timedelta(minutes=20 * (len(BUYERS) - i))).isoformat(),
        'person': {'name': name, 'email': email, 'phone': phone, 'timezone': tz},
        'inquiry': {'property_ref': prop, 'message': f"Hi, I'm looking to buy in {city}."},
        'buyer_needs': {'locations': city, 'buying_timeline': timeline, 'financing_status': financing},
        'attribution': {'source': 'facebook' if provider == 'meta' else provider, 'campaign': campaign,
                        'meta': {'form_id': 'seed-form', 'lead_id': f'seed-{i}'} if provider == 'meta' else {}},
        'consent': {'marketing_email': True, 'source': 'seed data'} if email else {},
    }
    request = urllib.request.Request(
        f"{URL}/json/2/snaphomz.inbound.event/submit_intake", data=json.dumps({'payload': payload}).encode(),
        method='POST', headers={'Content-Type': 'application/json', 'Authorization': f'bearer {KEY}'})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read())
    print(f"{name:<18} {provider:<8} -> {result['status']}/{result['state']} {result.get('result', '')}")
