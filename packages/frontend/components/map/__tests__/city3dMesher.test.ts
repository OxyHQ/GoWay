/**
 * The city-3D mesher: heights, clipping, orientation, the bevel, the baked
 * occlusion, and the decode path from real vector-tile bytes.
 *
 * The decode test encodes its tile BY HAND (a dozen lines of the vector-tile
 * spec over `pbf`'s writer) instead of trusting a fixture produced by the code
 * under test. That is the test that would have caught the first version of the
 * mesher, which forgot that a vector-tile exterior is clockwise as drawn and
 * so classified 1,465 of a Manhattan tile's 1,488 buildings as holes.
 */
import { describe, expect, test } from 'bun:test';
import { PbfWriter } from 'pbf';

import { decodeBuildings } from '@/components/map/engine/city3d/decode';
import {
  type BuildingFeature,
  bevelWidth,
  buildingSpan,
  clipRingToTile,
  insetIsValid,
  insetRing,
  isCutEdge,
  MESH,
  meshBuildings,
  type Point2,
  polygonsOf,
  type Ring,
  signedArea,
  type TileMesh,
  turnAngle,
  wallColumns,
} from '@/components/map/engine/city3d/mesher';
import { AO, concavity, cornerOcclusion } from '@/components/map/engine/city3d/occlusion';

/** Extent 4096 over 4096 m: one tile unit is one metre, so expectations read as metres. */
const OPTIONS = { extent: 4096, tileSizeMetres: 4096 };

/** A rectangle as a vector tile stores an exterior: clockwise as drawn, y down. */
function tileRect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

/** An L, the same way round: exterior clockwise as drawn. Its one concave corner is (20, 10). */
function tileL(): Point2[] {
  return [
    [10, 0],
    [30, 0],
    [30, 10],
    [20, 10],
    [20, 30],
    [10, 30],
    [10, 0],
  ];
}

function building(
  rings: Point2[][],
  properties: BuildingFeature['properties'] = { render_height: 20 },
) {
  return { rings, properties };
}

function vertexCount(mesh: TileMesh) {
  return mesh.positions.length / 3;
}

function vertex(mesh: TileMesh, i: number) {
  return {
    position: [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]],
    normal: [
      mesh.normals[i * 3] / 127,
      mesh.normals[i * 3 + 1] / 127,
      mesh.normals[i * 3 + 2] / 127,
    ],
    ao: mesh.shade[i * 2] / 255,
    tone: mesh.shade[i * 2 + 1],
  };
}

describe('buildingSpan mirrors the fill-extrusion layer', () => {
  test('heights floor at 3 m, including the measured -3 and 0', () => {
    expect(buildingSpan({ render_height: -3 })).toEqual({ base: 0, top: MESH.minHeightM });
    expect(buildingSpan({ render_height: 0 })).toEqual({ base: 0, top: MESH.minHeightM });
    expect(buildingSpan({})).toEqual({ base: 0, top: MESH.minHeightM });
    expect(buildingSpan({ render_height: 'tall' })).toEqual({ base: 0, top: MESH.minHeightM });
  });

  test('a base at or above the roof drops to the ground', () => {
    expect(buildingSpan({ render_height: 5, render_min_height: 37 })).toEqual({ base: 0, top: 5 });
    expect(buildingSpan({ render_height: 20, render_min_height: 20 })).toEqual({
      base: 0,
      top: 20,
    });
    expect(buildingSpan({ render_height: 20, render_min_height: 8 })).toEqual({ base: 8, top: 20 });
  });

  test('hide_3d means no volume', () => {
    expect(buildingSpan({ render_height: 20, hide_3d: true })).toBeNull();
  });
});

