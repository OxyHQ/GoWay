/**
 * The far-field meshes and the compact vertex format: simplification keeps
 * tile seams exact, the far levels are cheaper and keep every height, and the
 * packed buffers decode — through the model matrix, as the GPU does it — to
 * the same points the mesher built, within the stated quantum.
 */
import { describe, expect, test } from 'bun:test';

import {
  LOD_DETAIL,
  lodPolygons,
  meshBuildingsLod,
} from '@/components/map/engine/city3d/lodMesher';
import {
  type BuildingFeature,
  meshBuildings,
  type Point2,
  type Ring,
  signedArea,
  type TileMesh,
} from '@/components/map/engine/city3d/mesher';
import {
  type PackedMesh,
  packMesh,
  quantizedModelMatrix,
  unitMetres,
  Z_UNITS_PER_METRE,
} from '@/components/map/engine/city3d/packing';
import { segmentDistanceSq, simplifyRing } from '@/components/map/engine/city3d/simplify';
import { tileModelMatrix } from '@/components/map/engine/city3d/tileMath';
import { poolSize, pickWorker, hashKey } from '@/components/map/engine/city3d/workerPool';

const OPTIONS = { extent: 4096, tileSizeMetres: 4096 };

/** A clockwise-as-drawn (tile convention) ring from points, closed. */
const closed = (points: Point2[]): Point2[] => [...points, points[0]];

/** A rectangle with `wiggle` m of noise on its long edges, `steps` points per edge. */
function noisyRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  wiggle: number,
  steps = 20,
): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < steps; i++)
    out.push([x0 + ((x1 - x0) * i) / steps, y0 + (i % 2 ? wiggle : 0)]);
  for (let i = 0; i < steps; i++) out.push([x1, y0 + ((y1 - y0) * i) / steps]);
  for (let i = 0; i < steps; i++)
    out.push([x1 - ((x1 - x0) * i) / steps, y1 - (i % 2 ? wiggle : 0)]);
  for (let i = 0; i < steps; i++) out.push([x0, y1 - ((y1 - y0) * i) / steps]);
  return closed(out);
}

const feature = (rings: Point2[][], height = 20): BuildingFeature => ({
  rings,
  properties: { render_height: height, render_min_height: 0 },
});

