/**
 * Height provenance: every building unit says whether its height is recorded
 * or the 5 m default stands in for it — on both sources, at every level,
 * through packing — so official data (`height_source=lod2`) and OSM tags
 * (`osm`) can be told from a default (`docs/MAP_3D_CITY.md` → Honesty,
 * "Heights").
 */
import { describe, expect, test } from 'bun:test';

import { meshBuildingsLod } from '@/components/map/engine/city3d/lodMesher';
import {
  type BuildingFeature,
  heightUnrecorded,
  meshBuildings,
  type Point2,
  type TileMesh,
} from '@/components/map/engine/city3d/mesher';
import { meshOsmBuildings } from '@/components/map/engine/city3d/osmMesher';
import { buildingFromProperties } from '@/components/map/engine/city3d/osmTiles';
import { packMesh } from '@/components/map/engine/city3d/packing';
import { tileSizeMetres } from '@/components/map/engine/city3d/tileMath';

const TILE = { z: 15, x: 16580, y: 12238 };
const SIZE = tileSizeMetres(TILE);
const EXTENT = 4096;
const OPTIONS = { extent: EXTENT, tileSizeMetres: SIZE };

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

function feature(xM: number, height: number, base = 0): BuildingFeature {
  return {
    rings: [square(xM, 100, 40)],
    properties: { render_height: height, render_min_height: base },
  };
}

describe('OpenMapTiles', () => {
  test('a default is its 5 m on the ground, or no height at all', () => {
    expect(heightUnrecorded({ render_height: 5, render_min_height: 0 })).toBe(true);
    expect(heightUnrecorded({})).toBe(true);
    expect(heightUnrecorded({ render_height: 12, render_min_height: 0 })).toBe(false);
    // A part lifted off the ground belongs to something whose height is recorded.
    expect(heightUnrecorded({ render_height: 5, render_min_height: 3 })).toBe(false);
  });

  test('carried per unit at full detail and at the far levels, through packing', () => {
    const features = [feature(0, 5), feature(100, 20), feature(200, 5, 3)];
    const near = meshBuildings(features, OPTIONS) as TileMesh;
    expect([...(near.polygonHeightDefault ?? [])]).toEqual([1, 0, 0]);
    expect([...packMesh(near, SIZE).polygonHeightDefault]).toEqual([1, 0, 0]);
    const far = meshBuildingsLod(features, OPTIONS, 1);
    expect([...(far?.polygonHeightDefault ?? [])]).toEqual([1, 0, 0]);
  });
});

describe('GoWay city tiles', () => {
  test('whatever the tile records (height_source, height, levels) is recorded', () => {
    const ring = [square(0, 0, 40)];
    expect(buildingFromProperties(1, ring, { render_height: 5 }).heightRecorded).toBe(false);
    for (const recorded of [
      { render_height: 20, height_source: 'osm' },
      { render_height: 30, height_source: 'lod2' },
      // Archives compiled before `height_source` existed.
      { render_height: 20, height: 20 },
      { render_height: 22, levels: 6 },
    ]) {
      expect(buildingFromProperties(1, ring, recorded).heightRecorded).toBe(true);
    }
  });

  test('carried per building, through packing; absent reads as recorded', () => {
    const tile = meshOsmBuildings(
      [
        { id: 1, rings: [square(0, 0, 40)], top: 5, base: 0, heightRecorded: false },
        { id: 2, rings: [square(100, 0, 40)], top: 20, base: 0, heightRecorded: true },
        { id: 3, rings: [square(200, 0, 40)], top: 5, base: 0 },
        { id: 4, rings: [square(300, 0, 40)], top: 9, base: 4, heightRecorded: false },
      ],
      OPTIONS,
    );
    expect([...(tile?.polygonHeightDefault ?? [])]).toEqual([1, 0, 0, 0]);
    expect([...packMesh(tile as TileMesh, SIZE).polygonHeightDefault]).toEqual([1, 0, 0, 0]);
  });
});
