/**
 * Owner report on #126: "trees on top of buildings, trees at random
 * everywhere". The fixes, pinned:
 *
 *  - no tree (mapped or fill) stands inside a building footprint;
 *  - the fill is off unless asked for, and then only in mapped woods;
 *  - the ground is the OPENED surface model, so a tree beside a tall block
 *    stands at street level, not at the block's roof, and shares its ground
 *    with the buildings;
 *  - a fill whose basemap tile failed to fetch is marked incomplete (PR #126
 *    review) and retried on a schedule.
 */
import { describe, expect, test } from 'bun:test';

import { PbfWriter } from 'pbf';

import {
  GROUND,
  gridAt,
  groundGrid,
  openGrid,
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

describe('the ground is the opened surface', () => {
  const size = GROUND.grid;

  test('a planar slope is kept exactly (away from the edge)', () => {
    const grid = new Float32Array(size * size).map(
      (_, k) => 3 * (k % size) + 2 * Math.floor(k / size),
    );
    const opened = openGrid(grid, size, GROUND.openRadius);
    for (let j = 0; j < size - GROUND.openRadius; j++) {
      for (let i = 0; i < size - GROUND.openRadius; i++) {
        expect(opened[j * size + i]).toBe(grid[j * size + i]);
      }
    }
  });

  test('buildings in the surface model are removed — up to the tile’s edge; their street is the ground', () => {
    const tile = { z: 14, x: 8290, y: 6119 };
    const n = 2 ** 14;
    // Ground at 12 m with blocks of 40 m roofs ~3 cells wide (narrower than the window).
    const sampler = (lng: number) => {
      const u = ((lng + 180) / 360) * n - tile.x;
      return (((u * 12) % 1) + 1) % 1 < 0.6 ? 40 : 12;
    };
    const ground = groundGrid(tile, sampler);
    expect(Math.max(...ground)).toBe(12);
    // Without the margin, the clipped window at the edge keeps a roof.
    const clipped = openGrid(sampleGroundGrid(tile, size, sampler), size, GROUND.openRadius);
    expect(Math.max(...clipped)).toBe(40);
  });

  test('a street tree beside a tall block stands at street level, like the block itself', () => {
    const tile = { z: 14, x: 8290, y: 6119 };
    const n = 2 ** 14;
    // A ~100 m-wide block of 45 m roofs in the middle of the tile, on 20 m ground.
    const sampler = (lng: number) => {
      const u = ((lng + 180) / 360) * n - tile.x;
      return u > 0.46 && u < 0.51 ? 65 : 20;
    };
    const grid = groundGrid(tile, sampler);
    // A tree right beside the block, and the block's own centre.
    expect(gridAt(grid, size, 0.53, 0.5)).toBeCloseTo(20, 5);
    expect(gridAt(grid, size, 0.485, 0.5)).toBeCloseTo(20, 5);
    // The grounder itself places a building there on the same ground.
    const grounder = new TileGrounder();
    grounder.setSampler(sampler);
    const result = grounder.ground('k', {
      tile,
      tileSizeM: 1835,
      positions: new Float32Array([900, -900, 0, 900, -900, 45]),
      polygonStarts: new Uint32Array([0]),
      polygonBoxes: new Float32Array([850, -950, 950, -850]),
    });
    expect(result?.values[1]).toBeCloseTo(20, 5);
  });
});