/** Decode a packed vertex through the quantised model matrix (metres frame: model = identity). */
function decodeVertex(mesh: PackedMesh, chunk: number, v: number): [number, number, number] {
  const m = quantizedModelMatrix(
    // biome-ignore format: identity.
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    mesh.unitM,
    mesh.originM,
  );
  const p = mesh.chunks[chunk].position;
  const [x, y, z] = [p[v * 4], p[v * 4 + 1], p[v * 4 + 2]];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

describe('simplifyRing', () => {
  const ring = (points: Point2[], cut?: boolean[]): Ring => ({
    points,
    cut: cut ?? points.map(() => false),
  });

  test('drops points within the tolerance, keeps the corners', () => {
    const points = noisyRect(0, 0, 100, 50, 0.3).slice(0, -1);
    const out = simplifyRing(ring(points), 1);
    expect(out.points.length).toBeLessThan(points.length / 4);
    for (const corner of [
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
    ] as Point2[]) {
      expect(out.points.some((p) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < 1)).toBe(true);
    }
    // Every dropped point is within the tolerance of the simplified outline.
    for (const p of points) {
      let best = Infinity;
      for (let i = 0; i < out.points.length; i++) {
        const a = out.points[i];
        const b = out.points[(i + 1) % out.points.length];
        best = Math.min(best, segmentDistanceSq(p, a, b));
      }
      expect(Math.sqrt(best)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test('cut edges (the tile seam) survive exactly, and stay cut', () => {
    // A ring whose west side lies on the tile edge x = 0, wiggly elsewhere.
    const points = noisyRect(0, 0, 60, 40, 0.4, 10).slice(0, -1);
    const cut = points.map((p, i) => p[0] === 0 && points[(i + 1) % points.length][0] === 0);
    const out = simplifyRing(ring(points, cut), 2);
    const seam = (r: Ring) =>
      r.points
        .map((p, i) => (r.cut[i] ? `${p}->${r.points[(i + 1) % r.points.length]}` : null))
        .filter(Boolean);
    expect(seam(out)).toEqual(seam(ring(points, cut)));
    expect(out.cut.filter(Boolean).length).toBe(cut.filter(Boolean).length);
  });

  test('zero tolerance and tiny rings are left alone', () => {
    const points: Point2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(simplifyRing(ring(points), 5).points).toEqual(points);
    const big = noisyRect(0, 0, 10, 10, 0.1).slice(0, -1);
    expect(simplifyRing(ring(big), 0).points).toEqual(big);
  });
});

describe('the far levels', () => {
  const wiggly = feature([noisyRect(100, 100, 300, 180, 0.4)], 30);

  test('are cheaper than full detail, level 2 cheaper than level 1', () => {
    const full = packMesh(meshBuildings([wiggly], OPTIONS) as TileMesh, OPTIONS.tileSizeMetres);
    const one = meshBuildingsLod([wiggly], OPTIONS, 1) as PackedMesh;
    const two = meshBuildingsLod([wiggly], OPTIONS, 2) as PackedMesh;
    expect(one.vertices).toBeLessThan(full.vertices / 2);
    expect(two.vertices).toBeLessThanOrEqual(one.vertices);
    expect(one.bytes).toBeLessThan(full.bytes);
  });

  test('keep the building’s heights exactly (only the outline is simplified)', () => {
    const lifted: BuildingFeature = {
      rings: [noisyRect(100, 100, 300, 180, 0.4)],
      properties: { render_height: 42, render_min_height: 6 },
    };
    for (const lod of [1, 2] as const) {
      const mesh = meshBuildingsLod([lifted], OPTIONS, lod) as PackedMesh;
      const heights = new Set<number>();
      mesh.chunks.forEach((chunk, c) => {
        for (let v = 0; v < chunk.position.length / 4; v++)
          heights.add(decodeVertex(mesh, c, v)[2]);
      });
      expect([...heights].sort((a, b) => a - b)).toEqual([6, 42]);
    }
  });

  test('level 2 drops low slivers but keeps a slim tower; level 1 keeps both', () => {
    const shed = feature(
      [
        closed([
          [0, 0],
          [6, 0],
          [6, 6],
          [0, 6],
        ]),
      ],
      4,
    );
    const tower = feature(
      [
        closed([
          [50, 50],
          [56, 50],
          [56, 56],
          [50, 56],
        ]),
      ],
      120,
    );
    expect(meshBuildingsLod([shed], OPTIONS, 1)).not.toBeNull();
    expect(meshBuildingsLod([shed], OPTIONS, 2)).toBeNull();
    expect(meshBuildingsLod([tower], OPTIONS, 2)).not.toBeNull();
  });

  test('level 2 fills a small courtyard; level 1 keeps it', () => {
    // A 60 × 60 block with a 8 × 8 courtyard (64 m² < 150 m²), courtyard as a hole.
    const block = closed([
      [0, 0],
      [60, 0],
      [60, 60],
      [0, 60],
    ]);
    const yard = closed([
      [26, 26],
      [26, 34],
      [34, 34],
      [34, 26],
    ]);
    const withYard = feature([block, yard], 20);
    const [one] = lodPolygons(withYard, OPTIONS, LOD_DETAIL[1], 20);
    const [two] = lodPolygons(withYard, OPTIONS, LOD_DETAIL[2], 20);
    expect(one.length).toBe(2);
    expect(two.length).toBe(1);
    expect(signedArea(two[0].points)).toBeGreaterThan(0);
  });

  test('a tile seam stays flush: no wall is built along a cut edge', () => {
    // A block cut by the tile's west edge (it spills past x = 0).
    const spill = feature(
      [
        closed([
          [-20, 10],
          [40, 10],
          [40, 50],
          [-20, 50],
        ]),
      ],
      20,
    );
    const mesh = meshBuildingsLod([spill], OPTIONS, 2) as PackedMesh;
    // Walls are 4 vertices each, the roof 4: three walls (no west wall) + roof.
    expect(mesh.vertices).toBe(3 * 4 + 4);
  });
});

describe('the packed format', () => {
  const block = feature([noisyRect(500, 600, 900, 820, 0.5, 30)], 37);

  test('decodes, through the model matrix, to the mesher’s own points within the quantum', () => {
    const mesh = meshBuildings([block], OPTIONS) as TileMesh;
    const packed = packMesh(mesh, OPTIONS.tileSizeMetres);
    const quantum = unitMetres(OPTIONS.tileSizeMetres);
    // Every source vertex appears in the packed chunks (order preserved by the range copy).
    let v = 0;
    packed.chunks.forEach((chunk, c) => {
      for (let i = 0; i < chunk.position.length / 4; i++, v++) {
        const [x, y, z] = decodeVertex(packed, c, i);
        expect(Math.abs(x - mesh.positions[v * 3])).toBeLessThanOrEqual(quantum / 2 + 1e-9);
        expect(Math.abs(y - mesh.positions[v * 3 + 1])).toBeLessThanOrEqual(quantum / 2 + 1e-9);
        expect(Math.abs(z - mesh.positions[v * 3 + 2])).toBeLessThanOrEqual(
          1 / Z_UNITS_PER_METRE / 2 + 1e-9,
        );
        // Shade word: tone (height) × 256 + corner occlusion.
        const w = chunk.position[i * 4 + 3];
        expect(w >> 8).toBe(mesh.shade[v * 2 + 1]);
        expect(w & 255).toBe(mesh.shade[v * 2]);
      }
    });
    expect(packed.triangles).toBe(mesh.indices.length / 3);
  });

  test('a whole building crossing the tile edge keeps its shape on both sides (city tiles)', () => {
    // GoWay city tiles keep each building whole in its centre's tile, so its
    // coordinates run past the square: here 30 m west of it and 20 m north.
    const size = 1000;
    const corners = [
      [-30, 10],
      [40, 10],
      [40, -50],
      [-30, -50],
      [5, 20],
    ];
    const positions = new Float32Array(corners.flatMap(([x, y]) => [x, y, 12]));
    const mesh: TileMesh = {
      positions,
      normals: new Int8Array(positions.length),
      shade: new Uint8Array((positions.length / 3) * 2),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 4, 1]),
      bounds: { min: [-30, -50, 12], max: [40, 20, 12] },
      polygons: 1,
      polygonStarts: new Uint32Array([0]),
      polygonBoxes: new Float32Array([-30, -50, 40, 20]),
    };
    const packed = packMesh(mesh, size);
    expect(packed.originM).toEqual([-30, 20]);
    const decoded = packed.chunks[0];
    // One chunk, in the mesh's own vertex order.
    for (let i = 0; i < decoded.position.length / 4; i++) {
      const [x, y] = decodeVertex(packed, 0, i);
      expect(Math.abs(x - positions[i * 3])).toBeLessThanOrEqual(packed.unitM);
      expect(Math.abs(y - positions[i * 3 + 1])).toBeLessThanOrEqual(packed.unitM);
    }
  });

  test('inside its tile a mesh keeps the tile’s frame', () => {
    const mesh = meshBuildings([block], OPTIONS) as TileMesh;
    const packed = packMesh(mesh, OPTIONS.tileSizeMetres);
    expect(packed.originM).toEqual([0, 0]);
    expect(packed.unitM).toBe(unitMetres(OPTIONS.tileSizeMetres));
  });

  test('the quantised model matrix is the tile matrix times the unit scale', () => {
    const tile = { z: 14, x: 8290, y: 6119 };
    const center = { x: 0.506, y: 0.3735 };
    const model = tileModelMatrix(tile, center);
    const q = quantizedModelMatrix(model, 0.03);
    // A stored (x, y, z) = (1000, 2000, 320) is (30 m, -60 m, 10 m) in ENU.
    const apply = (m: number[], p: number[]) =>
      [0, 1, 2].map((row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]);
    const viaQ = apply(q, [1000, 2000, 320]);
    const direct = apply(model, [30, -60, 10]);
    for (let i = 0; i < 3; i++) expect(viaQ[i]).toBeCloseTo(direct[i], 15);
  });

  /** A synthetic mesh far past one chunk: a grid of small buildings. */
  function bigMesh(): TileMesh {
    const features: BuildingFeature[] = [];
    for (let i = 0; i < 70; i++) {
      for (let j = 0; j < 70; j++) {
        features.push(
          feature(
            [noisyRect(10 + i * 55, 10 + j * 55, 50 + i * 55, 50 + j * 55, 0.2, 2)],
            10 + (i % 7),
          ),
        );
      }
    }
    return meshBuildings(features, OPTIONS) as TileMesh;
  }

  test('a mesh past 65,536 vertices is ONE draw, with 32-bit indices (one draw per tile)', () => {
    const mesh = bigMesh();
    expect(mesh.positions.length / 3).toBeGreaterThan(65_536 * 2);
    const packed = packMesh(mesh, 4096);
    expect(packed.chunks).toHaveLength(1);
    const [chunk] = packed.chunks;
    expect(chunk.index).toBeInstanceOf(Uint32Array);
    expect(chunk.position.length / 4).toBe(mesh.positions.length / 3);
    expect(Array.from(chunk.index)).toEqual(Array.from(mesh.indices));
    expect(packed.triangles).toBe(mesh.indices.length / 3);
  });

  test('a mesh within 65,536 vertices keeps 16-bit indices', () => {
    const mesh = meshBuildings([block], OPTIONS) as TileMesh;
    const packed = packMesh(mesh, OPTIONS.tileSizeMetres);
    expect(packed.chunks).toHaveLength(1);
    expect(packed.chunks[0].index).toBeInstanceOf(Uint16Array);
    const far = meshBuildingsLod([block], OPTIONS, 1);
    expect(far?.chunks).toHaveLength(1);
    expect(far?.chunks[0].index).toBeInstanceOf(Uint16Array);
  });

  test('GoWay city tiles’ colour and facade lanes travel with their vertex', () => {
    const mesh = bigMesh();
    const n = mesh.positions.length / 3;
    // Each source vertex's lanes spell its own index, so a packed vertex can
    // be traced back to the source vertex its lanes came from.
    const colors = new Uint8Array(n * 4);
    const facade = new Uint16Array(n * 4);
    for (let v = 0; v < n; v++) {
      colors.set([v & 255, (v >> 8) & 255, (v >> 16) & 255, 9], v * 4);
      facade.set([v & 65_535, v >>> 16, 3, 4], v * 4);
    }
    const unit = unitMetres(4096);
    for (const packed of [packMesh({ ...mesh, colors, facade }, 4096)]) {
      let vertices = 0;
      for (const chunk of packed.chunks) {
        const count = chunk.position.length / 4;
        vertices += count;
        // Every seventh vertex: enough to cover the mesh, cheap enough to run.
        for (let i = 0; i < count; i += 7) {
          const c = chunk.color as Uint8Array;
          const f = chunk.facade as Uint16Array;
          const v = c[i * 4] | (c[i * 4 + 1] << 8) | (c[i * 4 + 2] << 16);
          expect(f[i * 4] | (f[i * 4 + 1] << 16)).toBe(v);
          expect(c[i * 4 + 3]).toBe(9);
          // …and the position and shade beside them are that vertex's.
          expect(chunk.position[i * 4]).toBe(Math.round(mesh.positions[v * 3] / unit));
          expect(chunk.position[i * 4 + 2]).toBe(
            Math.round(mesh.positions[v * 3 + 2] * Z_UNITS_PER_METRE),
          );
          expect(chunk.position[i * 4 + 3]).toBe(mesh.shade[v * 2 + 1] * 256 + mesh.shade[v * 2]);
        }
      }
      expect(vertices).toBeGreaterThan(65_536 * 2);
      const lanes = packed.chunks.reduce(
        (sum, chunk) => sum + (chunk.color?.byteLength ?? 0) + (chunk.facade?.byteLength ?? 0),
        0,
      );
      expect(lanes).toBe(vertices * 12);
    }
  });

  test('is smaller than the float format it replaces', () => {
    const mesh = bigMesh();
    const before =
      mesh.positions.byteLength +
      mesh.normals.byteLength +
      mesh.shade.byteLength +
      mesh.indices.byteLength;
    const after = packMesh(mesh, 4096).bytes;
    // Past 65,536 vertices the indices stay 32-bit (one draw per tile), so
    // the saving is the vertex lanes': 12 B a vertex against 17 B.
    expect(after / before).toBeLessThan(0.8);
  });
});

describe('the worker pool', () => {
  test('size leaves a core for the page, and stays small', () => {
    expect(poolSize(undefined)).toBe(1);
    expect(poolSize(2)).toBe(1);
    expect(poolSize(4)).toBe(3);
    expect(poolSize(32)).toBe(3);
  });

  test('a tile goes back to its own worker unless that one is busy', () => {
    const key = '14/8290/6119';
    const home = hashKey(key) % 3;
    expect(pickWorker([0, 0, 0], key)).toBe(home);
    const busy = [0, 0, 0];
    busy[home] = 3;
    expect(pickWorker(busy, key)).not.toBe(home);
    const slightly = [1, 1, 1];
    slightly[home] = 2;
    expect(pickWorker(slightly, key)).toBe(home);
  });
});