describe('rings', () => {
  test('clipping keeps an inside ring and marks only boundary edges cut', () => {
    const inside = clipRingToTile(tileRect(10, 10, 20, 20), 4096);
    expect(inside).toHaveLength(4);
    const spill = clipRingToTile(tileRect(4000, 10, 4160, 20), 4096);
    expect(Math.max(...spill.map((p) => p[0]))).toBe(4096);
    const cuts = spill.map((p, i) => isCutEdge(p, spill[(i + 1) % spill.length], 4096));
    expect(cuts.filter(Boolean)).toHaveLength(1);
  });

  test('a ring wholly outside the tile disappears', () => {
    expect(clipRingToTile(tileRect(5000, 10, 5100, 20), 4096)).toHaveLength(0);
  });

  test('a tile exterior becomes counter-clockwise in ENU, its courtyard clockwise', () => {
    const outer = tileRect(0 + 100, 100, 200, 200);
    // A hole runs the other way round in the tile.
    const hole = tileRect(120, 120, 180, 180).reverse();
    const polygons = polygonsOf([outer, hole], OPTIONS);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(2);
    expect(signedArea(polygons[0][0].points)).toBeCloseTo(100 * 100, 6);
    expect(signedArea(polygons[0][1].points)).toBeCloseTo(-60 * 60, 6);
    // y is north: every point of a tile sits at y <= 0.
    for (const [, y] of polygons[0][0].points) expect(y).toBeLessThanOrEqual(0);
  });

  test('two exteriors are two polygons; a hole with no exterior and a sliver are dropped', () => {
    const lone = tileRect(300, 300, 310, 310).reverse();
    const sliver = tileRect(400, 400, 400.5, 401);
    const polygons = polygonsOf(
      [lone, tileRect(0, 0, 10, 10), sliver, tileRect(20, 0, 30, 10)],
      OPTIONS,
    );
    expect(polygons).toHaveLength(2);
    expect(polygons.every((p) => p.length === 1)).toBe(true);
  });
});

describe('bevel', () => {
  const square: Ring = {
    points: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    cut: [false, false, false, false],
  };

  test('a square insets by the width on every side', () => {
    expect(insetRing(square, 1)).toEqual([
      [1, 1],
      [9, 1],
      [9, 9],
      [1, 9],
    ]);
  });

  test('a cut edge stays where it is; its neighbours slide along it', () => {
    const inset = insetRing({ ...square, cut: [true, false, false, false] }, 1);
    // Edge 0 is (0,0)→(10,0); with no offset it keeps y = 0.
    expect(inset[0][1]).toBeCloseTo(0, 12);
    expect(inset[1][1]).toBeCloseTo(0, 12);
    expect(inset[0][0]).toBeCloseTo(1, 12);
    expect(inset[1][0]).toBeCloseTo(9, 12);
  });

  test('a needle corner is held to the mitre limit', () => {
    const needle: Ring = {
      points: [
        [0, 0],
        [100, 0],
        [0, 1],
      ],
      cut: [false, false, false],
    };
    const inset = insetRing(needle, 1);
    const moved = Math.hypot(inset[1][0] - 100, inset[1][1]);
    expect(moved).toBeLessThanOrEqual(MESH.miterLimit + 1e-9);
  });

  test('an inset wider than the shape folds, and is caught', () => {
    const corridor = [
      [0, 0],
      [20, 0],
      [20, 1],
      [0, 1],
    ] as Point2[];
    const folded = insetRing({ points: corridor, cut: [false, false, false, false] }, 1);
    expect(insetIsValid(corridor, folded)).toBe(false);
    expect(insetIsValid(square.points, insetRing(square, 1))).toBe(true);
  });

  test('the width is capped by height and by narrowness', () => {
    expect(bevelWidth([square], 100)).toBe(MESH.bevelM);
    expect(bevelWidth([square], 2)).toBeCloseTo(MESH.bevelHeightFraction * 2, 12);
    const thin: Ring = {
      points: [
        [0, 0],
        [40, 0],
        [40, 1],
        [0, 1],
      ],
      cut: [false, false, false, false],
    };
    expect(bevelWidth([thin], 100)).toBeCloseTo(MESH.bevelWidthFraction * ((2 * 40) / 82), 12);
  });
});

describe('occlusion inputs', () => {
  test('turns: left is convex, right is concave', () => {
    expect(turnAngle([0, 0], [1, 0], [1, 1])).toBeCloseTo(Math.PI / 2, 12);
    expect(turnAngle([0, 0], [1, 0], [1, -1])).toBeCloseTo(-Math.PI / 2, 12);
    expect(concavity(Math.PI / 2)).toBe(0);
    expect(concavity(-Math.PI / 2)).toBe(1);
    expect(concavity(-Math.PI / 4)).toBeCloseTo(0.5, 12);
  });

  test('wall columns add the reach only next to a concave end', () => {
    expect(wallColumns(10, false, false)).toEqual([0, 10]);
    expect(wallColumns(10, true, false)).toEqual([0, AO.cornerReachM, 10]);
    expect(wallColumns(10, true, true)).toEqual([0, AO.cornerReachM, 10 - AO.cornerReachM, 10]);
    // Shorter than the reach: no interior column.
    expect(wallColumns(2, true, true)).toEqual([0, 2]);
  });
});

