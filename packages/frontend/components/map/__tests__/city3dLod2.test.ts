/**
 * The LOD2 side of the city-3D client: the surface decoder's defence against
 * bad properties (`lod2Tiles.ts`), the mesher (`lod2Mesher.ts`) — roofs on
 * their planes, walls only where a roof edge shows one, OSM's recorded facts
 * on the model's shape — the mesh concatenation the worker sends, and the
 * credit the adapter derives from what is drawn.
 */
import { describe, expect, test } from 'bun:test';

import { creditsFor } from '@/components/map/city3dLayer.web';
import { COLOUR_WEIGHT } from '@/components/map/engine/city3d/facades';
import {
  appearanceOf,
  concatTileMeshes,
  meshLod2Surfaces,
} from '@/components/map/engine/city3d/lod2Mesher';
import { type Lod2Surface, surfaceFromFeature } from '@/components/map/engine/city3d/lod2Tiles';
import type { Point2 } from '@/components/map/engine/city3d/mesher';
import { meshOsmBuildings, type OsmTileMesh } from '@/components/map/engine/city3d/osmMesher';
import type { OsmBuilding } from '@/components/map/engine/city3d/osmTiles';
import { CITY_PROPS } from '@/lib/map/cityTiles';
import { CITY_LOD2_PROPS, CITY_LOD2_SOURCES } from '@/lib/map/cityOfficial';

/** One tile unit is one metre. */
const OPTIONS = { extent: 4096, tileSizeMetres: 4096 };

/** A box in TILE units (y down), exterior positive per the MVT rule. */
function box(x0: number, y0: number, w: number, h: number): Point2[] {
  return [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ];
}

function surface(
  rings: Point2[][],
  plane: Partial<Lod2Surface['plane']>,
  extra: Partial<Lod2Surface> = {},
): Lod2Surface {
  let x0 = Infinity;
  let y0 = Infinity;
  for (const [x, y] of rings[0]) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
  }
  const full = { h: 10, dx: 0, dy: 0, x0, y0, ...plane };
  let top = 0;
  for (const [x, y] of rings[0])
    top = Math.max(top, full.h + full.dx * (x - x0) + full.dy * (y - y0));
  return { rings, plane: full, top, source: 'nyc-3dbm', sourceId: 'B1', ...extra };
}

function mesh(surfaces: Lod2Surface[], osm: OsmBuilding[] = []): OsmTileMesh {
  const result = meshLod2Surfaces(surfaces, OPTIONS, osm);
  if (!result) throw new Error('nothing meshed');
  return result;
}

/** Vertical faces (walls) as `[x, y, zBottom, zTop]` per column pair, from the vertex stream. */
function wallHeights(m: OsmTileMesh): { z: number; nz: number }[] {
  const out = [];
  for (let v = 0; v < m.positions.length / 3; v++) {
    out.push({ z: m.positions[v * 3 + 2], nz: m.normals[v * 3 + 2] / 127 });
  }
  return out;
}

describe('surfaceFromFeature', () => {
  const rings = [box(0, 0, 10, 10)];
  test('a flat roof needs only render_height; a sloped one its plane', () => {
    expect(
      surfaceFromFeature(rings, {
        [CITY_LOD2_PROPS.source]: 'nyc-3dbm',
        [CITY_PROPS.renderHeight]: 12,
      }),
    ).toMatchObject({ plane: { h: 12, dx: 0, dy: 0, x0: 0, y0: 0 }, top: 12 });
    const sloped = surfaceFromFeature(rings, {
      [CITY_LOD2_PROPS.source]: 'nyc-3dbm',
      [CITY_PROPS.renderHeight]: 15,
      [CITY_LOD2_PROPS.roofH]: 10,
      [CITY_LOD2_PROPS.roofDx]: 0.5,
      [CITY_LOD2_PROPS.osmId]: 42,
      [CITY_LOD2_PROPS.sourceId]: 1015862,
    });
    expect(sloped).toMatchObject({ top: 15, osmId: 42, sourceId: '1015862' });
  });

  test('untrusted values are refused, never drawn with a guess', () => {
    const base = { [CITY_LOD2_PROPS.source]: 'nyc-3dbm', [CITY_PROPS.renderHeight]: 12 };
    expect(
      surfaceFromFeature(rings, { ...base, [CITY_LOD2_PROPS.source]: 'somebody-else' }),
    ).toBeNull();
    expect(surfaceFromFeature(rings, { ...base, [CITY_PROPS.renderHeight]: 5000 })).toBeNull();
    expect(surfaceFromFeature(rings, { ...base, [CITY_LOD2_PROPS.roofH]: 'tall' })).toBeNull();
    expect(surfaceFromFeature(rings, { ...base, [CITY_LOD2_PROPS.roofDx]: 40 })).toBeNull();
    expect(surfaceFromFeature(rings, { ...base, [CITY_LOD2_PROPS.roofDy]: Number.NaN })).toBeNull();
    // A ring with no exterior (all clockwise): nothing to stand on.
    expect(surfaceFromFeature([box(0, 0, 10, 10).reverse()], base)).toBeNull();
  });
});

