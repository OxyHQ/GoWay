/**
 * Owner report on #126: "trees on top of buildings, trees at random
 * everywhere". The fixes, pinned:
 *
 *  - no tree (mapped or fill) stands inside a building footprint;
 *  - the fill is off unless asked for, and then only in mapped woods;
 *  - trees stand on the same ground as the buildings: the drawn terrain
 *    (in these cities a bare-earth model, measured — so not "de-noised", which
 *    only buried buildings on real knolls);
 *  - a fill whose basemap tile failed to fetch is marked incomplete (PR #126
 *    review) and retried on a schedule.
 */
import { describe, expect, test } from 'bun:test';

import { PbfWriter } from 'pbf';

import {
  createGround,
  GROUND,
  gridAt,
  groundGrid,
  sampleGroundGrid,
  TileGrounder,
} from '@/components/map/engine/city3d/terrainGround';
import { incompleteRetryMs } from '@/components/map/engine/city3d/tileScheduler';
import { standTrees, type TreePoint, type TreeSources } from '@/components/map/engine/city3d/trees';
import { dropTreesInBuildings, treesFor } from '@/components/map/engine/city3d/workerTrees';
import type { Point2 } from '@/components/map/engine/city3d/mesher';
import { isCity3dTreeFillRequested } from '@/lib/map/city3dTreesFlag';

const square = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
const tree = (x: number, y: number): TreePoint => ({ x, y, seed: 0.5, kind: 0, heightM: 10 });

describe('no tree stands in a building', () => {
  test('trees inside a footprint are dropped; in a courtyard (a hole) they stay', () => {
    // Tile units of 1 m: a 100 m block with a 40 m courtyard.
    const block = { rings: [square(0, 0, 100, 100), square(30, 30, 70, 70)] };
    const kept = dropTreesInBuildings(
      [tree(10, 10), tree(50, 50), tree(150, 50), tree(99, 1)],
      [block],
      1,
    );
    expect(kept.map((t) => [t.x, t.y])).toEqual([
      [50, 50],
      [150, 50],
    ]);
  });

  test('tile units and metres are told apart', () => {
    const kept = dropTreesInBuildings([tree(20, 20)], [{ rings: [square(0, 0, 10, 10)] }], 4);
    expect(kept).toHaveLength(0); // (20 m, 20 m) is unit (5, 5): inside.
  });
});

describe('the fill', () => {
  const sources = (): TreeSources => ({
    extent: 4096,
    wood: [[square(0, 0, 500, 500)]],
    park: [[square(1000, 1000, 2000, 2000)]],
    lawn: [],
    blocked: [],
    paths: [],
  });

  test('stands only in mapped woods — never in parks', () => {
    const points = standTrees(sources(), { x: 1, y: 1 }, 4096);
    expect(points.length).toBeGreaterThan(1000);
    expect(points.every((p) => p.x <= 500 && p.y <= 500)).toBe(true);
  });

  test('is off unless a build or a development tab asks for it', () => {
    expect(isCity3dTreeFillRequested({ enabled: false, development: true, search: '' })).toBe(
      false,
    );
    expect(
      isCity3dTreeFillRequested({
        enabled: false,
        development: false,
        search: '?city3dTreeFill=1',
      }),
    ).toBe(false);
    expect(
      isCity3dTreeFillRequested({ enabled: false, development: true, search: '?city3dTreeFill=1' }),
    ).toBe(true);
    expect(isCity3dTreeFillRequested({ enabled: true, development: false, search: '' })).toBe(true);
  });
});

