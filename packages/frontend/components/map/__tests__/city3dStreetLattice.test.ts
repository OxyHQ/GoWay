/**
 * The street detail cut to the terrain's own facets (`cityStreets/
 * groundLattice.ts`, `docs/MAP_STREETS.md` → Terrain and depth): every
 * surface triangle inside one square of DEM pixel centres, every painted line
 * bent where it crosses one — so the drawn ground, creased along those lines,
 * never rises through the street between its vertices.
 */
import { describe, expect, test } from 'bun:test';

import { RELIEF_DEM } from '@/lib/map/style/relief';
import {
  densifyToLattice,
  type StreetLattice,
  splitToLattice,
} from '@/components/map/engine/cityStreets/groundLattice';
import {
  Buffers,
  MODE,
  STREET_LIFT_M,
  STREET_Z_PER_M,
} from '@/components/map/engine/cityStreets/meshBuffers';
import { StreetAtlas } from '@/components/map/engine/cityStreets/streetAtlas';
import { meshStreetTile, type StreetMesh } from '@/components/map/engine/cityStreets/streetMesher';
import { decodeRoadTile } from '@/components/map/engine/roads/roadTiles';
import {
  facetAt,
  gridAt,
  streetGround,
  streetGroundAt,
  latticeCells,
  sampleGroundGrid,
  TERRAIN_LATTICE,
} from '@/components/map/engine/city3d/terrainGround';
import { tileSizeMetres } from '@/components/map/engine/city3d/tileMath';

import { roadTile, SYNTHETIC_CENTRE } from './fixtures/syntheticCity';

const LATTICE: StreetLattice = { cells: 4, sizeM: 100 };
/** Line k of {@link LATTICE}, metres from the north-west corner. */
const line = (k: number) => k * 25;

/** The cell a coordinate lies in, a point ON a line counting for both sides. */
function cellsOf(c: number): [number, number] {
  const f = c / 25;
  const k = Math.round(f);
  return Math.abs(f - k) < 1e-6 ? [k - 1, k] : [Math.floor(f), Math.floor(f)];
}

describe('the lattice', () => {
  test("is GoWay's DEM: what the streets are cut for before any terrain is on", () => {
    expect(TERRAIN_LATTICE).toEqual({
      zoom: RELIEF_DEM.maxzoom,
      tileSize: RELIEF_DEM.tileSize,
      meshCells: 128,
    });
    expect(latticeCells({ z: 15 }, TERRAIN_LATTICE)).toBe(64);
  });
});