describe('meshLod2Surfaces', () => {
  test('a flat box: a roof at its height, four full walls from the ground', () => {
    const m = mesh([surface([box(0, 0, 20, 10)], { h: 12 })]);
    const vertices = wallHeights(m);
    const roof = vertices.filter((v) => v.nz > 0.99);
    expect(roof.length).toBeGreaterThan(0);
    expect(roof.every((v) => v.z === 12)).toBe(true);
    expect(m.bounds.max[2]).toBe(12);
    expect(m.bounds.min[2]).toBe(0);
    // Four walls, two triangles each, plus the roof's two.
    expect(m.indices.length / 3).toBe(4 * 2 + 2);
  });

  test('a gable: the ridge wall between the two slopes is not drawn, the gable ends are', () => {
    // Two slopes sharing the edge y = 5 (the ridge), eaves at 6 m, ridge at 9 m.
    const south = surface([box(0, 5, 10, 5)], { h: 9, dy: -0.6 }); // y0 = 5: 9 m at the ridge, 6 m at y = 10
    const north = surface([box(0, 0, 10, 5)], { h: 6, dy: 0.6 }); // 6 m at y = 0, 9 m at the ridge
    const m = mesh([south, north]);
    // Each slope: 3 walls (eave + two gable halves), 2 triangles each; roof 2 each.
    expect(m.indices.length / 3).toBe(2 * (3 * 2 + 2));
    // The roof normals lean north and south, not straight up.
    const roofs = wallHeights(m).filter((v) => v.nz > 0.5);
    expect(roofs.every((v) => v.nz < 0.99)).toBe(true);
    expect(m.bounds.max[2]).toBeCloseTo(9, 6);
  });

  test('a setback: the lower roof gets only the step above it, not a wall from the ground', () => {
    const podium = surface([box(0, 0, 10, 10)], { h: 20 });
    const tower = surface([box(10, 0, 10, 10)], { h: 80 });
    const m = mesh([podium, tower]);
    // Find the shared edge's wall vertices at x = 10: the tower's wall there runs 20 → 80.
    const zs = new Set<number>();
    for (let v = 0; v < m.positions.length / 3; v++) {
      if (Math.abs(m.positions[v * 3] - 10) < 1e-6 && Math.abs(m.normals[v * 3 + 2]) < 2) {
        zs.add(m.positions[v * 3 + 2]);
      }
    }
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 20, 80]);
    // Podium: 3 outline walls; tower: 3 outline walls + the step; 2 roofs.
    expect(m.indices.length / 3).toBe((3 + 4) * 2 + 2 * 2);
    // One building, one unit on terrain: both setbacks on the same ground.
    expect(Array.from(m.polygonStarts)).toEqual([0]);
    expect(Array.from(m.polygonBoxes, (v) => v + 0)).toEqual([0, -10, 20, 0]);
    // Another building's surface is its own unit.
    const two = mesh([podium, { ...tower, sourceId: 'B2' }]);
    expect(two.polygonStarts.length).toBe(2);
  });

  test('OSM’s recorded facts dress the shape: colour, and storeys on outline walls only', () => {
    const osm: OsmBuilding = {
      id: 42,
      rings: [box(0, 0, 20, 10)],
      top: 18,
      base: 0,
      levels: 6,
      colour: 0x884422,
    };
    const lower = surface([box(0, 0, 10, 10)], { h: 18 }, { osmId: 42 });
    const upper = surface([box(10, 0, 10, 10)], { h: 30 }, { osmId: 42 });
    const m = mesh([lower, upper], [osm]);
    let walls = 0;
    let tagged = 0;
    let stepVertices = 0;
    let stepWithRhythm = 0;
    let outlineWithRhythm = 0;
    for (let v = 0; v < m.positions.length / 3; v++) {
      const isWall = Math.abs(m.normals[v * 3 + 2]) < 2;
      // The roof keeps the ramp: OSM records no `roof:colour` here.
      if (!isWall) {
        expect(m.colors[v * 4 + 3]).toBe(0);
        continue;
      }
      walls++;
      if (m.colors[v * 4 + 3] === COLOUR_WEIGHT.tagged) tagged++;
      // The step: the wall at x = 10 facing along x (the outline walls'
      // corners are at x = 10 too, but face north or south).
      const onStep = Math.abs(m.positions[v * 3] - 10) < 1e-6 && Math.abs(m.normals[v * 3]) > 100;
      if (onStep) stepVertices++;
      if (m.facade[v * 4 + 3] === 6) {
        if (onStep) stepWithRhythm++;
        else outlineWithRhythm++;
      }
    }
    expect(tagged).toBe(walls);
    expect(outlineWithRhythm).toBeGreaterThan(0);
    expect(stepVertices).toBeGreaterThan(0);
    expect(stepWithRhythm).toBe(0);
    // No match in the tile: drawn plain.
    const plain = mesh([surface([box(0, 0, 10, 10)], { h: 18 }, { osmId: 99 })], [osm]);
    expect(Array.from(plain.colors).every((value, i) => i % 4 !== 3 || value === 0)).toBe(true);
    expect(Array.from(plain.facade).every((value) => value === 0)).toBe(true);
  });

  test('a source that records storeys (the cadastre) draws them itself, without an OSM match', () => {
    const m = mesh([surface([box(0, 0, 10, 10)], { h: 7 * 3.66 }, { levels: 7 })]);
    const counts = new Set<number>();
    for (let v = 0; v < m.positions.length / 3; v++) {
      if (Math.abs(m.normals[v * 3 + 2]) < 2) counts.add(m.facade[v * 4 + 3]);
    }
    expect([...counts]).toEqual([7]);
  });

  test('appearanceOf: no rhythm when the count does not fit the height', () => {
    const osm: OsmBuilding = { id: 1, rings: [], top: 100, base: 0, levels: 3 };
    expect(appearanceOf(osm).rhythm).toBeNull();
    expect(appearanceOf(undefined)).toMatchObject({ rhythm: null, wall: [0, 0, 0, 0] });
  });
});

