#!/usr/bin/env bun
/**
 * Prove that GoWay's road rules reach a caller, signed out, end to end.
 *
 * The road-rules tables are filled by `bun run roadrules:sync`, an operator
 * command, so an API that answers 200 proves nothing: a deployment whose sync
 * never ran answers 200 with no countries, no zones and "allowed" everywhere.
 * Every assertion is about what the data SAYS:
 *
 *   * a position is put in its country — Barcelona in Spain, London in Great
 *     Britain — and a position at sea in none;
 *   * the side traffic keeps to is right: Spain right, Great Britain and Japan
 *     left, and Hong Kong left beside Shenzhen right, a border a table of
 *     boxes gets wrong;
 *   * Spain's zones are listed, each with its schedule or its honest "unknown"
 *     policy, its timezone, and the credit and licence it is owed;
 *   * `POST /roads/access` over Barcelona's low emission zone answers the way
 *     the regulation does — a diesel Euro 3 car refused in the zone's hours,
 *     a hybrid Euro 6 car admitted, the same diesel admitted on a Sunday, and
 *     a vehicle too little described answered "unknown", never "allowed";
 *   * a drive with a vehicle does not end up in a zone that refuses it.
 *
 * It sends NO Authorization header: `AGENTS.md` says browsing, search and
 * routing work signed out, and this is the same family of routes.
 *
 *     bun scripts/check-road-rules.mjs
 *     GOWAY_API_URL=http://127.0.0.1:3000 bun scripts/check-road-rules.mjs
 */

const API = (process.env.GOWAY_API_URL ?? 'https://api.goway.to').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.GOWAY_ROAD_RULES_TIMEOUT_MS ?? 30_000);

/** A weekday noon and a Sunday noon, in UTC: inside and outside any weekday zone's hours in Spain. */
const WEDNESDAY = '2026-10-14T10:00:00Z';
const SUNDAY = '2026-10-18T10:00:00Z';

/** Inside the Rondes de Barcelona zone: the Eixample. */
const EIXAMPLE = { latitude: 41.3925, longitude: 2.162 };
/** Two points outside Barcelona's Rondes, a city apart. */
const ESPLUGUES = { latitude: 41.3785, longitude: 2.085 };
const BADALONA = { latitude: 41.4505, longitude: 2.2475 };

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