describe('splitToLattice', () => {
  /** Two triangles sharing an edge, across two lattice lines each way. */
  const quad = () => {
    const b = new Buffers();
    const attr = [7, 255, 2, 0];
    b.vertex(5, -5, 0, attr, [0, 0], [0, 0]);
    b.vertex(70, -10, 0, attr, [0, 0], [10, 0]);
    b.vertex(60, -80, 0.15, attr, [0, 0], [10, 10]);
    b.vertex(10, -60, 0.15, attr, [0, 0], [0, 10]);
    b.triangle(0, 1, 2);
    b.triangle(0, 2, 3);
    return b;
  };
  const area = (b: Buffers, t: number) => {
    const p = b.positions;
    const [i, j, k] = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
    return (
      ((p[j * 3] - p[i * 3]) * (p[k * 3 + 1] - p[i * 3 + 1]) -
        (p[k * 3] - p[i * 3]) * (p[j * 3 + 1] - p[i * 3 + 1])) /
      2
    );
  };

  test('no piece crosses a line or a square’s diagonal; area and winding kept', () => {
    const b = quad();
    const before = area(b, 0) + area(b, 3);
    splitToLattice(b, LATTICE);
    expect(b.indices.length / 3).toBeGreaterThan(8);
    let after = 0;
    for (let t = 0; t < b.indices.length; t += 3) {
      const a = area(b, t);
      // Same winding as the source (both source triangles are clockwise in x-east/y-north).
      expect(a).toBeLessThanOrEqual(1e-9);
      after += a;
      const verts = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
      for (const axis of [0, 1]) {
        const coords = verts.map((v) =>
          axis === 0 ? b.positions[v * 3] : -b.positions[v * 3 + 1],
        );
        // One cell holds all three: the intersection of their cell ranges is not empty.
        const lo = Math.max(...coords.map((c) => cellsOf(c)[0]));
        const hi = Math.min(...coords.map((c) => cellsOf(c)[1]));
        expect(lo).toBeLessThanOrEqual(hi);
      }
      // …and one of its two triangles: the north-west/south-east diagonal
      // (east − south constant) does not pass between its vertices.
      const lx = verts.map((v) => b.positions[v * 3] / 25);
      const ls = verts.map((v) => -b.positions[v * 3 + 1] / 25);
      const kx = Math.floor((lx[0] + lx[1] + lx[2]) / 3);
      const ks = Math.floor((ls[0] + ls[1] + ls[2]) / 3);
      const side = verts.map((_, k) => lx[k] - kx - (ls[k] - ks));
      expect(Math.min(...side) >= -1e-9 || Math.max(...side) <= 1e-9).toBe(true);
    }
    expect(after).toBeCloseTo(before, 6);
  });

  test('a cut vertex lies on its line or diagonal, its attributes interpolated, its bytes the primitive’s', () => {
    const b = quad();
    const original = b.positions.length / 3;
    splitToLattice(b, LATTICE);
    let onLines = 0;
    for (let v = original; v < b.positions.length / 3; v++) {
      const x = b.positions[v * 3];
      const s = -b.positions[v * 3 + 1];
      const onX = [0, 1, 2, 3, 4].some((k) => Math.abs(x - line(k)) < 1e-9);
      const onY = [0, 1, 2, 3, 4].some((k) => Math.abs(s - line(k)) < 1e-9);
      const d = x / 25 - s / 25;
      const onDiagonal = Math.abs(d - Math.round(d)) < 1e-9;
      expect(onX || onY || onDiagonal).toBe(true);
      onLines++;
      expect([...b.attrs.slice(v * 4, v * 4 + 4)]).toEqual([7, 255, 2, 0]);
      // uv runs with the quad's own corners: inside its 0–10 square.
      expect(b.uvs[v * 2]).toBeGreaterThanOrEqual(-1e-9);
      expect(b.uvs[v * 2]).toBeLessThanOrEqual(10 + 1e-9);
      // z (a slab's top) interpolated between the corners' 0 and 0.15.
      expect(b.positions[v * 3 + 2]).toBeGreaterThanOrEqual(-1e-9);
      expect(b.positions[v * 3 + 2]).toBeLessThanOrEqual(0.15 + 1e-9);
    }
    expect(onLines).toBeGreaterThan(4);
  });

  test('crack-free: the shared edge is cut once, both triangles use the same vertex', () => {
    const b = quad();
    splitToLattice(b, LATTICE);
    // The shared edge 0–2 crosses x = 25, 50 and y = −25, −50, −75 (and diagonals):
    // each of those points is ONE vertex, used by pieces of both triangles.
    const p = b.positions;
    for (let v = 4; v < p.length / 3; v++) {
      for (let w = v + 1; w < p.length / 3; w++) {
        const same = Math.hypot(p[v * 3] - p[w * 3], p[v * 3 + 1] - p[w * 3 + 1]) < 1e-9;
        expect(same).toBe(false);
      }
    }
  });

  test('a triangle inside one facet is left as it is', () => {
    const b = new Buffers();
    b.vertex(27, -26, 0, [0, 0, 0, 0]);
    b.vertex(45, -28, 0, [0, 0, 0, 0]);
    b.vertex(45, -40, 0, [0, 0, 0, 0]);
    b.triangle(0, 1, 2);
    splitToLattice(b, LATTICE);
    expect(b.indices).toEqual([0, 1, 2]);
    expect(b.positions.length).toBe(9);
  });
});

