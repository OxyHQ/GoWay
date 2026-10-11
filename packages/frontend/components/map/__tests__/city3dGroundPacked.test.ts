/**
 * Terrain grounding through the compact vertex format: a packed tile entry
 * (`cityMeshes.ts` → `groundTileFor`) must lift every building vertex exactly
 * as `terrainGround.ts`'s own `vertexGround` lifts the float mesh it was
 * packed from — across chunk seams, at every level — and every tree by the
 * ground under it.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';

import {
  createTileEntry,
  createTreeShapes,
  groundTileFor,
} from '@/components/map/engine/city3d/cityMeshes';
import { meshBuildingsLod } from '@/components/map/engine/city3d/lodMesher';
import {
  type BuildingFeature,
  meshBuildings,
  type Point2,
  type TileMesh,
} from '@/components/map/engine/city3d/mesher';
import { packMesh } from '@/components/map/engine/city3d/packing';
import {
  GROUND,
  gridAt,
  polygonGround,
  sampleGroundGrid,
  TileGrounder,
  vertexGround,
} from '@/components/map/engine/city3d/terrainGround';
import { tileSizeMetres } from '@/components/map/engine/city3d/tileMath';
import {
  createBuildingMaterials,
  createBuildingUniforms,
} from '@/components/map/engine/city3d/tsl/buildingMaterial';
import { createTreeMaterials } from '@/components/map/engine/city3d/tsl/treeMaterial';
import { packTrees } from '@/components/map/engine/city3d/trees';

const TILE = { z: 14, x: 8290, y: 6119 };
const SIZE = tileSizeMetres(TILE);
const OPTIONS = { extent: 4096, tileSizeMetres: SIZE };

/** A hilly sampler: metres, varying across the tile. */
const hill = (lng: number, lat: number) => 80 + 4000 * (lng - 2.16) + 9000 * (lat - 41.38);

function block(x: number, y: number, w: number, height: number): BuildingFeature {
  const ring: Point2[] = [
    [x, y],
    [x + w, y],
    [x + w, y + w],
    [x, y + w],
    [x, y],
  ];
  return { rings: [ring], properties: { render_height: height, render_min_height: 0 } };
}

/** Many blocks: enough vertices for several chunks. */
const FEATURES: BuildingFeature[] = [];
for (let i = 0; i < 60; i++) {
  for (let j = 0; j < 60; j++)
    FEATURES.push(block(20 + i * 66, 20 + j * 66, 40, 10 + ((i + j) % 9) * 5));
}

// The engine's own path: no sky, so the buildings and trees take the TSL
// pass's shared materials (`tsl/tslPass.ts`), built here without a GPU.
const v = () => ({ value: new THREE.Vector3() });
const n = (value: number) => ({ value });
const light = {
  uLightPosition: v(),
  uLightIntensity: n(0.5),
  uLightColor: v(),
  uOpacity: n(1),
  uGrounded: n(0),
};
const context = () => ({
  scene: new THREE.Scene(),
  buildingUniforms: {},
  buildingShaders: null,
  tsl: {
    scene: new THREE.Scene(),
    buildings: createBuildingMaterials(
      createBuildingUniforms({
        ...light,
        uLow: v(),
        uTall: v(),
        uVeryTall: v(),
        uTallM: n(60),
        uVeryTallM: n(180),
      }),
      THREE.FrontSide,
    ),
    trees: createTreeMaterials(
      { ...light, uCrown: v(), uConifer: v(), uTrunk: v(), uTreeMinHeight: n(0) },
      THREE.BackSide,
    ),
  },
});