async function call(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function rulesAt(label, latitude, longitude, expected) {
  const reply = await call('GET', `/roads/rules?latitude=${latitude}&longitude=${longitude}`);
  if (
    !check(
      reply.status === 200,
      `${label}: GET /roads/rules answered ${reply.status} ${reply.error ?? ''}`,
    )
  ) {
    return null;
  }
  const { countryCode, ruleSet } = reply.body;
  check(
    countryCode === expected.country,
    `${label}: in ${countryCode}, expected ${expected.country}`,
  );
  if (expected.side) {
    check(
      ruleSet?.drivingSide === expected.side,
      `${label}: drives on the ${ruleSet?.drivingSide ?? '(no rule set)'}, expected ${expected.side}`,
    );
  }
  return reply.body;
}

const zoneIsComplete = (zone) =>
  zone.source?.attribution?.href?.startsWith('https://') &&
  zone.source?.licence?.href?.startsWith('https://') &&
  zone.timezone &&
  zone.policy &&
  zone.geometry?.type;

console.log(`GoWay road rules probe → ${API}\n`);

// ── Countries and the side of the road ───────────────────────────────────────
const barcelona = await rulesAt('Barcelona', EIXAMPLE.latitude, EIXAMPLE.longitude, {
  country: 'ES',
  side: 'right',
});
await rulesAt('London', 51.5074, -0.1278, { country: 'GB', side: 'left' });
await rulesAt('Tokyo', 35.6762, 139.6503, { country: 'JP', side: 'left' });
await rulesAt('Hong Kong', 22.3193, 114.1694, { country: 'HK', side: 'left' });
await rulesAt('Shenzhen', 22.5431, 114.0579, { country: 'CN', side: 'right' });
await rulesAt('the mid-Atlantic', 30, -40, { country: null });

if (barcelona) {
  const speeds = barcelona.ruleSet?.speedLimitsKmh ?? {};
  check(
    Object.keys(speeds).length > 0,
    'Spain has no implicit speeds: the default speed limits were not synced',
  );
  check(
    barcelona.zones.some((z) => /barcelona/i.test(z.name)),
    "no zone covers Barcelona's Eixample: the low emission zones were not synced",
  );
}

// ── Zones are listed with what they are owed ─────────────────────────────────
{
  const reply = await call('GET', '/roads/zones?country=ES&limit=200');
  if (check(reply.status === 200, `GET /roads/zones answered ${reply.status}`)) {
    const zones = reply.body.items ?? [];
    check(zones.length >= 10, `Spain lists ${zones.length} zones, expected at least 10`);
    for (const zone of zones) {
      check(
        zoneIsComplete(zone),
        `${zone.id}: lacks its credit, licence, timezone, policy or geometry`,
      );
    }
  }
}

// ── The access decision answers as the regulation does ───────────────────────
async function access(vehicle, at) {
  const reply = await call('POST', '/roads/access', { ...EIXAMPLE, vehicle, at });
  check(reply.status === 200, `POST /roads/access answered ${reply.status} ${reply.error ?? ''}`);
  return reply.body;
}
{
  const old = await access({ fuel: 'diesel', standard: 'euro_3' }, WEDNESDAY);
  check(
    old?.decision === 'denied',
    `a diesel Euro 3 car in the zone on a weekday: ${old?.decision}, expected denied`,
  );
  check(
    old?.verdicts?.some((v) => v.decision === 'denied' && v.label),
    'the refusal does not say which label decided it',
  );
  const clean = await access({ fuel: 'hybrid', standard: 'euro_6' }, WEDNESDAY);
  check(
    clean?.decision === 'allowed',
    `a hybrid Euro 6 car on a weekday: ${clean?.decision}, expected allowed`,
  );
  const sunday = await access({ fuel: 'diesel', standard: 'euro_3' }, SUNDAY);
  check(
    sunday?.decision === 'allowed',
    `the same diesel on a Sunday: ${sunday?.decision}, expected allowed`,
  );
  const vague = await access({ user: 'car' }, WEDNESDAY);
  check(
    vague?.decision === 'unknown',
    `a car with no fuel or standard: ${vague?.decision}, expected unknown — never allowed`,
  );
}

// ── A drive with a vehicle stays out of a zone that refuses it ──────────────
async function drive(vehicle) {
  const reply = await call('POST', '/routes', {
    origin: { coordinate: ESPLUGUES },
    destination: { coordinate: BADALONA },
    mode: 'drive',
    locale: 'en-US',
    departureAt: WEDNESDAY,
    ...(vehicle ? { vehicle } : {}),
  });
  if (reply.status !== 200) {
    check(
      false,
      `POST /routes answered ${reply.status} ${reply.body?.error?.code ?? reply.error ?? ''}`,
    );
    return null;
  }
  return reply.body.routes?.[0] ?? null;
}
{
  const plain = await drive(null);
  const diesel = await drive({ fuel: 'diesel', standard: 'euro_3' });
  if (plain && diesel) {
    const refused = (diesel.zones ?? []).filter((z) => z.decision === 'denied');
    check(
      refused.length === 0,
      `a diesel Euro 3 route enters ${refused.map((z) => z.name).join(', ')}, which refuses it`,
    );
    const entered = (plain.zones ?? []).length > 0;
    console.log(
      entered
        ? `  the plain drive enters ${plain.zones.length} zone(s); the diesel route avoids them ` +
            `(${(diesel.distanceMeters / 1000).toFixed(1)} km against ${(plain.distanceMeters / 1000).toFixed(1)} km)`
        : '  the plain drive crosses no zone on this trip, so avoidance was not exercised',
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(
  '✓ GoWay puts positions in countries, knows the side of the road, lists zones with their credit, and answers who may enter.',
);