/** Points equal to within float rounding. */
function expectPoints(actual: [number, number][], expected: [number, number][]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach(([x, y], i) => {
    expect(x).toBeCloseTo(expected[i][0], 9);
    expect(y).toBeCloseTo(expected[i][1], 9);
  });
}

describe('densifyToLattice', () => {
  test('a point wherever the line crosses a mesh line or a diagonal, in order, on the line', () => {
    const out = densifyToLattice(
      [
        [0, -20],
        [60, -20],
        [60, -70],
      ],
      LATTICE,
    );
    // y −20 is 0.8 of its square south: diagonals at 20 and 45, lines at 25
    // and 50; then, 0.4 of its square east, lines at −25, −50 and diagonals at
    // −35, −60.
    expectPoints(out, [
      [0, -20],
      [20, -20],
      [25, -20],
      [45, -20],
      [50, -20],
      [60, -20],
      [60, -25],
      [60, -35],
      [60, -50],
      [60, -60],
      [60, -70],
    ]);
  });
});

/**
 * Bare-earth-like ground, metres at a lng/lat: a slope, swells, and folds a
 * few DEM pixels across (as `city3dTerrainSampler.test.ts`).
 */
function surface(lng: number, lat: number): number {
  const m = lng * 83_500;
  const n = lat * 111_320;
  return 40 + 0.03 * (n % 10_000) + 0.5 * Math.sin(m / 22 + 1) * Math.sin(n / 18);
}

type Ground = (x: number, y: number) => number;

/**
 * Sample points inside every triangle of a packed buffer (positions x, y; a
 * surface's height in its attr's last byte, a marking's 0), placed as the
 * vertex shader places them — each vertex on `street`, plus its own height —
 * against `drawn` at the same point: how far `drawn` rises above them, at
 * worst, over how many of them, and the largest gap either way.
 */
function against(
  buffers: { positions: Float32Array; attrs: Uint8Array; indices: Uint32Array },
  street: Ground,
  drawn: Ground,
  only?: (vertex: number) => boolean,
  heights = true,
) {
  const { positions: xy, attrs, indices } = buffers;
  // x, y, z per vertex, as the shader assembles them.
  const p = new Float64Array((xy.length / 2) * 3);
  for (let v = 0; v < xy.length / 2; v++) {
    p[v * 3] = xy[v * 2];
    p[v * 3 + 1] = xy[v * 2 + 1];
    p[v * 3 + 2] = heights ? attrs[v * 4 + 3] / STREET_Z_PER_M : 0;
  }
  let worst = 0;
  let gap = 0;
  let samples = 0;
  let over = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]];
    if (only && !only(v[0])) continue;
    const h = v.map((i) => street(p[i * 3], p[i * 3 + 1]) + p[i * 3 + 2]);
    const n = 8;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const [a, b] = [i / n, j / n];
        const c = 1 - a - b;
        const x = p[v[0] * 3] * a + p[v[1] * 3] * b + p[v[2] * 3] * c;
        const y = p[v[0] * 3 + 1] * a + p[v[1] * 3 + 1] * b + p[v[2] * 3 + 1] * c;
        const z = p[v[0] * 3 + 2] * a + p[v[1] * 3 + 2] * b + p[v[2] * 3 + 2] * c;
        const rise = drawn(x, y) + z - (h[0] * a + h[1] * b + h[2] * c);
        samples++;
        if (rise > 0.005) over++;
        if (rise > worst) worst = rise;
        if (Math.abs(rise) > gap) gap = Math.abs(rise);
      }
    }
  }
  return { worst, gap, overPct: (100 * over) / samples };
}

