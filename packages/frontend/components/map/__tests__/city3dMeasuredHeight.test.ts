/**
 * Measured heights (`measuredHeight.ts`): a building nothing records the
 * height of stands at what the terrain's SURFACE model measures over it —
 * the median of nine samples less the ground — and nothing else moves. What
 * OSM records always wins; no terrain, no measurement.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';

import {
  createTileEntry,
  createTreeShapes,
  groundTileFor,
  measuredTops,
} from '@/components/map/engine/city3d/cityMeshes';
import { MEASURED, measuredHeight } from '@/components/map/engine/city3d/measuredHeight';
import {
  type BuildingFeature,
  heightUnrecorded,
  meshBuildings,
  type Point2,
  type TileMesh,
} from '@/components/map/engine/city3d/mesher';
import { meshOsmBuildings } from '@/components/map/engine/city3d/osmMesher';
import { buildingFromProperties } from '@/components/map/engine/city3d/osmTiles';
import { packMesh, Z_UNITS_PER_METRE } from '@/components/map/engine/city3d/packing';
import { GROUND, polygonGround, TileGrounder } from '@/components/map/engine/city3d/terrainGround';
import {
  mercatorXFromLng,
  mercatorYFromLat,
  tileSizeMetres,
} from '@/components/map/engine/city3d/tileMath';

/** The Eixample tile of the owner's report. */
const TILE = { z: 15, x: 16580, y: 12238 };
const SIZE = tileSizeMetres(TILE);
const EXTENT = 4096;
const OPTIONS = { extent: EXTENT, tileSizeMetres: SIZE };
const N = GROUND.grid;

/** A grid of `N × N` from a function of (u, v), row-major from the north-west. */
function gridOf(f: (u: number, v: number) => number): Float32Array {
  const grid = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) grid[j * N + i] = f(i / (N - 1), j / (N - 1));
  return grid;
}

/** A footprint box in local metres (x east, y north from the north edge, so ≤ 0). */
function boxM(x: number, y: number, w: number, h = w): number[] {
  return [x, -(y + h), x + w, -y];
}

/** A square in tile units (y down) at metre offsets. */
function square(xM: number, yM: number, wM: number): Point2[] {
  const k = EXTENT / SIZE;
  const [x, y, w] = [xM * k, yM * k, wM * k];
  return [
    [x, y],
    [x + w, y],
    [x + w, y + w],
    [x, y + w],
    [x, y],
  ];
}

function feature(xM: number, yM: number, wM: number, height: number, base = 0): BuildingFeature {
  return {
    rings: [square(xM, yM, wM)],
    properties: { render_height: height, render_min_height: base },
  };
}

const context = () => ({
  scene: new THREE.Scene(),
  buildingUniforms: {},
  buildingShaders: {
    openmaptiles: { vertexShader: '', fragmentShader: '' },
    goway: { vertexShader: '', fragmentShader: '' },
  },
  treeUniforms: {},
});

describe('measuredHeight', () => {
  const ground = 80;
  const flat = gridOf(() => ground);

  test('the surface above the ground, inside the footprint', () => {
    const surface = gridOf(() => ground + 25);
    expect(measuredHeight(boxM(200, 200, 40), ground, surface, SIZE)).toBeCloseTo(25, 4);
  });

  test('the median: a street at one side and a tower at another do not move it', () => {
    // West third of the box over the street (ground), a 120 m spike at the
    // east third's north row; the rest is the 25 m block.
    const [x0, w] = [200, 60];
    const surface = gridOf((u, v) => {
      const x = u * SIZE;
      const y = v * SIZE;
      if (x < x0 + w / 3) return ground;
      if (x > x0 + (2 * w) / 3 && y < 200 + w / 3) return ground + 120;
      return ground + 25;
    });
    const height = measuredHeight(boxM(x0, 200, w), ground, surface, SIZE);
    expect(height).not.toBeNull();
    expect(height as number).toBeGreaterThan(20);
    expect(height as number).toBeLessThan(30);
  });

  test('no higher than the default: the default stands', () => {
    expect(measuredHeight(boxM(200, 200, 40), ground, flat, SIZE)).toBeNull();
    const low = gridOf(() => ground + MEASURED.floorM - 0.5);
    expect(measuredHeight(boxM(200, 200, 40), ground, low, SIZE)).toBeNull();
  });

  test('capped: a spike over the whole footprint is not a 400 m building', () => {
    const spike = gridOf(() => ground + 400);
    expect(measuredHeight(boxM(200, 200, 40), ground, spike, SIZE)).toBe(MEASURED.capM);
  });

  test('a footprint narrower than the model can resolve is not measured', () => {
    const surface = gridOf(() => ground + 25);
    expect(measuredHeight(boxM(200, 200, 60, 10), ground, surface, SIZE)).toBeNull();
    expect(measuredHeight(boxM(200, 200, MEASURED.minSideM), ground, surface, SIZE)).not.toBeNull();
  });
});

