#!/usr/bin/env python3
"""Probe the real browser preflight, including Oxy's activity header."""
from urllib.request import Request, urlopen

origin = 'https://goway.to'
for method, path in [('GET', '/captures/policy'), ('POST', '/captures/sessions'), ('DELETE', '/captures/assets/probe')]:
    request = Request('https://api.goway.to/api/v1' + path, method='OPTIONS', headers={
        'Origin': origin,
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'authorization,content-type,x-oxy-activity-id',
    })
    with urlopen(request, timeout=20) as response:
        if response.status != 204 or response.headers.get('Access-Control-Allow-Origin') != origin:
            raise RuntimeError('Canonical browser origin is not allowed on the contribution API')
        allowed = {v.strip().lower() for v in response.headers.get('Access-Control-Allow-Headers', '').split(',')}
        if not {'authorization', 'content-type', 'x-oxy-activity-id'} <= allowed:
            raise RuntimeError('Oxy contribution headers are missing from the browser preflight')
print('Canonical contribution preflights passed')