describe('a street tile on a creased ground', () => {
  const n = 2 ** 15;
  const x = Math.floor(((SYNTHETIC_CENTRE.lng + 180) / 360) * n);
  const latRad = (SYNTHETIC_CENTRE.lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  const tile = { z: 15, x, y };
  const tiles: { x: number; y: number; data: ReturnType<typeof decodeRoadTile> }[] = [];
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      const bytes = roadTile(15, x + dx, y + dy);
      if (bytes.length) {
        tiles.push({ x: x + dx, y: y + dy, data: decodeRoadTile(bytes, { x: x + dx, y: y + dy }) });
      }
    }
  }
  const cells = latticeCells(tile, TERRAIN_LATTICE);
  const grid = sampleGroundGrid(tile, cells, surface);
  const sizeM = tileSizeMetres(tile);
  /** The DEM, bilinear: what MapLibre's terrain tiles converge to at street level. */
  const bilinear: Ground = (px, py) => gridAt(grid, px / sizeM, -py / sizeM);
  /** The street's ground, what its shader reads: the terrain mesh, raised by its twist allowance. */
  const street = streetGround(grid, 128);
  const facets: Ground = (px, py) => streetGroundAt(street, px / sizeM, -py / sizeM);
  /** The terrain mesh itself on the tile (MapLibre's z15 mesh). */
  const mesh15: Ground = (px, py) => facetAt(grid, px / sizeM, -py / sizeM, 128);
  const rules = { drivingSide: 'right', yellowCentre: false } as const;
  const meshed = (groundMeshCells?: number) =>
    meshStreetTile({
      tile: { x, y },
      tiles,
      rules,
      atlas: new StreetAtlas(),
      ...(groundMeshCells ? { groundMeshCells } : {}),
    });
  const uncut = meshed();
  const cut = meshed(128);

  test('uncut, with every vertex on the DEM, the street is under it between its vertices', () => {
    const { worst, overPct } = against(uncut.surfaces, bilinear, bilinear);
    expect(worst).toBeGreaterThan(STREET_LIFT_M);
    expect(overPct).toBeGreaterThan(10);
  });

  test('cut: every piece ON its facet, and under the lift from the bilinear DEM', () => {
    expect(cut.stats.surfaceTriangles).toBeGreaterThan(uncut.stats.surfaceTriangles);
    // Flat pieces on flat facets: exactly the ground the shader reads.
    expect(against(cut.surfaces, facets, facets).gap).toBeLessThan(1e-4);
    // Never under the terrain: not under the bilinear DEM (what finer terrain
    // tiles converge to), not under MapLibre's z15 mesh — before any lift.
    expect(against(cut.surfaces, facets, bilinear).worst).toBeLessThan(1e-4);
    expect(against(cut.surfaces, facets, mesh15).worst).toBeLessThan(1e-4);
  });

  test('cut: the paint lies on the asphalt’s plane (no layer rises through another)', () => {
    // Tints, crossings, arrows and words (not lines: a line's vertices are
    // centre points the shader widens), at every point inside them.
    const { attrs } = cut.markings;
    const flat = (vertex: number) => attrs[vertex * 4 + 1] !== MODE.line;
    expect(against(cut.markings, facets, facets, flat, false).gap).toBeLessThan(1e-4);
    // Uncut on the bilinear DEM, the same paint is off the asphalt's plane.
    const { attrs: before } = uncut.markings;
    const flatBefore = (vertex: number) => before[vertex * 4 + 1] !== MODE.line;
    expect(against(uncut.markings, bilinear, bilinear, flatBefore, false).gap).toBeGreaterThan(
      0.005,
    );
  });

  test('painted lines follow the creases: a vertex at every mesh crossing', () => {
    const lineVertices = (m: StreetMesh) => {
      let count = 0;
      for (let i = 0; i < m.markings.positions.length / 2; i++) {
        if (m.markings.attrs[i * 4 + 1] === MODE.line) count++;
      }
      return count;
    };
    expect(lineVertices(cut)).toBeGreaterThan(lineVertices(uncut));
  });
});
