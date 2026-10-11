/**
 * Worldwide: the basemap's `transportation` layer healed into a road graph
 * where no compiled road archive exists — classification, snapping,
 * T-junctions, crossings at grade (and not through bridges), footway
 * crossings, fragments, synthesised signals, cutting to tiles — and the
 * healed graph driven without overlaps.
 */
import { describe, expect, test } from 'bun:test';

import { encodeLines, encodeTileLayers } from '../../../scripts/citygen/mvtEncode';
import {
  classifyOmt,
  decodeOmtRoads,
  healRoads,
  MIN_COMPONENT_M,
  type OmtLine,
  piecesForTiles,
} from '../engine/cityLife/omtRoads';
import { buildNetwork, simFrame } from '../engine/cityLife/sim/network';
import { CitySimulation } from '../engine/cityLife/sim/simulation';

const ORIGIN = { x: 16584, y: 12231 };
const frame = simFrame(ORIGIN.x, ORIGIN.y);
const m = frame.metresPerUnit;
/** Local metres (x east, y north from the origin tile's NW corner) → global z15 units. */
const g = (x: number, y: number): [number, number] => [
  ORIGIN.x * 4096 + x / m,
  ORIGIN.y * 4096 - y / m,
];
const line = (points: [number, number][], props: Partial<OmtLine> = {}): OmtLine => ({
  highway: 'residential',
  car: true,
  foot: false,
  tunnel: false,
  level: '0',
  ...props,
  points: points.map(([x, y]) => g(x, y)),
});
const ends = (pieces: { points: [number, number][] }[]) => {
  const count = new Map<string, number>();
  for (const p of pieces) {
    for (const e of [p.points[0], p.points[p.points.length - 1]]) {
      const key = `${e[0]},${e[1]}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  return count;
};

describe('classifying the basemap', () => {
  test('car classes, links, one-way, private service, footways; everything else dropped', () => {
    expect(classifyOmt({ class: 'minor' })?.highway).toBe('residential');
    expect(classifyOmt({ class: 'primary', ramp: 1 })?.highway).toBe('primary_link');
    expect(classifyOmt({ class: 'secondary', oneway: 1 })?.oneway).toBe(1);
    expect(classifyOmt({ class: 'secondary', oneway: -1 })?.oneway).toBe(-1);
    expect(classifyOmt({ class: 'motorway' })?.oneway).toBe(1);
    expect(classifyOmt({ class: 'service', service: 'parking_aisle' })).toBeNull();
    expect(classifyOmt({ class: 'path', subclass: 'footway' })).toMatchObject({
      car: false,
      foot: true,
    });
    expect(classifyOmt({ class: 'path', subclass: 'cycleway' })).toBeNull();
    expect(classifyOmt({ class: 'rail' })).toBeNull();
    expect(classifyOmt({ class: 'minor', brunnel: 'bridge' })?.level).toBe('bridge0');
  });
});

describe('healing', () => {
  test('ends a few metres apart become one junction', () => {
    const { pieces, stats } = healRoads(
      [
        line([
          [0, 0],
          [100, 0],
        ]),
        line([
          [101.5, 0.8],
          [200, 0],
        ]),
        line([
          [100.5, -1],
          [100, -150],
        ]),
      ],
      m,
    );
    expect(stats.snappedEnds).toBeGreaterThan(0);
    expect(Math.max(...ends(pieces).values())).toBe(3);
  });

  test('an end on another line’s interior splits it: a T-junction', () => {
    const { pieces, stats } = healRoads(
      [
        line([
          [0, 0],
          [300, 0],
        ]),
        line([
          [150, 1.5],
          [150, 200],
        ]),
      ],
      m,
    );
    expect(stats.tJunctions).toBe(1);
    expect(pieces.length).toBe(3);
    expect(Math.max(...ends(pieces).values())).toBe(3);
  });

  test('roads crossing at grade are split into a junction; a bridge is not', () => {
    const atGrade = healRoads(
      [
        line([
          [0, 0],
          [300, 0],
        ]),
        line([
          [150, -150],
          [150, 150],
        ]),
      ],
      m,
    );
    expect(atGrade.pieces.length).toBe(4);
    expect(Math.max(...ends(atGrade.pieces).values())).toBe(4);
    const bridge = healRoads(
      [
        line([
          [0, 0],
          [300, 0],
        ]),
        line(
          [
            [150, -150],
            [150, 150],
          ],
          { level: 'bridge1' },
        ),
      ],
      m,
    );
    expect(bridge.pieces.length).toBe(2);
  });

  test('a footway crossing a road becomes a crossing there', () => {
    const { pieces } = healRoads(
      [
        line([
          [0, 0],
          [300, 0],
        ]),
        line(
          [
            [150, -100],
            [150, 100],
          ],
          { car: false, foot: true, highway: 'footway' },
        ),
      ],
      m,
    );
    const foot = pieces.filter((p) => p.foot);
    expect(foot.length).toBe(2);
    expect(foot.every((p) => p.footway === 'crossing')).toBe(true);
  });

  test('fragments under the minimum length are dropped', () => {
    const { pieces, stats } = healRoads(
      [
        line([
          [0, 0],
          [300, 0],
        ]),
        line([
          [0, 500],
          [MIN_COMPONENT_M / 3, 500],
        ]),
      ],
      m,
    );
    expect(pieces.length).toBe(1);
    expect(stats.droppedFragments).toBe(1);
  });

  test('signals only where two major roads meet', () => {
    const major = healRoads(
      [
        line(
          [
            [0, 0],
            [300, 0],
          ],
          { highway: 'primary' },
        ),
        line(
          [
            [150, -150],
            [150, 150],
          ],
          { highway: 'secondary' },
        ),
      ],
      m,
    );
    expect(major.nodes.length).toBe(1);
    const minor = healRoads(
      [
        line([
          [0, 0],
          [300, 0],
        ]),
        line([
          [150, -150],
          [150, 150],
        ]),
      ],
      m,
    );
    expect(minor.nodes.length).toBe(0);
  });

  test('cut to tiles: only the tiles asked for, each piece inside its tile', () => {
    const healed = healRoads(
      [
        line([
          [100, -100],
          [5000, -100],
        ]),
      ],
      m,
    );
    const keep = new Set([`${ORIGIN.x}/${ORIGIN.y}`, `${ORIGIN.x + 2}/${ORIGIN.y}`]);
    const tiles = piecesForTiles(healed, keep);
    expect([...tiles.keys()].sort()).toEqual([...keep].sort());
    for (const [key, tile] of tiles) {
      const [tx] = key.split('/').map(Number);
      for (const piece of tile.pieces) {
        for (const [x] of piece.points) {
          expect(x).toBeGreaterThanOrEqual(tx * 4096 - 1e-6);
          expect(x).toBeLessThanOrEqual((tx + 1) * 4096 + 1e-6);
        }
      }
    }
  });
});

describe('decoding a basemap tile', () => {
  test('roads clipped to the tile, in global z15 units', () => {
    const bytes = encodeTileLayers([
      {
        name: 'transportation',
        features: [
          {
            id: 1,
            type: 2,
            geometry: encodeLines([
              [
                [-200, 100],
                [5000, 100],
              ],
            ]),
            properties: { class: 'primary' },
          },
          {
            id: 2,
            type: 2,
            geometry: encodeLines([
              [
                [0, 200],
                [4096, 200],
              ],
            ]),
            properties: { class: 'rail' },
          },
        ],
      },
    ]);
    const lines = decodeOmtRoads(bytes, { z: 14, x: 100, y: 50 }, 'transportation');
    expect(lines.length).toBe(1);
    const xs = lines[0].points.map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(100 * 8192, 3);
    expect(Math.max(...xs)).toBeCloseTo(101 * 8192, 3);
    expect(lines[0].points[0][1]).toBeCloseTo(50 * 8192 + 200, 3);
  });
});

describe('driving the healed graph', () => {
  test('cars on a healed grid never overlap, and keep to their side', () => {
    const lines: OmtLine[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push(
        line(
          [
            [100, -100 - i * 150],
            [600, -100 - i * 150],
          ],
          { highway: i === 1 ? 'primary' : 'residential' },
        ),
      );
      // Vertical lines miss the horizontals by a metre or two: the basemap's sloppiness.
      lines.push(
        line(
          [
            [100 + i * 150 + 1, -98],
            [100 + i * 150 - 1, -553],
          ],
          { highway: i === 2 ? 'secondary' : 'residential' },
        ),
      );
    }
    const healed = healRoads(lines, m);
    const tiles = piecesForTiles(healed, new Set([`${ORIGIN.x}/${ORIGIN.y}`]));
    const network = buildNetwork({
      tiles: [...tiles].map(([key, data]) => {
        const [x, y] = key.split('/').map(Number);
        return { x, y, data, source: 'basemap' };
      }),
      frame,
      drivingSide: 'left',
      seed: 3,
    });
    expect(network.stats.signals).toBeGreaterThan(0);
    const sim = new CitySimulation({ cars: 120, people: 0 }, 4);
    sim.setNetwork(network);
    sim.setView({ cx: 350, cy: -330, zoom: 18, box: { x0: 0, y0: -700, x1: 700, y1: 0 } });
    let checked = 0;
    for (let step = 0; step < 1200; step++) {
      sim.step();
      const byPath = new Map<number, number[]>();
      for (let car = 0; car < sim.cars.capacity; car++) {
        if (!sim.cars.alive[car]) continue;
        const list = byPath.get(sim.cars.path[car]) ?? [];
        list.push(car);
        byPath.set(sim.cars.path[car], list);
      }
      for (const list of byPath.values()) {
        list.sort((a, b) => sim.cars.s[a] - sim.cars.s[b]);
        for (let k = 1; k < list.length; k++) {
          const gap =
            sim.cars.s[list[k]] -
            sim.cars.s[list[k - 1]] -
            (sim.cars.length[list[k]] + sim.cars.length[list[k - 1]]) / 2;
          expect(gap).toBeGreaterThan(-0.01);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    // Left-hand traffic: an eastbound lane on a horizontal street is NORTH of its centre line.
    const eastbound = network.lanes
      .map((id) => network.paths[id])
      .find((p) => p.xs[p.xs.length - 1] - p.xs[0] > 50 && Math.abs(p.ys[0] + 100) < 10);
    expect(eastbound).toBeDefined();
    expect((eastbound?.ys[0] ?? 0) + 100).toBeGreaterThan(0);
  });
});
