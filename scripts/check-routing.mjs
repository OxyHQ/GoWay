#!/usr/bin/env bun
/**
 * Prove that GoWay's directions follow roads, in EVERY travel mode.
 *
 * This is the one check that cannot pass while the defect it was written for
 * is present, and the defect is specific: `POST /routes` used to answer a
 * STRAIGHT LINE — two coordinates, the crow's distance, one invented
 * instruction — and the app drew it in the route's own colour beside an ETA. A
 * user could not tell it from an answer. Later the local fixture layer drew
 * the same line at 1.25× the crow's distance, and the owner's report was the
 * same sentence: walking, cycling and driving "always send me in a straight
 * line".
 *
 * Every assertion is therefore about the SHAPE of the reply rather than about
 * it being 200, because the straight line was a 200. Each route must:
 *
 *   * be the mode it was asked for — `mode` echoed, and the engine's own first
 *     instruction says "Drive", "Walk" or "Bike". That sentence is written by
 *     the costing model (auto, pedestrian, bicycle), so it proves the button →
 *     SDK → API → costing chain end to end, which `mode` alone does not;
 *   * be longer than the great circle, and not absurdly so;
 *   * be DRAWN as a road: many points, no segment longer than a quarter of the
 *     route, and a drawn length that matches the distance it reports (the
 *     1.25× fixture drew the crow's line under a 1.25× number);
 *   * turn, name streets, and place each maneuver on its own line;
 *   * move at a speed that belongs to the mode;
 *   * stay inside Iberia (a mis-signed polyline still draws a confident line).
 *
 * And the modes must DIFFER the way the street network says they differ:
 *
 *   * a walk takes walkways or stairs that a drive never does;
 *   * a ride takes cycleways — the Diagonal's and Madrid Río's — that a drive
 *     never does;
 *   * a drive obeys one-way streets: across the Eixample grid A→B and B→A are
 *     different routes for a car and the same route on foot;
 *   * on one trip, walking is slower than cycling and cycling slower than
 *     driving.
 *
 * It probes GoWay's own API rather than the engine, because the engine being
 * healthy is not the claim — the claim is that a caller of `@goway.to/sdk` gets
 * a real route. And it sends NO Authorization header, because `AGENTS.md` says
 * browsing, search and routing must work signed out, and a probe that
 * authenticates would not notice the day that stopped being true.
 *
 *     bun scripts/check-routing.mjs
 *     GOWAY_API_URL=http://127.0.0.1:3000 bun scripts/check-routing.mjs
 *
 * The places are in Spain because that is what GoWay's engine covers
 * (`packages/routing-engine/README.md`).
 */

const API = (process.env.GOWAY_API_URL ?? 'https://api.goway.to').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.GOWAY_ROUTING_TIMEOUT_MS ?? 30_000);
/** The engine's narrative is matched in English, so it is asked for in English. */
const LOCALE = 'en-US';

const BARCELONA = { latitude: 41.3851, longitude: 2.1734 };
const MADRID = { latitude: 40.4168, longitude: -3.7038 };
/** Plaça de Francesc Macià → Glòries: the length of the Diagonal, cycle lanes on both sides. */
const MACIA = { latitude: 41.3926, longitude: 2.1428 };
const GLORIES = { latitude: 41.4036, longitude: 2.1874 };
/** Plaça de Catalunya → the Cathedral, into the pedestrian Gothic Quarter. */
const PLACA_CATALUNYA = { latitude: 41.387, longitude: 2.17 };
const CATEDRAL = { latitude: 41.384, longitude: 2.1762 };
/** Two corners of the Eixample, whose streets are one-way and alternate. */
const EIXAMPLE_A = { latitude: 41.3925, longitude: 2.162 };
const EIXAMPLE_B = { latitude: 41.3895, longitude: 2.167 };
/** Puente de Segovia → Matadero: along Madrid Río's riverside paths. */
const PUENTE_SEGOVIA = { latitude: 40.4153, longitude: -3.7224 };
const MATADERO = { latitude: 40.392, longitude: -3.6975 };
/** Atocha → Plaza de Castilla: the Castellana, end to end. */
const ATOCHA = { latitude: 40.4065, longitude: -3.6893 };
const PLAZA_CASTILLA = { latitude: 40.4667, longitude: -3.689 };