/** A one-layer vector tile of points: the city tiles' `tree` layer. */
function treeTile(points: Point2[]): ArrayBuffer {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_: null, layer: PbfWriter) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, 'tree');
      points.forEach(([x, y], i) => {
        layer.writeMessage(
          2,
          (_f: null, f: PbfWriter) => {
            f.writeVarintField(1, i + 1);
            f.writeVarintField(3, 1);
            f.writePackedVarint(4, [9, (x << 1) ^ (x >> 31), (y << 1) ^ (y >> 31)]);
          },
          null,
        );
      });
      layer.writeVarintField(5, 4096);
    },
    null,
  );
  const bytes = pbf.finish();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('treesFor', () => {
  const layers = {
    landcover: 'landcover',
    landuse: 'landuse',
    water: 'water',
    transportation: 'transportation',
    building: 'building',
  };
  const request = (fillWoods: boolean) =>
    ({
      type: 'mesh',
      id: 1,
      tile: { z: 15, x: 16580, y: 12238 },
      url: '',
      sourceLayer: 'building',
      format: 'goway',
      lod: 0,
      trees: layers,
      treeFillWoods: fillWoods,
      treeFill: { url: 'parent', tile: { z: 14, x: 8290, y: 6119 }, mappedLayer: 'tree' },
    }) as const;
  const bytes = treeTile([
    [100, 100],
    [2000, 2000],
  ]);
  const footprints = { list: [{ rings: [square(1900, 1900, 2100, 2100)] }], extent: 4096 };

  test('mapped trees only by default: the one in a building is dropped, nothing fetched', async () => {
    let fetched = 0;
    const out = await treesFor({ ...request(false) }, bytes, 900, footprints, async () => {
      fetched++;
      return null;
    });
    expect(out.complete).toBe(true);
    expect(out.points).toHaveLength(1);
    expect(fetched).toBe(0);
  });

  test('a fill whose basemap tile failed to fetch is incomplete; a missing one (204) is not', async () => {
    const failed = await treesFor({ ...request(true) }, bytes, 900, footprints, async () => {
      throw new Error('network');
    });
    expect(failed.complete).toBe(false);
    expect(failed.points).toHaveLength(1);
    const missing = await treesFor({ ...request(true) }, bytes, 900, footprints, async () => null);
    expect(missing.complete).toBe(true);
  });

  test('an incomplete tile is asked for again at 2, 8 and 30 s, then left as it is', () => {
    expect([1, 2, 3, 4].map(incompleteRetryMs)).toEqual([2_000, 8_000, 30_000, null]);
  });
});

describe('the ground is the drawn terrain', () => {
  const size = GROUND.grid;
  const tile = { z: 14, x: 8290, y: 6119 };
  const n = 2 ** 14;
  const uOf = (lng: number) => ((lng + 180) / 360) * n - tile.x;

  test('exactly the terrain sampled on the grid: nothing filtered away', () => {
    const sampler = (lng: number, lat: number) => 20 + 300 * (lng - 2.16) + 90 * (lat - 41.38);
    expect([...groundGrid(tile, sampler)]).toEqual([...sampleGroundGrid(tile, size, sampler)]);
  });

  test('a building on a knoll narrower than a block stands on the knoll, not buried in it', () => {
    // A 17 m knoll ~100 m across (Carmel, Collserola) on 20 m ground. The
    // opening #126 added cut it off, sinking whatever stood on it into the
    // hillside MapLibre draws.
    const sampler = (lng: number) => {
      const u = uOf(lng);
      return u > 0.47 && u < 0.53 ? 37 : 20;
    };
    const grid = groundGrid(tile, sampler);
    expect(gridAt(grid, size, 0.5, 0.5)).toBeCloseTo(37, 5);
    const grounder = new TileGrounder();
    grounder.setGround(createGround(sampler));
    const result = grounder.ground('k', {
      tile,
      tileSizeM: 1835,
      positions: new Float32Array([917, -917, 0, 917, -917, 12]),
      polygonStarts: new Uint32Array([0]),
      polygonBoxes: new Float32Array([907, -927, 927, -907]),
    });
    // Its roof on the knoll (37 m, less a little interpolation at the cell edge), not 20 m.
    expect(result?.values[1]).toBeGreaterThan(36);
  });
});
