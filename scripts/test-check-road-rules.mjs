#!/usr/bin/env bun

// Proves check-road-rules.mjs can FAIL — and can pass.
//
// Each case serves a fake GoWay API on a loopback port, runs the REAL script
// against it, and asserts on the exit code and on what the script names:
//
//   * a deployment whose `roadrules:sync` never ran — every table empty, every
//     route 200, every vehicle "allowed" — the defect this gate exists for;
//   * an API that puts positions in countries but answers "allowed" to a
//     vehicle a zone refuses (a decision that ignores the zone);
//   * a router that sends a diesel Euro 3 car into a zone that refuses it;
//   * a right answer everywhere, so a gate that fails everything is caught too.
//
// The right answer is computed by the contract's own `decideAccess`, so what the
// fake serves is what the real server serves.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'check-road-rules.mjs');
const { decideAccess } = await import(resolve(here, '../packages/contracts/dist/index.js'));
const failures = [];

const source = {
  attribution: {
    label: 'OpenStreetMap contributors',
    href: 'https://www.openstreetmap.org/copyright',
  },
  licence: { label: 'ODbL 1.0', href: 'https://opendatacommons.org/licenses/odbl/1-0/' },
  retrievedAt: '2026-10-13T00:00:00.000Z',
};
const square = (west, south, east, north) => ({
  type: 'Polygon',
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
});
const zone = (id, name, west, south, east, north) => ({
  id,
  name,
  kind: 'low_emission',
  countryCode: 'ES',
  geometry: square(west, south, east, north),
  boundingBox: { west, south, east, north },
  timezone: 'Europe/Madrid',
  schedule: {
    intervals: [1, 2, 3, 4, 5].map((day) => ({ day, opens: '07:00', closes: '20:00' })),
  },
  policy: {
    rules: [{ scheme: 'es_dgt', labels: ['b', 'c', 'eco', '0'], decision: 'allowed' }],
    otherwise: 'denied',
  },
  source,
});
const BARCELONA = zone(
  'osm-relation-1',
  'Zona de Baixes Emissions Rondes de Barcelona',
  2.05,
  41.34,
  2.25,
  41.46,
);
const ZONES = [
  BARCELONA,
  ...Array.from({ length: 11 }, (_, i) =>
    zone(`osm-relation-${i + 2}`, `ZBE ${i}`, 10 + i, 10, 10.5 + i, 10.5),
  ),
];

const boxes = [
  ['ES', [-9.5, 36, 3.5, 43.8], 'right'],
  ['GB', [-8, 49.8, 2, 60.9], 'left'],
  ['JP', [129, 31, 146, 46], 'left'],
  ['HK', [113.8, 22.15, 114.4, 22.4], 'left'],
  ['CN', [100, 20, 125, 45], 'right'],
];
const countryAt = (lat, lon) => {
  for (const [code, [w, s, e, n], side] of boxes) {
    if (lon >= w && lon <= e && lat >= s && lat <= n) return { code, side };
  }
  return null;
};

/** The healthy API; `overrides` break one thing at a time. */
function api(overrides = {}) {
  const zones = overrides.zones ?? ZONES;
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/roads/rules') {
      const country =
        overrides.countries === false
          ? null
          : countryAt(
              Number(url.searchParams.get('latitude')),
              Number(url.searchParams.get('longitude')),
            );
      const lat = Number(url.searchParams.get('latitude'));
      const lon = Number(url.searchParams.get('longitude'));
      return Response.json({
        countryCode: country?.code ?? null,
        ruleSet: country
          ? {
              countryCode: country.code,
              drivingSide: country.side,
              speedLimitsKmh: overrides.noSpeeds ? {} : { urban: 30, rural: 90 },
              source,
            }
          : null,
        zones: zones.filter(
          (z) =>
            lon >= z.boundingBox.west &&
            lon <= z.boundingBox.east &&
            lat >= z.boundingBox.south &&
            lat <= z.boundingBox.north,
        ),
      });
    }
    if (path === '/roads/zones') return Response.json({ items: zones, nextCursor: null });
    if (path === '/roads/access') {
      const body = await request.json();
      if (overrides.lax) return Response.json({ decision: 'allowed', verdicts: [], at: body.at });
      return Response.json(
        decideAccess(zones, body, body.vehicle ?? { user: 'car' }, new Date(body.at ?? Date.now())),
      );
    }
    if (path === '/routes') {
      const body = await request.json();
      const diesel = body.vehicle?.fuel === 'diesel';
      const line = [
        [body.origin.coordinate.longitude, body.origin.coordinate.latitude],
        [body.destination.coordinate.longitude, body.destination.coordinate.latitude],
      ];
      const through = overrides.entersRefusedZone || !diesel;
      const verdict = {
        zoneId: BARCELONA.id,
        name: BARCELONA.name,
        kind: 'low_emission',
        decision: diesel ? 'denied' : 'unknown',
        inForce: true,
      };
      return Response.json({
        routes: [
          {
            id: 'r',
            mode: 'drive',
            distanceMeters: diesel && !overrides.entersRefusedZone ? 24_000 : 18_000,
            durationSeconds: 1500,
            geometry: { type: 'LineString', coordinates: line },
            legs: [],
            zones: through ? [verdict] : [],
          },
        ],
      });
    }
    return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  };
}

async function runAgainst(handler) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  try {
    const child = Bun.spawn(['bun', script], {
      env: { ...process.env, GOWAY_API_URL: `http://127.0.0.1:${server.port}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, output: `${stdout}\n${stderr}` };
  } finally {
    server.stop(true);
  }
}

async function expectFail(name, handler, patterns) {
  const { code, output } = await runAgainst(handler);
  if (code === 0) {
    failures.push(`${name}: expected the gate to fail, and it passed`);
    return;
  }
  for (const pattern of patterns) {
    if (!pattern.test(output)) failures.push(`${name}: expected ${pattern}, got:\n${output}`);
  }
}

await expectFail(
  'a deployment whose sync never ran',
  api({ zones: [], countries: false, noSpeeds: true }),
  [/in null, expected ES/, /no zone covers Barcelona/, /Spain lists 0 zones/, /expected denied/],
);

await expectFail('an access decision that ignores the zone', api({ lax: true }), [
  /diesel Euro 3 car in the zone on a weekday: allowed, expected denied/,
  /expected unknown — never allowed/,
]);

await expectFail('a route into a zone that refuses the vehicle', api({ entersRefusedZone: true }), [
  /diesel Euro 3 route enters .*Barcelona.*which refuses it/,
]);

{
  const { code, output } = await runAgainst(api());
  if (code !== 0) failures.push(`a right answer everywhere: expected a pass, got:\n${output}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(
  '✓ check-road-rules.mjs fails an unsynced deployment, a lax decision and a route into a refusing zone, and passes a right answer.',
);