describe('concatTileMeshes', () => {
  test('appends vertices and offsets indices', () => {
    const osm = meshOsmBuildings(
      [{ id: 1, rings: [box(100, 100, 10, 10)], top: 12, base: 0 }],
      OPTIONS,
    );
    const lod2 = mesh([surface([box(0, 0, 10, 10)], { h: 20 })]);
    const both = concatTileMeshes(osm, lod2);
    if (!osm || !both) throw new Error('nothing meshed');
    const n = osm.positions.length / 3;
    expect(both.positions.length).toBe(osm.positions.length + lod2.positions.length);
    expect(both.indices.length).toBe(osm.indices.length + lod2.indices.length);
    expect(Math.min(...Array.from(both.indices.slice(osm.indices.length)))).toBe(n);
    expect(both.bounds.max[2]).toBe(20);
    expect(both.polygons).toBe(osm.polygons + lod2.polygons);
    expect(Array.from(both.polygonStarts)).toEqual([...osm.polygonStarts, n]);
    expect(both.polygonBoxes.length).toBe(osm.polygonBoxes.length + 4);
    expect(concatTileMeshes(null, lod2)).toBe(lod2);
    expect(concatTileMeshes(null, null)).toBeNull();
  });
});

describe('creditsFor', () => {
  test('one credit per known source drawn, unknown ids dropped', () => {
    expect(creditsFor(['nyc-3dbm', 'nope'])).toEqual([CITY_LOD2_SOURCES['nyc-3dbm']]);
    expect(creditsFor([])).toEqual([]);
  });
});
