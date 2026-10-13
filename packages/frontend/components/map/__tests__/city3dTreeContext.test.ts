/**
 * Owner report (Carrer de Mallorca, Barcelona): "the trees in the middle of
 * the city cover the whole street; in mountains, woods and parks it's fine".
 * Pinned here:
 *
 *  - a mapped tree beside a carriageway, a sidewalk, in a recorded row or in
 *    urban landuse is a STREET tree; one in a park or wood, or out in the
 *    country, is not — except at a kerb, where its crown is over the street;
 *  - no tree is ever drawn on a carriageway: one a little inside the kerb is
 *    moved square to it, one deep in the road is left out, and both are
 *    counted;
 *  - the carriageway is as wide as the street detail draws it (the road
 *    archive's lanes and `width`), and shared surfaces, tunnels and bridges
 *    have none at ground level.
 */
import { describe, expect, test } from 'bun:test';

import type { Point2 } from '@/components/map/engine/city3d/mesher';
import {
  type Carriageway,
  NO_TREE_CONTEXT,
  settleTrees,
  TREE_CONTEXT,
  type TreeContext,
} from '@/components/map/engine/city3d/treeContext';
import { roadContext } from '@/components/map/engine/city3d/workerTrees';
import { CITY_ROAD_LAYER } from '@/lib/map/cityRoads';
import { CITY_TILE_EXTENT } from '@/lib/map/cityTiles';
import { encodeLines, encodeTileLayers } from '@/scripts/citygen/mvtEncode';

/** Tile units of one metre throughout (except where a tile is decoded). */
const M = 1;

const square = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

/** A straight east–west carriageway along y = 100, 10 m kerb to kerb. */
const STREET: Carriageway = {
  points: [
    [0, 100],
    [1000, 100],
  ],
  halfWidthM: 5,
};

const context = (extra: Partial<TreeContext> = {}): TreeContext => ({
  ...NO_TREE_CONTEXT,
  carriageways: [STREET],
  ...extra,
});

const at = (x: number, y: number, street?: boolean) => ({
  id: x * 1000 + y,
  x,
  y,
  ...(street ? { street } : {}),
});

describe('a tree’s setting', () => {
  test('beside a carriageway it is a street tree; out in the country it is not', () => {
    const { trees, counts } = settleTrees(
      [at(100, 107), at(100, 100 - 5 - TREE_CONTEXT.nearCarriagewayM + 0.5), at(100, 400)],
      context(),
      M,
    );
    expect(trees.map((t) => t.street)).toEqual([true, true, false]);
    expect(counts).toEqual({ street: 2, nature: 1, nudged: 0, offCarriageway: 0 });
  });

  test('in a park or wood it keeps its park look — unless it stands at the kerb', () => {
    const park = [square(0, 103, 1000, 300)];
    const { trees } = settleTrees(
      [at(100, 106), at(100, 112), at(100, 200)],
      context({ nature: [park] }),
      M,
    );
    // 1 m from the kerb: over the street. 7 m and 95 m in: the park's.
    expect(trees.map((t) => t.street)).toEqual([true, false, false]);
  });

  test('a recorded row tree, a tree by a mapped sidewalk and one in urban landuse are street trees', () => {
    const sidewalk: Point2[] = [
      [0, 500],
      [1000, 500],
    ];
    const urban = [square(0, 700, 1000, 900)];
    const { trees } = settleTrees(
      [at(100, 400, true), at(100, 503), at(100, 800), at(100, 600)],
      context({ sidewalks: [sidewalk], urban: [urban] }),
      M,
    );
    expect(trees.map((t) => t.street)).toEqual([true, true, true, false]);
  });

  test('a recorded row tree inside a park is the park’s', () => {
    const park = [square(0, 300, 1000, 600)];
    const { trees } = settleTrees([at(100, 400, true)], context({ nature: [park] }), M);
    expect(trees[0].street).toBe(false);
  });

  test('distances are in metres, whatever the tile unit', () => {
    // Four units to the metre: 7 m from the kerb is 28 units.
    const street: Carriageway = {
      points: [
        [0, 400],
        [4000, 400],
      ],
      halfWidthM: 5,
    };
    const { trees } = settleTrees(
      [at(100, 400 + 4 * (5 + 7)), at(100, 400 + 4 * (5 + 9))],
      { ...NO_TREE_CONTEXT, carriageways: [street] },
      0.25,
    );
    expect(trees.map((t) => t.street)).toEqual([true, false]);
  });
});