describe('which buildings may be measured', () => {
  test('OpenMapTiles: its 5 m default on the ground, or nothing at all', () => {
    expect(heightUnrecorded({ render_height: 5, render_min_height: 0 })).toBe(true);
    expect(heightUnrecorded({})).toBe(true);
    expect(heightUnrecorded({ render_height: 12, render_min_height: 0 })).toBe(false);
    // A part lifted off the ground is part of something taller that is recorded.
    expect(heightUnrecorded({ render_height: 5, render_min_height: 3 })).toBe(false);
  });

  test('GoWay city tiles: whatever OSM records (height_source, height, levels) is recorded', () => {
    const ring = [square(0, 0, 40)];
    expect(buildingFromProperties(1, ring, { render_height: 5 }).heightRecorded).toBe(false);
    for (const recorded of [
      { render_height: 20, height_source: 'osm' },
      { render_height: 30, height_source: 'lod2' },
      { render_height: 20, height: 20 },
      { render_height: 22, levels: 6 },
    ]) {
      expect(buildingFromProperties(1, ring, recorded).heightRecorded).toBe(true);
    }
  });

  test('the mesher carries the flag per unit, through packing', () => {
    const tile = meshOsmBuildings(
      [
        { id: 1, rings: [square(0, 0, 40)], top: 5, base: 0, heightRecorded: false },
        { id: 2, rings: [square(100, 0, 40)], top: 20, base: 0, heightRecorded: true },
        { id: 3, rings: [square(200, 0, 40)], top: 5, base: 0 },
        { id: 4, rings: [square(300, 0, 40)], top: 9, base: 4, heightRecorded: false },
      ],
      OPTIONS,
    );
    expect([...(tile?.polygonMeasurable ?? [])]).toEqual([1, 0, 0, 0]);
    const packed = packMesh(tile as TileMesh, SIZE);
    expect([...packed.polygonMeasurable]).toEqual([1, 0, 0, 0]);
  });
});

