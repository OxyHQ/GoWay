#!/usr/bin/env bun

// Proves check-routing.mjs can FAIL — and can pass.
//
// A gate that cannot fail is indistinguishable from one that cannot pass. Each
// case serves a fake GoWay API on a loopback port, runs the REAL script against
// it (exactly as CI runs it against api.goway.to), and asserts on the exit code
// and on what the script names:
//
//   * the straight line, as the API once answered and the fixture layer later
//     drew it (two coordinates, 1.25× the crow) — the defect itself;
//   * routes that are road-shaped but every one costed as a car — the "every
//     button gives me the same route" defect, which shape alone cannot catch;
//   * a road-shaped answer that is right in every mode, so a gate that fails
//     everything is caught too.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-routing.mjs');
const failures = [];

const R = 6_371_008.8;
const rad = (deg) => (deg * Math.PI) / 180;
function metres([lon1, lat1], [lon2, lat2]) {
  const h =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const lengthOf = (line) => line.slice(1).reduce((sum, p, i) => sum + metres(line[i], p), 0);

/** The straight-line answer, as `mockTransport.ts` drew it before this gate grew modes. */
function straightLine({ origin, destination, mode }) {
  const from = [origin.coordinate.longitude, origin.coordinate.latitude];
  const to = [destination.coordinate.longitude, destination.coordinate.latitude];
  const distance = metres(from, to) * 1.25;
  const speed = { drive: 8.3, bike: 4.2, walk: 1.35 }[mode];
  const maneuver = (type, at, index) => ({
    type,
    instruction: type === 'depart' ? 'Head toward the next stop' : 'You have arrived',
    distanceMeters: type === 'depart' ? distance : 0,
    durationSeconds: type === 'depart' ? distance / speed : 0,
    coordinate: { latitude: at[1], longitude: at[0] },
    geometryIndex: index,
  });
  return {
    id: 'fixture',
    mode,
    distanceMeters: distance,
    durationSeconds: distance / speed,
    geometry: { type: 'LineString', coordinates: [from, to] },
    legs: [
      {
        distanceMeters: distance,
        durationSeconds: distance / speed,
        maneuvers: [maneuver('depart', from, 0), maneuver('arrive', to, 1)],
      },
    ],
  };
}

/**
 * A staircase along a street grid: many short segments, a turn at every
 * corner, named streets. `costing` decides what the narrative says and how
 * fast it goes; `detour` overshoots and comes back, which is what a one-way
 * street does to a car.
 */
function staircase({ origin, destination, mode }, { costing, detour = 0 }) {
  const from = [origin.coordinate.longitude, origin.coordinate.latitude];
  const goal = [destination.coordinate.longitude, destination.coordinate.latitude];
  const corner = [goal[0] + (goal[0] - from[0]) * detour, goal[1] + (goal[1] - from[1]) * detour];
  const steps = 12;
  const perLeg = 12;
  const line = [from];
  const corners = [];
  for (let step = 0; step < steps; step += 1) {
    const [x] = line[line.length - 1];
    const nextY = from[1] + ((corner[1] - from[1]) * (step + 1)) / steps;
    const nextX = from[0] + ((corner[0] - from[0]) * (step + 1)) / steps;
    for (const target of [
      [x, nextY],
      [nextX, nextY],
    ]) {
      corners.push(line.length - 1);
      const [sx, sy] = line[line.length - 1];
      for (let i = 1; i <= perLeg; i += 1) {
        line.push([sx + ((target[0] - sx) * i) / perLeg, sy + ((target[1] - sy) * i) / perLeg]);
      }
    }
  }
  if (detour > 0) line.push(goal);

  const distance = lengthOf(line);
  const speed = { walk: 5, bike: 15, drive: 30 }[costing] / 3.6;
  const verb = { walk: 'Walk', bike: 'Bike', drive: 'Drive' }[costing];
  const way = { walk: 'the walkway', bike: 'the cycleway', drive: 'Carrer de Prova' }[costing];
  const at = (index) => ({ latitude: line[index][1], longitude: line[index][0] });
  const maneuvers = [
    {
      type: 'depart',
      instruction: `${verb} north on ${way}.`,
      distanceMeters: 0,
      durationSeconds: 0,
      coordinate: at(0),
      geometryIndex: 0,
      streetName: 'Carrer de Prova',
    },
    ...corners.slice(1).map((index, n) => ({
      type: n % 2 === 0 ? 'turn-right' : 'turn-left',
      instruction: `Turn onto ${way}.`,
      distanceMeters: 0,
      durationSeconds: 0,
      coordinate: at(index),
      geometryIndex: index,
      streetName: `Carrer ${n}`,
    })),
    {
      type: 'arrive',
      instruction: 'You have arrived at your destination.',
      distanceMeters: 0,
      durationSeconds: 0,
      coordinate: at(line.length - 1),
      geometryIndex: line.length - 1,
    },
  ];
  return {
    id: 'staircase',
    mode,
    distanceMeters: distance,
    durationSeconds: distance / speed,
    geometry: { type: 'LineString', coordinates: line },
    legs: [{ distanceMeters: distance, durationSeconds: distance / speed, maneuvers }],
  };
}

/** Run the real script against `answer(request) → route`. */
async function runAgainst(answer) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = await request.json();
      return Response.json({ routes: [answer(body)] });
    },
  });
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

async function expectFail(name, answer, patterns) {
  const { code, output } = await runAgainst(answer);
  if (code === 0) {
    failures.push(`${name}: expected the gate to fail, and it passed`);
    return;
  }
  for (const pattern of patterns) {
    if (!pattern.test(output)) failures.push(`${name}: expected ${pattern}, got:\n${output}`);
  }
}

await expectFail('the straight line', straightLine, [
  /a straight line has two/,
  /a line drawn across the map/,
  /not the length of the path shown/,
]);

await expectFail(
  'every mode costed as a car',
  (request) => staircase(request, { costing: 'drive' }),
  [
    /walk: the first instruction is .* not "Walk …"/,
    /bike: the first instruction is .* not "Bike …"/,
    /ignoring one-way streets/,
  ],
);

const right = (request) => {
  // A car going B→A in the Eixample takes the long way round.
  const backAcrossEixample =
    request.mode === 'drive' &&
    request.origin.coordinate.latitude === 41.3895 &&
    request.origin.coordinate.longitude === 2.167;
  return staircase(request, { costing: request.mode, detour: backAcrossEixample ? 0.2 : 0 });
};
{
  const { code, output } = await runAgainst(right);
  if (code !== 0) failures.push(`a right answer in every mode: expected a pass, got:\n${output}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(
  '✓ check-routing.mjs fails a straight line and a car route in every mode, and passes a right one.',
);