/** The verb each costing model's first instruction opens with. */
const DEPART_VERB = { drive: 'Drive', walk: 'Walk', bike: 'Bike' };

/** km/h a route in each mode may average; a straight line at a fixed speed fits any one of them. */
const SPEED_KMH = { walk: [2.5, 7], bike: [8, 30], drive: [12, 140] };

/** Ways only a pedestrian takes, in the engine's narrative. */
const PEDESTRIAN_WAYS = /\b(walkway|footway|stairs|steps|pedestrian)\b/i;
/** Ways only a cyclist takes. */
const CYCLE_WAYS = /\b(cycleway|cycle lane|bike path|bike lane)\b/i;

/**
 * What to ask, and what the answer must show beyond following roads.
 *
 * `maxRatio` is the plausible ceiling on distance over the great circle: a
 * short urban trip around one-way blocks and a pedestrian zone can be several
 * times the crow's distance by car, a 600 km motorway trip cannot.
 */
const TRIPS = [
  {
    id: 'bcn-mad',
    label: 'Barcelona → Madrid',
    from: BARCELONA,
    to: MADRID,
    modes: ['drive'],
    maxRatio: 2,
    minCoordinates: 200,
  },
  {
    id: 'diagonal',
    label: 'Barcelona, Francesc Macià → Glòries',
    from: MACIA,
    to: GLORIES,
    modes: ['drive', 'walk', 'bike'],
    maxRatio: 3,
    minCoordinates: 40,
    cycleways: true,
  },
  {
    id: 'gotic',
    label: 'Barcelona, Plaça de Catalunya → Catedral',
    from: PLACA_CATALUNYA,
    to: CATEDRAL,
    modes: ['drive', 'walk'],
    maxRatio: 5,
    minCoordinates: 20,
    pedestrianWays: true,
  },
  {
    id: 'eixample-ab',
    label: 'Barcelona, Eixample A → B',
    from: EIXAMPLE_A,
    to: EIXAMPLE_B,
    modes: ['drive', 'walk'],
    maxRatio: 4,
    minCoordinates: 10,
  },
  {
    id: 'eixample-ba',
    label: 'Barcelona, Eixample B → A',
    from: EIXAMPLE_B,
    to: EIXAMPLE_A,
    modes: ['drive', 'walk'],
    maxRatio: 4,
    minCoordinates: 10,
  },
  {
    id: 'madrid-rio',
    label: 'Madrid, Puente de Segovia → Matadero',
    from: PUENTE_SEGOVIA,
    to: MATADERO,
    modes: ['drive', 'walk', 'bike'],
    maxRatio: 3,
    minCoordinates: 40,
    cycleways: true,
    pedestrianWays: true,
  },
  {
    id: 'castellana',
    label: 'Madrid, Atocha → Plaza de Castilla',
    from: ATOCHA,
    to: PLAZA_CASTILLA,
    modes: ['drive', 'walk', 'bike'],
    maxRatio: 2,
    minCoordinates: 40,
  },
];

/**
 * Great-circle distance in metres, between `{latitude, longitude}` points.
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
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const point = ([longitude, latitude]) => ({ latitude, longitude });
const km = (metres) =>
  metres >= 10_000 ? `${(metres / 1000).toFixed(0)} km` : `${(metres / 1000).toFixed(2)} km`;

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

async function ask(trip, mode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}/api/v1/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // No Authorization. Routing is public; see the module docs.
      body: JSON.stringify({
        origin: { coordinate: trip.from },
        destination: { coordinate: trip.to },
        mode,
        locale: LOCALE,
      }),
      signal: controller.signal,
    });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Every per-route assertion. Returns the route's measurements, or null. */