describe('meshBuildings', () => {
  test('a square box: walls, bevel strips, roof — counted', () => {
    const mesh = meshBuildings([building([tileRect(100, 100, 110, 110)])], OPTIONS);
    if (!mesh) throw new Error('expected a mesh');
    // 4 walls × 2 columns × 2 rows, 4 bevel quads × 4, a 4-point roof.
    expect(vertexCount(mesh)).toBe(16 + 16 + 4);
    expect(mesh.indices.length / 3).toBe(8 + 8 + 2);
    expect(mesh.polygons).toBe(1);
    expect(mesh.bounds.min[2]).toBe(0);
    expect(mesh.bounds.max[2]).toBe(20);
  });

  test('every wall normal points out of the building; the roof faces up', () => {
    const mesh = meshBuildings([building([tileRect(100, 100, 110, 110)])], OPTIONS);
    if (!mesh) throw new Error('expected a mesh');
    // The box's centre in ENU.
    const cx = 105;
    const cy = -105;
    for (let i = 0; i < vertexCount(mesh); i++) {
      const { position, normal } = vertex(mesh, i);
      if (normal[2] > 0.99) {
        expect(position[2]).toBe(20);
        continue;
      }
      const out = (position[0] - cx) * normal[0] + (position[1] - cy) * normal[1];
      expect(out).toBeGreaterThan(0);
    }
  });

  test('triangles wind counter-clockwise seen from outside', () => {
    const mesh = meshBuildings([building([tileRect(100, 100, 110, 110)])], OPTIONS);
    if (!mesh) throw new Error('expected a mesh');
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]].map(
        (i) => vertex(mesh, i).position,
      );
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const face = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ];
      const { normal } = vertex(mesh, mesh.indices[t]);
      expect(face[0] * normal[0] + face[1] * normal[1] + face[2] * normal[2]).toBeGreaterThan(0);
    }
  });

  test('the bevel is a 45° chamfer from top − b to top', () => {
    const mesh = meshBuildings([building([tileRect(100, 100, 110, 110)])], OPTIONS);
    if (!mesh) throw new Error('expected a mesh');
    const tops = new Set<number>();
    let chamfers = 0;
    for (let i = 0; i < vertexCount(mesh); i++) {
      const { position, normal } = vertex(mesh, i);
      tops.add(position[2]);
      if (normal[2] > 0.6 && normal[2] < 0.8) chamfers++;
    }
    expect([...tops].sort((a, b) => a - b)).toEqual(
      [0, 20 - MESH.bevelM, 20].map((z) => Math.fround(z)),
    );
    expect(chamfers).toBe(16);
  });

  test('the concave corner of an L is darkened, and only near the corner', () => {
    const mesh = meshBuildings([building([tileL()])], OPTIONS);
    if (!mesh) throw new Error('expected a mesh');
    // The concave corner is (20, 10) in the tile → (20, -10) in ENU.
    const atCorner: number[] = [];
    const farAway: number[] = [];
    for (let i = 0; i < vertexCount(mesh); i++) {
      const { position, normal, ao } = vertex(mesh, i);
      if (Math.abs(normal[2]) > 0.01) continue; // walls only
      const d = Math.hypot(position[0] - 20, position[1] + 10);
      if (d < 1e-3) atCorner.push(ao);
      else if (d >= AO.cornerReachM - 1e-3) farAway.push(ao);
    }
    expect(atCorner.length).toBeGreaterThan(0);
    for (const ao of atCorner) expect(ao).toBeCloseTo(cornerOcclusion(1, 0), 2);
    for (const ao of farAway) expect(ao).toBe(1);
  });

  test('a building crossing the tile edge gets no wall on the cut', () => {
    const mesh = meshBuildings([building([tileRect(4090, 100, 4200, 110)])], OPTIONS);
    if (!mesh) throw new Error('expected a mesh');
    for (let i = 0; i < vertexCount(mesh); i++) {
      const { position, normal } = vertex(mesh, i);
      // A wall facing east at x = 4096 would be the fake one.
      if (normal[0] > 0.99) expect(position[0]).toBeLessThan(4096);
    }
    expect(mesh.bounds.max[0]).toBeCloseTo(4096, 6);
  });

  test('hidden and empty tiles mesh to nothing', () => {
    expect(meshBuildings([], OPTIONS)).toBeNull();
    expect(
      meshBuildings(
        [building([tileRect(0, 0, 10, 10)], { render_height: 20, hide_3d: true })],
        OPTIONS,
      ),
    ).toBeNull();
  });

  test('tone carries the raw height, saturating at one byte', () => {
    const tall = meshBuildings(
      [building([tileRect(0, 0, 10, 10)], { render_height: 444 })],
      OPTIONS,
    );
    const short = meshBuildings(
      [building([tileRect(0, 0, 10, 10)], { render_height: 0 })],
      OPTIONS,
    );
    if (!tall || !short) throw new Error('expected meshes');
    expect(vertex(tall, 0).tone).toBe(MESH.toneMaxM);
    expect(vertex(short, 0).tone).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Decode, from bytes encoded by hand per the vector-tile spec
// ---------------------------------------------------------------------------

const zigzag = (n: number) => (n << 1) ^ (n >> 31);

/** Geometry commands for polygon rings (closing point omitted, as the spec stores them). */
function encodeRings(rings: Point2[][]): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const ring of rings) {
    const points = ring.slice(0, -1);
    const [first, ...rest] = points;
    out.push((1 & 7) | (1 << 3), zigzag(first[0] - cx), zigzag(first[1] - cy));
    [cx, cy] = first;
    out.push((2 & 7) | (rest.length << 3));
    for (const [x, y] of rest) {
      out.push(zigzag(x - cx), zigzag(y - cy));
      [cx, cy] = [x, y];
    }
    out.push((7 & 7) | (1 << 3));
  }
  return out;
}

