#!/usr/bin/env bun
/**
 * Prove that GoWay's directions follow roads.
 *
 * This is the one check that cannot pass while the defect it was written for
 * is present, and the defect is specific: `POST /routes` used to answer a
 * STRAIGHT LINE — two coordinates, the crow's distance, one invented
 * instruction — and the app drew it in the route's own colour beside an ETA. A
 * user could not tell it from an answer.
 *
 * Every assertion below is therefore about the SHAPE of the reply rather than
 * about it being 200, because the straight line was a 200:
 *
 *   * A great-circle distance is the shortest distance that exists between two
 *     points. A real road route is always LONGER. Barcelona → Madrid is
 *     505.4 km as the crow flies (WGS-84 mean radius); the A-2 is about 620 km. A reply at or below
 *     the great circle is a straight line no matter what it calls itself.
 *   * A straight line has TWO coordinates. A 600 km road route has hundreds.
 *   * A straight line has no turns. A road route names junctions and roads.
 *
 * It probes GoWay's own API rather than the engine, because the engine being
 * healthy is not the claim — the claim is that a caller of `@goway.to/sdk` gets
 * a real route. And it sends NO Authorization header, because `AGENTS.md` says
 * browsing, search and routing must work signed out, and a probe that
 * authenticates would not notice the day that stopped being true.
 *
 *     bun scripts/check-routing.mjs
 *     GOWAY_API_URL=http://127.0.0.1:3000 bun scripts/check-routing.mjs
 */

const API = (process.env.GOWAY_API_URL ?? 'https://api.goway.to').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.GOWAY_ROUTING_TIMEOUT_MS ?? 30_000);

/** Barcelona. */
const ORIGIN = { latitude: 41.3851, longitude: 2.1734 };
/** Madrid. */
const DESTINATION = { latitude: 40.4168, longitude: -3.7038 };

/**
 * Great-circle distance in metres.
 *
 * Spelled out rather than imported so this script depends on nothing that
 * could be wrong in the same way the thing it is checking is wrong. The mean
 * Earth radius is the WGS-84 one.
 */
function greatCircleMeters(a, b) {
  const R = 6_371_008.8;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const failures = [];
function check(condition, message) {
  if (condition) return true;
  failures.push(message);
  return false;
}

const CROW = greatCircleMeters(ORIGIN, DESTINATION);
const km = (metres) => `${(metres / 1000).toFixed(1)} km`;

console.log(`GoWay routing probe → ${API}`);
console.log(`Barcelona → Madrid, great circle ${km(CROW)}\n`);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

let response;
let body;
try {
  response = await fetch(`${API}/api/v1/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    // No Authorization. Routing is public; see the module docs.
    body: JSON.stringify({ origin: { coordinate: ORIGIN }, destination: { coordinate: DESTINATION }, mode: 'drive' }),
    signal: controller.signal,
  });
  body = await response.json();
} catch (error) {
  console.error(`✗ ${API} did not answer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

if (response.status !== 200) {
  const code = body?.error?.code ?? '(no code)';
  console.error(`✗ HTTP ${response.status} ${code}: ${body?.error?.message ?? ''}`);
  if (code === 'service_unavailable') {
    console.error('  ROUTING_VALHALLA_URL is unset on this deployment — there is no routing engine.');
  }
  process.exit(1);
}

const route = body?.routes?.[0];
if (!check(route !== undefined, 'the reply carries no route at all')) {
  console.error(`✗ ${failures[0]}`);
  process.exit(1);
}

const coordinates = route.geometry?.coordinates ?? [];
const maneuvers = (route.legs ?? []).flatMap((leg) => leg.maneuvers ?? []);
const named = maneuvers.filter((m) => typeof m.streetName === 'string' && m.streetName.length > 0);

// THE assertion. A straight line is exactly the great circle (or, for the
// fixture this replaced, 1.25× it — which is why the floor is not generous).
check(
  route.distanceMeters > CROW * 1.05,
  `the route is ${km(route.distanceMeters)} against a ${km(CROW)} great circle — that is a straight line, not a road route`,
);
// And an upper bound, because "longer than the crow" is also true of nonsense.
check(
  route.distanceMeters < CROW * 2,
  `the route is ${km(route.distanceMeters)}, more than twice the great circle — that is not a plausible drive`,
);
check(
  coordinates.length >= 200,
  `the geometry has ${coordinates.length} coordinates; a 600 km road has hundreds and a straight line has two`,
);
check(maneuvers.length >= 5, `the route has ${maneuvers.length} maneuvers; a real drive turns more than that`);
check(named.length >= 3, `only ${named.length} maneuvers name a road; the engine is not reading street names`);
check(route.durationSeconds > 3 * 3600, `${(route.durationSeconds / 3600).toFixed(1)} h is not a plausible time for this drive`);
check(route.mode === 'drive', `the route came back as mode "${route.mode}"`);

// Every point must be in Iberia. A route that leaves the box is a decoding bug
// — a mis-signed polyline puts the whole line in the wrong hemisphere, and it
// still renders as a confident blue line somewhere.
const outside = coordinates.filter(
  ([lon, lat]) => lon < -10 || lon > 5 || lat < 35 || lat > 44,
);
check(outside.length === 0, `${outside.length} coordinates fall outside Iberia, e.g. ${JSON.stringify(outside[0])}`);

console.log(`  distance     ${km(route.distanceMeters)}  (${(route.distanceMeters / CROW).toFixed(2)}× the great circle)`);
console.log(`  duration     ${(route.durationSeconds / 3600).toFixed(1)} h`);
console.log(`  geometry     ${coordinates.length} coordinates`);
console.log(`  maneuvers    ${maneuvers.length}, ${named.length} naming a road`);
console.log(`  first roads  ${named.slice(0, 4).map((m) => m.streetName).join(', ')}`);
console.log();

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log('✓ GoWay returned a real route: it follows roads, it turns, and it is longer than the crow flies.');