describe('never on the carriageway', () => {
  test('a kerb tree a little inside is moved square to the kerb, and counted', () => {
    const { trees, counts } = settleTrees([at(300, 104)], context(), M);
    expect(counts.nudged).toBe(1);
    expect(trees[0].x).toBeCloseTo(300, 6);
    expect(trees[0].y).toBeCloseTo(100 + 5 + TREE_CONTEXT.kerbClearanceM, 6);
    expect(trees[0].street).toBe(true);
    // The other side of the road moves the other way.
    const other = settleTrees([at(300, 96)], context(), M).trees[0];
    expect(other.y).toBeCloseTo(100 - 5 - TREE_CONTEXT.kerbClearanceM, 6);
  });

  test('a tree deep in the road is not drawn, and counted', () => {
    const { trees, counts } = settleTrees([at(300, 101), at(300, 100)], context(), M);
    expect(trees).toHaveLength(0);
    expect(counts.offCarriageway).toBe(2);
  });

  test('a kerb tree moved into the crossing street is not drawn', () => {
    // A north–south carriageway crossing at x = 300: a tree at a corner of
    // the junction, inside both.
    const crossing: Carriageway = {
      points: [
        [300, 0],
        [300, 1000],
      ],
      halfWidthM: 5,
    };
    const { trees, counts } = settleTrees(
      [at(304, 104)],
      context({ carriageways: [STREET, crossing] }),
      M,
    );
    expect(trees).toHaveLength(0);
    expect(counts.offCarriageway).toBe(1);
  });

  test('whatever is mapped, no settled tree stands on a carriageway', () => {
    // A grid of streets of mixed widths and trees scattered over all of it.
    const carriageways: Carriageway[] = [];
    for (let k = 0; k < 5; k++) {
      carriageways.push({
        points: [
          [0, 100 + k * 180],
          [1000, 100 + k * 180 + 30],
        ],
        halfWidthM: 3 + k,
      });
      carriageways.push({
        points: [
          [100 + k * 200, 0],
          [100 + k * 200, 1000],
        ],
        halfWidthM: 4 + k / 2,
      });
    }
    const scattered = [];
    let seed = 7;
    for (let i = 0; i < 5000; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const x = (seed % 10_000) / 10;
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      scattered.push(at(x, (seed % 10_000) / 10));
    }
    const { trees, counts } = settleTrees(scattered, { ...NO_TREE_CONTEXT, carriageways }, M);
    expect(counts.nudged).toBeGreaterThan(0);
    expect(counts.offCarriageway).toBeGreaterThan(0);
    expect(trees.length + counts.offCarriageway).toBe(scattered.length);
    for (const tree of trees) {
      for (const c of carriageways) {
        const [[ax, ay], [bx, by]] = c.points;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((tree.x - ax) * (bx - ax) + (tree.y - ay) * (by - ay)) /
              ((bx - ax) ** 2 + (by - ay) ** 2),
          ),
        );
        const d = Math.hypot(tree.x - (ax + (bx - ax) * t), tree.y - (ay + (by - ay) * t));
        expect(d).toBeGreaterThanOrEqual(c.halfWidthM - 1e-6);
      }
    }
  });
});

describe('the carriageways, as the street detail draws them', () => {
  // A z15 road tile at Barcelona: one way of each kind across the middle.
  const tile = { z: 15, x: 16582, y: 12236 };
  const line = (y: number) =>
    encodeLines([
      [
        [0, y],
        [CITY_TILE_EXTENT, y],
      ],
    ]);
  const road = (y: number, properties: Record<string, string | number | boolean>) => ({
    id: 0,
    type: 2 as const,
    geometry: line(y),
    properties,
  });
  const bytes = encodeTileLayers([
    {
      name: CITY_ROAD_LAYER,
      features: [
        road(1000, { highway: 'secondary', car: true, foot: false, oneway: 1, lanes: 3 }),
        road(1100, { highway: 'residential', car: true, foot: true, width: 9, lanes: 2 }),
        road(1200, { highway: 'living_street', car: true, foot: true }),
        road(1300, { highway: 'pedestrian', car: true, foot: true }),
        road(1400, { highway: 'primary', car: true, foot: false, tunnel: true }),
        road(1500, { highway: 'primary', car: true, foot: false, bridge: true }),
        road(1600, { highway: 'footway', car: false, foot: true, footway: 'sidewalk' }),
        road(1700, { highway: 'footway', car: false, foot: true }),
      ],
    },
  ]);
  const view = new Uint8Array(bytes).buffer as ArrayBuffer;

  test('three recorded lanes, a recorded width; no shared surface, tunnel or bridge', () => {
    const { carriageways, sidewalks } = roadContext(view, tile, 4096);
    expect(carriageways.map((c) => c.points[0][1])).toEqual([1000, 1100]);
    // 3 × the secondary lane (3.25 m); the recorded 9 m.
    expect(carriageways[0].halfWidthM).toBeCloseTo((3 * 3.25) / 2, 6);
    expect(carriageways[1].halfWidthM).toBeCloseTo(4.5, 6);
    expect(sidewalks.map((s) => s[0][1])).toEqual([1600]);
  });

  test('in the city tile’s own units', () => {
    const { carriageways } = roadContext(view, tile, 512);
    expect(carriageways[0].points[0][1]).toBeCloseTo(125, 6);
  });
});