function encodeTile(
  features: { rings: Point2[][]; height: number; hidden?: boolean }[],
): Uint8Array {
  const pbf = new PbfWriter();
  // `pbf`'s writer threads a context object through `writeMessage`; none is needed here.
  const message = (tag: number, write: () => void) => pbf.writeMessage(tag, write, null);
  message(3, () => {
    pbf.writeVarintField(15, 2);
    pbf.writeStringField(1, 'building');
    features.forEach((feature, i) => {
      message(2, () => {
        pbf.writeVarintField(1, i + 1);
        // keys: 0 render_height, 1 hide_3d; values: one per feature, then `true`.
        const tags = feature.hidden ? [0, i, 1, features.length] : [0, i];
        pbf.writePackedVarint(2, tags);
        pbf.writeVarintField(3, 3);
        pbf.writePackedVarint(4, encodeRings(feature.rings));
      });
    });
    pbf.writeStringField(3, 'render_height');
    pbf.writeStringField(3, 'hide_3d');
    for (const feature of features) message(4, () => pbf.writeDoubleField(3, feature.height));
    message(4, () => pbf.writeBooleanField(7, true));
    pbf.writeVarintField(5, 4096);
  });
  return pbf.finish();
}

describe('decodeBuildings', () => {
  test('reads rings and properties from real tile bytes', () => {
    const bytes = encodeTile([
      { rings: [tileRect(10, 10, 30, 30)], height: 12 },
      { rings: [tileRect(50, 50, 60, 60)], height: 40, hidden: true },
    ]);
    const decoded = decodeBuildings(bytes, 'building');
    if (!decoded) throw new Error('expected a layer');
    expect(decoded.extent).toBe(4096);
    expect(decoded.features).toHaveLength(2);
    expect(decoded.features[0].properties.render_height).toBe(12);
    expect(decoded.features[1].properties.hide_3d).toBe(true);
    expect(decodeBuildings(bytes, 'water')).toBeNull();
  });

  test('a spec-encoded exterior and its courtyard mesh as ONE building, not a hole', () => {
    const outer = tileRect(100, 100, 200, 200);
    const hole = tileRect(130, 130, 170, 170).reverse();
    const decoded = decodeBuildings(encodeTile([{ rings: [outer, hole], height: 25 }]), 'building');
    if (!decoded) throw new Error('expected a layer');
    const mesh = meshBuildings(decoded.features, OPTIONS);
    if (!mesh) throw new Error('expected a mesh');
    expect(mesh.polygons).toBe(1);
    // Courtyard walls face INTO the courtyard (toward its centre).
    const cx = 150;
    const cy = -150;
    let courtyardWalls = 0;
    for (let i = 0; i < vertexCount(mesh); i++) {
      const { position, normal } = vertex(mesh, i);
      if (Math.abs(normal[2]) > 0.01) continue;
      const inCourtyard =
        Math.abs(position[0] - cx) <= 20 + 1e-3 && Math.abs(position[1] - cy) <= 20 + 1e-3;
      if (!inCourtyard) continue;
      courtyardWalls++;
      expect((cx - position[0]) * normal[0] + (cy - position[1]) * normal[1]).toBeGreaterThan(0);
    }
    expect(courtyardWalls).toBeGreaterThan(0);
  });
});