describe('standing a packed tile at its measured heights', () => {
  const ground = 80;
  const features = [
    feature(100, 100, 40, 5), // unrecorded, over the block: measured
    feature(200, 100, 40, 20), // recorded: never touched
    feature(300, 100, 10, 5), // unrecorded but too narrow
    feature(600, 600, 40, 5), // unrecorded, over open ground: the default stands
  ];
  /** A 25 m block over the first three, open ground elsewhere. */
  const surface = gridOf((u, v) => (u * SIZE < 400 && v * SIZE < 300 ? ground + 25 : ground));
  const grid = gridOf(() => ground);

  function lifted(withSurface: boolean) {
    const mesh = meshBuildings(features, OPTIONS) as TileMesh;
    const packed = packMesh(mesh, SIZE);
    const entry = createTileEntry(context(), createTreeShapes(), 'k@0', 0, packed, null);
    if (!entry) throw new Error('no entry');
    const placed = polygonGround(grid, N, SIZE, packed.polygonBoxes);
    const result = groundTileFor(entry, TILE).lift?.(
      placed,
      grid,
      undefined,
      withSurface ? surface : undefined,
    );
    if (!result) throw new Error('no lift');
    return { packed, entry, result, placed };
  }

  /** Each unit's highest drawn point (stored z + lift) and lowest, metres. */
  function extents(run: ReturnType<typeof lifted>) {
    const { packed, result } = run;
    const top = new Array(packed.polygonStarts.length).fill(-Infinity);
    const bottom = new Array(packed.polygonStarts.length).fill(Infinity);
    let at = 0;
    for (const chunk of packed.chunks) {
      const count = chunk.position.length / 4;
      for (let i = 0; i < count; i++) {
        const s = chunk.sourceIds ? chunk.sourceIds[i] : chunk.sourceStart + i;
        let unit = 0;
        while (unit + 1 < packed.polygonStarts.length && packed.polygonStarts[unit + 1] <= s)
          unit++;
        const z = chunk.position[i * 4 + 2] / Z_UNITS_PER_METRE + result.values[at + i];
        top[unit] = Math.max(top[unit], z);
        bottom[unit] = Math.min(bottom[unit], z);
      }
      at += count;
    }
    return { top, bottom };
  }

  test('the unrecorded block rises to the surface; nothing else moves', () => {
    const before = extents(lifted(false));
    const run = lifted(true);
    const after = extents(run);
    expect(before.top.map((t) => Math.round(t))).toEqual([85, 100, 85, 85]);
    expect(after.top[0]).toBeCloseTo(ground + 25, 1);
    expect(after.top.slice(1)).toEqual(before.top.slice(1));
    // Feet stay where the terrain put them.
    expect(after.bottom).toEqual(before.bottom);
    expect(run.entry.measured).toBe(1);
  });

  test('walls stretch in proportion: a vertex halfway up stays halfway up', () => {
    const run = lifted(true);
    const { stretch, count } = measuredTops(run.packed, run.placed.anchor, surface, SIZE);
    expect(count).toBe(1);
    // 5 m stored → 25 m: 20 m spread over 5 m of stored z.
    expect(stretch[0] * 5 * Z_UNITS_PER_METRE).toBeCloseTo(20, 1);
    expect([...stretch.slice(1)]).toEqual([0, 0, 0]);
  });

  test('without a surface (no terrain), the lift is the plain one', () => {
    const run = lifted(false);
    expect(run.entry.measured).toBe(0);
    expect(extents(run).top.map((t) => Math.round(t))).toEqual([85, 100, 85, 85]);
  });
});

describe('through the grounder', () => {
  // A 54 m block standing 25 m over flat ground at 80 m: narrower than the
  // opening's reach (`terrainGround.ts`), so the ground under it is 80 m and
  // the surface over it 105 m.
  const [bx, by, bw] = [400, 400, 54];
  const u = (lng: number) => (mercatorXFromLng(lng) * 2 ** TILE.z - TILE.x) * SIZE;
  const v = (lat: number) => (mercatorYFromLat(lat) * 2 ** TILE.z - TILE.y) * SIZE;
  const flat = () => 80;
  const withBlock = (lng: number, lat: number) => {
    const [x, y] = [u(lng), v(lat)];
    return x >= bx && x <= bx + bw && y >= by && y <= by + bw ? 105 : 80;
  };

  test('a block appearing in the surface re-grounds the tile and raises the building', () => {
    const mesh = meshBuildings([feature(bx + 12, by + 12, 30, 5)], OPTIONS) as TileMesh;
    const packed = packMesh(mesh, SIZE);
    const entry = createTileEntry(context(), createTreeShapes(), 'k@0', 0, packed, null);
    if (!entry) throw new Error('no entry');
    const grounder = new TileGrounder();
    grounder.setSampler(flat);
    const first = grounder.ground('k@0', groundTileFor(entry, TILE));
    const firstMax = first?.max ?? 0;
    expect(firstMax).toBeCloseTo(80, 3);
    expect(entry.measured).toBe(0);

    grounder.setSampler(withBlock);
    const second = grounder.ground('k@0', groundTileFor(entry, TILE));
    expect(second?.changed).toBe(true);
    // The ground under it is still 80 m (the opening removed the block)…
    expect(second?.min ?? 0).toBeLessThanOrEqual(80);
    // …and its roof (stored 5 m) now reaches the surface: 80 + 5 + 20.
    expect((second?.max ?? 0) + 5).toBeCloseTo(105, 0);
    expect(entry.measured).toBe(1);
  });
});