function inspect(trip, mode, reply) {
  const where = `${trip.label}, ${mode}`;
  if (reply.status !== 200) {
    const code = reply.body?.error?.code ?? reply.error ?? '(no code)';
    check(false, `${where}: HTTP ${reply.status} ${code} ${reply.body?.error?.message ?? ''}`);
    if (code === 'service_unavailable') {
      failures.push(`  ROUTING_VALHALLA_URL is unset on ${API} — there is no routing engine.`);
    }
    return null;
  }
  const route = reply.body?.routes?.[0];
  if (!check(route !== undefined, `${where}: the reply carries no route at all`)) return null;

  const crow = greatCircleMeters(trip.from, trip.to);
  const coordinates = route.geometry?.coordinates ?? [];
  const maneuvers = (route.legs ?? []).flatMap((leg) => leg.maneuvers ?? []);
  const named = maneuvers.filter((m) => typeof m.streetName === 'string' && m.streetName !== '');
  const turns = maneuvers.filter((m) => /^(turn-|roundabout|fork|uturn|merge)/.test(m.type));
  const narrative = maneuvers.map((m) => m.instruction ?? '').join('\n');

  let drawn = 0;
  let longest = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const segment = greatCircleMeters(point(coordinates[index - 1]), point(coordinates[index]));
    drawn += segment;
    longest = Math.max(longest, segment);
  }
  const ratio = route.distanceMeters / crow;
  const speed = route.distanceMeters / Math.max(1, route.durationSeconds) / (1000 / 3600);

  check(route.mode === mode, `${where}: the route came back as mode "${route.mode}"`);
  const verb = DEPART_VERB[mode];
  check(
    maneuvers[0]?.instruction?.startsWith(verb) === true,
    `${where}: the first instruction is "${maneuvers[0]?.instruction}", not "${verb} …" — the engine did not cost this as ${mode}`,
  );

  // Longer than the crow, by any margin: a straight avenue walked end to end
  // is barely longer than the great circle, so the floor is the great circle
  // itself and the line's SHAPE below is what tells a road from a ruler.
  check(
    route.distanceMeters > crow,
    `${where}: ${km(route.distanceMeters)} against a ${km(crow)} great circle — shorter than the crow flies`,
  );
  check(
    ratio < trip.maxRatio,
    `${where}: ${km(route.distanceMeters)} is ${ratio.toFixed(2)}× the great circle — not a plausible ${mode}`,
  );
  check(
    coordinates.length >= trip.minCoordinates,
    `${where}: the geometry has ${coordinates.length} coordinates; a road route here has at least ${trip.minCoordinates}, a straight line has two`,
  );
  check(
    longest <= route.distanceMeters / 4,
    `${where}: one segment is ${km(longest)} of a ${km(route.distanceMeters)} route — that is a line drawn across the map, not along a road`,
  );
  check(
    Math.abs(drawn - route.distanceMeters) <= route.distanceMeters * 0.03,
    `${where}: the line drawn is ${km(drawn)} but the route says ${km(route.distanceMeters)} — the distance is not the length of the path shown`,
  );
  check(
    maneuvers.length >= 3 && turns.length >= 1,
    `${where}: ${maneuvers.length} maneuvers, ${turns.length} of them turns — a road route turns`,
  );
  check(named.length >= 1, `${where}: no maneuver names a street`);
  const misplaced = maneuvers.filter((m) => {
    const at = coordinates[m.geometryIndex];
    return (
      at === undefined ||
      Math.abs(at[0] - m.coordinate.longitude) > 1e-6 ||
      Math.abs(at[1] - m.coordinate.latitude) > 1e-6
    );
  });
  check(
    misplaced.length === 0,
    `${where}: ${misplaced.length} maneuvers are not on the route's own line (geometryIndex disagrees with coordinate)`,
  );
  const [slowest, fastest] = SPEED_KMH[mode];
  check(
    speed >= slowest && speed <= fastest,
    `${where}: ${speed.toFixed(1)} km/h is not a ${mode} speed (${slowest}–${fastest})`,
  );
  const outside = coordinates.filter(([lon, lat]) => lon < -10 || lon > 5 || lat < 35 || lat > 44);
  check(
    outside.length === 0,
    `${where}: ${outside.length} coordinates fall outside Iberia, e.g. ${JSON.stringify(outside[0])}`,
  );

  // What only this mode may do.
  if (mode === 'drive') {
    check(
      !PEDESTRIAN_WAYS.test(narrative) && !CYCLE_WAYS.test(narrative),
      `${where}: a car was sent along a walkway, stairs or a cycleway`,
    );
    check(!maneuvers.some((m) => m.type === 'steps-enter'), `${where}: a car was sent up stairs`);
  }
  if (mode === 'walk' && trip.pedestrianWays) {
    check(
      PEDESTRIAN_WAYS.test(narrative) || maneuvers.some((m) => m.type === 'steps-enter'),
      `${where}: the walk takes no walkway, footway or stairs — it is routed like a car`,
    );
  }
  if (mode === 'bike' && trip.cycleways) {
    check(
      CYCLE_WAYS.test(narrative),
      `${where}: the ride takes no cycleway on a trip lined with them — it is routed like a car`,
    );
  }

  return {
    distance: route.distanceMeters,
    duration: route.durationSeconds,
    ratio,
    speed,
    coordinates: coordinates.length,
    longest,
    maneuvers: maneuvers.length,
    turns: turns.length,
    first: maneuvers[0]?.instruction ?? '',
  };
}

