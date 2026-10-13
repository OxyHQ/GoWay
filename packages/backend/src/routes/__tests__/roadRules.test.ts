/**
 * The road-rules HTTP surface, over a real socket, with an in-memory store and
 * no database: the query and body shapes the SDK sends, the paging, the cursor
 * binding and the decision `POST /roads/access` gives.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RoadRuleSet, RoadZone } from '@goway/contracts';
import { errorHandler, unknownRouteHandler } from '../../http/errorHandler';
import { buildCountryIndex } from '../../roadrules/countryIndex';
import { createRoadRulesRouter, type RoadRulesStore } from '../roadRules';

const source = {
  attribution: {
    label: 'OpenStreetMap contributors',
    href: 'https://www.openstreetmap.org/copyright',
  },
  licence: { label: 'ODbL 1.0', href: 'https://opendatacommons.org/licenses/odbl/1-0/' },
  retrievedAt: '2026-10-13T00:00:00.000Z',
};

const square = (west: number, south: number, east: number, north: number) =>
  ({
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
  }) as const;

const zone = (
  id: string,
  country: string,
  west: number,
  kind: RoadZone['kind'] = 'low_emission',
): RoadZone => ({
  id,
  name: id,
  kind,
  countryCode: country,
  geometry: square(west, 41, west + 1, 42),
  boundingBox: { west, south: 41, east: west + 1, north: 42 },
  timezone: 'Europe/Madrid',
  policy: {
    rules: [{ scheme: 'es_dgt', labels: ['b', 'c', 'eco', '0'], decision: 'allowed' }],
    otherwise: 'denied',
  },
  source,
});

const ZONES = [
  zone('es-a', 'ES', 2),
  zone('es-b', 'ES', 5),
  zone('fr-a', 'FR', 8, 'restricted_access'),
];
const RULE_SETS: RoadRuleSet[] = ['ES', 'FR', 'GB'].map((countryCode, i) => ({
  countryCode,
  drivingSide: countryCode === 'GB' ? 'left' : 'right',
  speedLimitsKmh: { urban: 30 + i * 10 },
  source,
}));
const COUNTRIES = buildCountryIndex([
  { countryCode: 'ES', name: 'Spain', geometry: square(0, 36, 4, 43), source },
  { countryCode: 'FR', name: 'France', geometry: square(4, 41, 9, 51), source },
]);

const store: RoadRulesStore = {
  listRuleSets: ({ limit, after }) =>
    Promise.resolve(
      RULE_SETS.filter((r) => after === undefined || r.countryCode > after)
        .slice(0, limit + 1)
        .map((ruleSet) => ({ countryCode: ruleSet.countryCode, ruleSet })),
    ),
  ruleSetFor: (code) => Promise.resolve(RULE_SETS.find((r) => r.countryCode === code) ?? null),
  zonesAt: (p) =>
    Promise.resolve(
      ZONES.filter(
        (z) =>
          p.longitude >= z.boundingBox.west &&
          p.longitude <= z.boundingBox.east &&
          p.latitude >= z.boundingBox.south &&
          p.latitude <= z.boundingBox.north,
      ),
    ),
  listZones: (filter, { limit, after }) =>
    Promise.resolve(
      ZONES.filter(
        (z) =>
          (after === undefined || z.id > after) &&
          (filter.country === undefined || z.countryCode === filter.country) &&
          (filter.kind === undefined || z.kind === filter.kind),
      )
        .slice(0, limit + 1)
        .map((z) => ({ id: z.id, zone: z })),
    ),
  countryAt: (p) => Promise.resolve(COUNTRIES.at(p)),
};

/** A parsed response body: the tests assert on what they read, field by field. */
// biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary JSON
type Json = any;

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const v1: Router = Router();
  v1.use(createRoadRulesRouter(store));
  app.use('/api/v1', v1);
  app.use(unknownRouteHandler);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string) {
  const response = await fetch(`${origin}/api/v1${path}`);
  return {
    status: response.status,
    body: (await response.json()) as Json,
    headers: response.headers,
  };
}
async function post(path: string, body: unknown) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Json,
    headers: response.headers,
  };
}