describe('grounding a packed entry', () => {
  test('lifts every vertex exactly as vertexGround lifts the float mesh (32-bit, one chunk)', () => {
    const mesh = meshBuildings(FEATURES, OPTIONS) as TileMesh;
    const packed = packMesh(mesh, SIZE);
    expect(packed.chunks[0].index).toBeInstanceOf(Uint32Array);
    const entry = createTileEntry(context(), createTreeShapes(), 'k@0', 0, packed, null);
    const grid = sampleGroundGrid(TILE, GROUND.grid, hill);
    const placed = polygonGround(grid, GROUND.grid, SIZE, mesh.polygonBoxes);
    const reference = vertexGround(mesh.positions, mesh.polygonStarts, placed).values;
    const lifted = groundTileFor(entry as NonNullable<typeof entry>, TILE).lift?.(placed, grid);
    let at = 0;
    for (const chunk of packed.chunks) {
      for (let i = 0; i < chunk.position.length / 4; i++) {
        expect(lifted?.values[at + i]).toBe(reference[at + i]);
      }
      at += chunk.position.length / 4;
    }
    expect(at).toBe(lifted?.values.length ?? -1);
  });

  test('a far level is grounded by its own polygons, foot sunk, roof level', () => {
    const packed = meshBuildingsLod(FEATURES.slice(0, 50), OPTIONS, 1);
    expect(packed?.polygonStarts.length).toBe(50);
    const entry = createTileEntry(context(), createTreeShapes(), 'k@1', 1, packed, null);
    const grounder = new TileGrounder();
    grounder.setSampler(hill);
    const result = grounder.ground('k@1', groundTileFor(entry as NonNullable<typeof entry>, TILE));
    const chunk = packed?.chunks[0];
    if (!chunk || !result) throw new Error('no chunk');
    // Every polygon's vertices take one of two lifts: its roof's or its foot's.
    const starts = packed?.polygonStarts ?? new Uint32Array(0);
    for (let p = 0; p < starts.length; p++) {
      const end = p + 1 < starts.length ? starts[p + 1] : chunk.position.length / 4;
      const lifts = new Set<number>();
      for (let v = starts[p]; v < end; v++) lifts.add(result.values[v]);
      expect(lifts.size).toBe(2);
      const [low, high] = [...lifts].sort((a, b) => a - b);
      expect(high - low).toBeGreaterThanOrEqual(GROUND.minSinkM);
    }
  });

  test('trees stand on the ground under them', () => {
    const trees = packTrees(
      [
        { x: 100, y: 200, seed: 0.1, kind: 0, heightM: 10 },
        { x: 1500, y: 900, seed: 0.7, kind: 0, heightM: 12 },
      ],
      SIZE,
    );
    const entry = createTileEntry(context(), createTreeShapes(), 't@0', 0, null, trees);
    const grid = sampleGroundGrid(TILE, GROUND.grid, hill);
    const placed = polygonGround(grid, GROUND.grid, SIZE, new Float32Array(0));
    const lifted = groundTileFor(entry as NonNullable<typeof entry>, TILE).lift?.(placed, grid);
    expect(lifted?.values.length).toBe(2);
    // Packing sorts trees by shape: read each one's position back from it.
    for (let k = 0; k < 2; k++) {
      const u = ((trees?.data[k * 4] ?? 0) * (trees?.unitM ?? 0)) / SIZE;
      const v = ((trees?.data[k * 4 + 1] ?? 0) * (trees?.unitM ?? 0)) / SIZE;
      expect(lifted?.values[k]).toBeCloseTo(gridAt(grid, GROUND.grid, u, v), 4);
    }
  });

  test('a tile of trees alone is re-grounded when the terrain moves', () => {
    const trees = packTrees([{ x: 100, y: 200, seed: 0.1, kind: 0, heightM: 10 }], SIZE);
    const entry = createTileEntry(context(), createTreeShapes(), 't@0', 0, null, trees);
    const grounder = new TileGrounder();
    grounder.setSampler(hill);
    // Copied: the grounder rewrites its buffer in place.
    const first = grounder
      .ground('t@0', groundTileFor(entry as NonNullable<typeof entry>, TILE))
      ?.values.slice();
    grounder.setSampler((lng, lat) => hill(lng, lat) + 30);
    const second = grounder.ground('t@0', groundTileFor(entry as NonNullable<typeof entry>, TILE));
    expect(second?.changed).toBe(true);
    expect((second?.values[0] ?? 0) - (first?.[0] ?? 0)).toBeCloseTo(30, 3);
  });
});