console.log(`GoWay routing probe → ${API}\n`);

const jobs = TRIPS.flatMap((trip) => trip.modes.map((mode) => ({ trip, mode })));
const replies = await Promise.all(jobs.map(({ trip, mode }) => ask(trip, mode)));
/** `${trip.id}:${mode}` → measurements. */
const measured = new Map();

for (const [index, { trip, mode }] of jobs.entries()) {
  const result = inspect(trip, mode, replies[index]);
  if (result === null) continue;
  measured.set(`${trip.id}:${mode}`, result);
  console.log(
    `  ${`${trip.label}, ${mode}`.padEnd(48)} ${km(result.distance).padStart(9)}  ` +
      `${result.ratio.toFixed(2)}×  ${result.speed.toFixed(1).padStart(5)} km/h  ` +
      `${String(result.coordinates).padStart(5)} pts  ${String(result.turns).padStart(2)} turns  ` +
      `"${result.first}"`,
  );
}
console.log();

// On one trip, the modes are ordered by speed. Measured, not assumed: a
// fixture that divides one line by three constant speeds also orders them, so
// this only bites together with the per-route checks above.
for (const trip of TRIPS.filter((t) => t.modes.length === 3)) {
  const walk = measured.get(`${trip.id}:walk`);
  const bike = measured.get(`${trip.id}:bike`);
  const drive = measured.get(`${trip.id}:drive`);
  if (!walk || !bike || !drive) continue;
  check(
    walk.duration > bike.duration && bike.duration > drive.duration,
    `${trip.label}: walk ${walk.duration}s, bike ${bike.duration}s, drive ${drive.duration}s — not slowest to fastest`,
  );
}

// One-way streets. The Eixample alternates them, so a car going A→B and B→A
// drives two different routes; a pedestrian walks the same one both ways.
{
  const there = measured.get('eixample-ab:drive');
  const back = measured.get('eixample-ba:drive');
  if (there && back) {
    const asymmetry =
      Math.abs(there.distance - back.distance) / Math.min(there.distance, back.distance);
    check(
      asymmetry >= 0.05,
      `Eixample: a car drives ${km(there.distance)} there and ${km(back.distance)} back — the engine is ignoring one-way streets`,
    );
  }
  const walkThere = measured.get('eixample-ab:walk');
  const walkBack = measured.get('eixample-ba:walk');
  if (walkThere && walkBack) {
    const asymmetry =
      Math.abs(walkThere.distance - walkBack.distance) /
      Math.min(walkThere.distance, walkBack.distance);
    check(
      asymmetry <= 0.02,
      `Eixample: a walk is ${km(walkThere.distance)} there and ${km(walkBack.distance)} back — one-way streets are being applied to pedestrians`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(
  `✓ GoWay returned ${measured.size} real routes in drive, walk and bike: each follows roads, turns, ` +
    'is the mode it claims, and the modes differ the way the street network does.',
);