describe('GET /roads/rule-sets', () => {
  it('pages by country with a cursor that resumes after the last one served', async () => {
    const first = await get('/roads/rule-sets?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items.map((r: RoadRuleSet) => r.countryCode)).toEqual(['ES', 'FR']);
    expect(first.body.nextCursor).toBeString();
    expect(first.headers.get('cache-control')).toBe('public, max-age=300');
    const second = await get(`/roads/rule-sets?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((r: RoadRuleSet) => r.countryCode)).toEqual(['GB']);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('GET /roads/rules', () => {
  it("puts a position in its country and answers that country's rules and the zones over it", async () => {
    const answer = await get('/roads/rules?latitude=41.5&longitude=2.5');
    expect(answer.body.countryCode).toBe('ES');
    expect(answer.body.ruleSet.drivingSide).toBe('right');
    expect(answer.body.zones.map((z: RoadZone) => z.id)).toEqual(['es-a']);
  });

  it('has no country over open water, and so no rule set', async () => {
    const answer = await get('/roads/rules?latitude=30&longitude=-40');
    expect(answer.body).toMatchObject({ countryCode: null, ruleSet: null, zones: [] });
  });

  it('lets the caller name the country it already knows', async () => {
    const answer = await get('/roads/rules?latitude=30&longitude=-40&country=GB');
    expect(answer.body.ruleSet.drivingSide).toBe('left');
  });
});

describe('GET /roads/zones', () => {
  it('filters by country and kind, and pages', async () => {
    const es = await get('/roads/zones?country=ES&limit=1');
    expect(es.body.items.map((z: RoadZone) => z.id)).toEqual(['es-a']);
    const next = await get(`/roads/zones?country=ES&limit=1&cursor=${es.body.nextCursor}`);
    expect(next.body.items.map((z: RoadZone) => z.id)).toEqual(['es-b']);
    const restricted = await get('/roads/zones?country=FR&kind=restricted_access');
    expect(restricted.body.items).toHaveLength(1);
  });

  it('refuses a cursor from other filters, and a query that names neither a country nor a box', async () => {
    const es = await get('/roads/zones?country=ES&limit=1');
    const foreign = await get(`/roads/zones?country=FR&limit=1&cursor=${es.body.nextCursor}`);
    expect(foreign.status).toBe(400);
    const nothing = await get('/roads/zones');
    expect(nothing.status).toBe(422);
  });
});

describe('POST /roads/access', () => {
  // Wednesday noon in Madrid; the sample zones have no schedule, so they are always in force.
  const at = '2026-10-14T10:00:00Z';

  it('refuses a vehicle the zone refuses, and says which zone and why', async () => {
    const answer = await post('/roads/access', {
      latitude: 41.5,
      longitude: 2.5,
      at,
      vehicle: { fuel: 'diesel', standard: 'euro_3' },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.decision).toBe('denied');
    expect(answer.body.verdicts[0]).toMatchObject({
      zoneId: 'es-a',
      scheme: 'es_dgt',
      label: 'none',
    });
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });

  it('admits one it admits, and says unknown for one it cannot judge', async () => {
    const hybrid = await post('/roads/access', {
      latitude: 41.5,
      longitude: 2.5,
      at,
      vehicle: { fuel: 'hybrid', standard: 'euro_6' },
    });
    expect(hybrid.body.decision).toBe('allowed');
    const unknown = await post('/roads/access', { latitude: 41.5, longitude: 2.5, at });
    expect(unknown.body.decision).toBe('unknown');
  });

  it('is allowed with no verdicts where no zone covers the position', async () => {
    const answer = await post('/roads/access', { latitude: 45, longitude: 20, at });
    expect(answer.body).toMatchObject({ decision: 'allowed', verdicts: [] });
  });

  it('refuses a malformed vehicle rather than ignoring it', async () => {
    const answer = await post('/roads/access', {
      latitude: 41.5,
      longitude: 2.5,
      vehicle: { fuel: 'steam' },
    });
    expect(answer.status).toBe(422);
  });
});
