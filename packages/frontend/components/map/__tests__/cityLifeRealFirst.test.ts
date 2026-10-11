/**
 * Real first: where the live layer has fresh real vehicles of a class, the
 * simulation runs none of that class — none spawn there, and those already
 * there fade out — while classes with no real source (cars, people) stay
 * simulated. Stale coverage owns nothing.
 */
import { describe, expect, test } from 'bun:test';

import type { DecodedRoadTile, RoadPiece } from '../engine/cityLife/roadTiles';
import {
  LIVE_COVERAGE_KINDS,
  type LiveCoverage,
  type LiveCoverageKind,
  liveCoverageTileOf,
} from '@/lib/live/coverage';

import { coveredTiles, liveClassesInView } from '../engine/cityLife/realCoverage';
import { buildNetwork, simFrame } from '../engine/cityLife/sim/network';
import { CitySimulation } from '../engine/cityLife/sim/simulation';

const ORIGIN = { x: 16584, y: 12231 };
const frame = simFrame(ORIGIN.x, ORIGIN.y);
const g = (x: number, y: number): [number, number] => [
  Math.round(ORIGIN.x * 4096 + x / frame.metresPerUnit),
  Math.round(ORIGIN.y * 4096 - y / frame.metresPerUnit),
];
const road = (points: [number, number][], way: number): RoadPiece => ({
  way,
  highway: 'secondary',
  car: true,
  foot: false,
  roundabout: false,
  tunnel: false,
  lanes: 2,
  points: points.map(([x, y]) => g(x, y)),
});

/** A 3 × 3 grid of 50 km/h streets inside one z12 tile. */
function grid() {
  const pieces: RoadPiece[] = [];
  const at = (i: number) => 150 + i * 150;
  let way = 1;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      pieces.push(
        road(
          [
            [at(j), -at(i)],
            [at(j + 1), -at(i)],
          ],
          way++,
        ),
      );
      pieces.push(
        road(
          [
            [at(i), -at(j)],
            [at(i), -at(j + 1)],
          ],
          way++,
        ),
      );
    }
  }
  const data: DecodedRoadTile = { pieces, nodes: [], restrictions: [] };
  return buildNetwork({ tiles: [{ ...ORIGIN, data }], frame, drivingSide: 'right', seed: 1 });
}

/** The z12 tile the grid is in. */
const GRID_TILE = `${Math.floor(ORIGIN.x / 8)}/${Math.floor(ORIGIN.y / 8)}`;
const view = { cx: 300, cy: -300, zoom: 18, box: { x0: 0, y0: -600, x1: 600, y1: 0 } };

function busesAlive(sim: CitySimulation): number {
  const [from, to] = sim.cars.ranges.bus;
  let n = 0;
  for (let i = from; i < to; i++) if (sim.cars.alive[i] && sim.cars.leaving[i] < 0) n++;
  return n;
}

function run(steps: number, setup?: (sim: CitySimulation) => void) {
  const sim = new CitySimulation({ cars: 400, people: 0 }, 21);
  setup?.(sim);
  sim.setNetwork(grid());
  sim.setView(view);
  for (let i = 0; i < steps; i++) sim.step();
  return sim;
}

/** A coverage on the live layer's channel: the given kinds, every other one empty. */
function coverageOf(
  kinds: Partial<Record<LiveCoverageKind, { tiles: string[]; fresh: boolean }>>,
): LiveCoverage {
  return {
    kinds: Object.fromEntries(
      LIVE_COVERAGE_KINDS.map((kind) => [
        kind,
        { tiles: new Set(kinds[kind]?.tiles ?? []), fresh: kinds[kind]?.fresh ?? false },
      ]),
    ) as LiveCoverage['kinds'],
  };
}

describe('real first', () => {
  test('without real coverage, buses are simulated (vacuity)', () => {
    expect(busesAlive(run(100))).toBeGreaterThan(0);
  });

  test('fresh real bus coverage: no simulated bus spawns there, cars still do', () => {
    const sim = run(400, (s) => s.setRealCoverage({ bus: [GRID_TILE] }));
    const [from, to] = sim.cars.ranges.bus;
    for (let i = from; i < to; i++) expect(sim.cars.alive[i]).toBe(0);
    expect(sim.stats.cars).toBeGreaterThan(50);
  });

  test('coverage arriving later fades out the simulated buses already there', () => {
    const sim = run(100);
    expect(busesAlive(sim)).toBeGreaterThan(0);
    sim.setRealCoverage({ bus: [GRID_TILE] });
    for (let i = 0; i < 40; i++) sim.step();
    expect(busesAlive(sim)).toBe(0);
    expect(sim.simulatedInView().buses).toBe(0);
  });

  test('coverage elsewhere, or of another class, changes nothing', () => {
    const elsewhere = run(100, (s) => s.setRealCoverage({ bus: ['0/0'] }));
    expect(busesAlive(elsewhere)).toBeGreaterThan(0);
    const trams = run(100, (s) => s.setRealCoverage({ tram: [GRID_TILE] }));
    expect(busesAlive(trams)).toBeGreaterThan(0);
  });

  test('only FRESH coverage owns tiles; stale and empty coverage own nothing', () => {
    const coverage = coverageOf({
      bus: { tiles: ['2073/1528'], fresh: true },
      tram: { tiles: ['2073/1528'], fresh: false },
      metro: { tiles: [], fresh: true },
    });
    expect(coveredTiles(coverage)).toEqual({ bus: ['2073/1528'] });
    expect(coveredTiles(coverageOf({}))).toEqual({});
  });

  test('tiles and what is live in view', () => {
    // The middle of the grid's z15 tile is in its z12 tile.
    const n = 2 ** 15;
    const lng = ((ORIGIN.x + 0.5) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ORIGIN.y + 0.5)) / n))) * 180) / Math.PI;
    // The live layer's own tile key agrees with the simulation's tiles.
    expect(liveCoverageTileOf(lat, lng)).toBe(GRID_TILE);
    const coverage = coverageOf({ bus: { tiles: [GRID_TILE], fresh: true } });
    const around = { west: lng - 0.002, south: lat - 0.002, east: lng + 0.002, north: lat + 0.002 };
    expect(liveClassesInView(coverage, around)).toEqual(['bus']);
    expect(
      liveClassesInView(coverage, { west: 2.5, south: 41.6, east: 2.51, north: 41.61 }),
    ).toEqual([]);
  });
});
