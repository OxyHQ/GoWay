/**
 * The street detail cut along the terrain's lattice (`cityStreets/
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
import { Buffers, MODE, STREET_LIFT_M } from '@/components/map/engine/cityStreets/meshBuffers';
import { StreetAtlas } from '@/components/map/engine/cityStreets/streetAtlas';
import { meshStreetTile, type StreetMesh } from '@/components/map/engine/cityStreets/streetMesher';
import { decodeRoadTile } from '@/components/map/engine/roads/roadTiles';
import {
  type GroundGrid,
  gridAt,
  latticeCells,
  sampleGroundGrid,
  TERRAIN_LATTICE,
} from '@/components/map/engine/city3d/terrainGround';
import { tileSizeMetres } from '@/components/map/engine/city3d/tileMath';

import { roadTile, SYNTHETIC_CENTRE } from './fixtures/syntheticCity';

const LATTICE: StreetLattice = { cells: 4, sizeM: 100 };
/** Line k of {@link LATTICE}, metres from the north-west corner. */
const line = (k: number) => (k + 0.5) * 25;

/** The cell a coordinate lies in, a point ON a line counting for both sides. */
function cellsOf(c: number): [number, number] {
  const f = c / 25 - 0.5;
  const k = Math.round(f);
  return Math.abs(f - k) < 1e-6 ? [k - 1, k] : [Math.floor(f), Math.floor(f)];
}

describe('the lattice', () => {
  test("is GoWay's DEM: what the streets are cut for before any terrain is on", () => {
    expect(TERRAIN_LATTICE).toEqual({ zoom: RELIEF_DEM.maxzoom, tileSize: RELIEF_DEM.tileSize });
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

  test('no piece crosses a line; area and winding kept', () => {
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
    }
    expect(after).toBeCloseTo(before, 6);
  });

  test('a cut vertex lies on its line, its attributes interpolated, its bytes the primitive’s', () => {
    const b = quad();
    const original = b.positions.length / 3;
    splitToLattice(b, LATTICE);
    let onLines = 0;
    for (let v = original; v < b.positions.length / 3; v++) {
      const x = b.positions[v * 3];
      const s = -b.positions[v * 3 + 1];
      const onX = [0, 1, 2, 3].some((k) => Math.abs(x - line(k)) < 1e-9);
      const onY = [0, 1, 2, 3].some((k) => Math.abs(s - line(k)) < 1e-9);
      expect(onX || onY).toBe(true);
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
    // The shared edge 0–2 crosses x = 12.5, 37.5 and y = −12.5, −37.5, −62.5:
    // each of those points is ONE vertex, used by pieces of both triangles.
    const p = b.positions;
    for (let v = 4; v < p.length / 3; v++) {
      for (let w = v + 1; w < p.length / 3; w++) {
        const same = Math.hypot(p[v * 3] - p[w * 3], p[v * 3 + 1] - p[w * 3 + 1]) < 1e-9;
        expect(same).toBe(false);
      }
    }
  });

  test('a triangle inside one cell is left as it is', () => {
    const b = new Buffers();
    b.vertex(13, -13, 0, [0, 0, 0, 0]);
    b.vertex(30, -14, 0, [0, 0, 0, 0]);
    b.vertex(20, -35, 0, [0, 0, 0, 0]);
    b.triangle(0, 1, 2);
    splitToLattice(b, LATTICE);
    expect(b.indices).toEqual([0, 1, 2]);
    expect(b.positions.length).toBe(9);
  });
});

describe('densifyToLattice', () => {
  test('a point wherever the line crosses a lattice line, in order, on the line', () => {
    const out = densifyToLattice(
      [
        [0, -20],
        [60, -20],
        [60, -70],
      ],
      LATTICE,
    );
    expect(out).toEqual([
      [0, -20],
      [12.5, -20],
      [37.5, -20],
      [60, -20],
      [60, -37.5],
      [60, -62.5],
      [60, -70],
    ]);
  });

  test('with two lines a pixel, the pixel centres and the lines halfway between them', () => {
    expect(
      densifyToLattice(
        [
          [0, -1],
          [60, -1],
        ],
        { ...LATTICE, sub: 2 },
      ),
    ).toEqual([
      [0, -1],
      [12.5, -1],
      [25, -1],
      [37.5, -1],
      [50, -1],
      [60, -1],
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

/** How far the drawn ground rises above a street's surfaces, at worst, and over how much of them. */
function terrainOverStreet(mesh: StreetMesh, grid: GroundGrid, sizeM: number) {
  const ground = (x: number, y: number) => gridAt(grid, x / sizeM, -y / sizeM);
  const { positions: p, indices } = mesh.surfaces;
  let worst = 0;
  let samples = 0;
  let over = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]];
    // As the vertex shader places them: each vertex on the ground, plus its own z.
    const h = v.map((i) => ground(p[i * 3], p[i * 3 + 1]) + p[i * 3 + 2]);
    const n = 8;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const [a, b] = [i / n, j / n];
        const c = 1 - a - b;
        const x = p[v[0] * 3] * a + p[v[1] * 3] * b + p[v[2] * 3] * c;
        const y = p[v[0] * 3 + 1] * a + p[v[1] * 3 + 1] * b + p[v[2] * 3 + 1] * c;
        const z = p[v[0] * 3 + 2] * a + p[v[1] * 3 + 2] * b + p[v[2] * 3 + 2] * c;
        const street = h[0] * a + h[1] * b + h[2] * c;
        const rise = ground(x, y) + z - street;
        samples++;
        if (rise > 0.005) over++;
        if (rise > worst) worst = rise;
      }
    }
  }
  return { worst, overPct: (100 * over) / samples };
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
  const rules = { drivingSide: 'right', yellowCentre: false } as const;
  const meshed = (groundSubdivision?: number) =>
    meshStreetTile({
      tile: { x, y },
      tiles,
      rules,
      atlas: new StreetAtlas(),
      ...(groundSubdivision ? { groundCells: cells, groundSubdivision } : {}),
    });
  const uncut = meshed();
  const cut = meshed(1);
  const fine = meshed(2);

  test('uncut, the street is under the ground between its vertices', () => {
    const { worst, overPct } = terrainOverStreet(uncut, grid, sizeM);
    expect(worst).toBeGreaterThan(STREET_LIFT_M);
    expect(overPct).toBeGreaterThan(10);
  });

  test('cut at the pixel centres, the ground never rises through the lifted street', () => {
    expect(cut.stats.surfaceTriangles).toBeGreaterThan(uncut.stats.surfaceTriangles);
    const { worst, overPct } = terrainOverStreet(cut, grid, sizeM);
    // What is left is the bilinear twist inside a pixel's square, over
    // pieces of at most 6 m by a pixel: under the street's lift.
    expect(worst).toBeLessThan(STREET_LIFT_M);
    expect(overPct).toBeLessThan(3);
  });

  test('cut at half pixels too (the high preset), a quarter of that', () => {
    expect(fine.stats.surfaceTriangles).toBeGreaterThan(cut.stats.surfaceTriangles);
    const coarse = terrainOverStreet(cut, grid, sizeM);
    const { worst, overPct } = terrainOverStreet(fine, grid, sizeM);
    expect(worst).toBeLessThan(coarse.worst / 2);
    expect(overPct).toBeLessThan(coarse.overPct / 2);
  });

  test('painted lines follow the creases: a vertex at every lattice crossing', () => {
    const lineVertices = (m: StreetMesh) => {
      let count = 0;
      for (let i = 0; i < m.markings.positions.length / 3; i++) {
        if (m.markings.attrs[i * 4 + 1] === MODE.line) count++;
      }
      return count;
    };
    expect(lineVertices(cut)).toBeGreaterThan(lineVertices(uncut));
    expect(lineVertices(fine)).toBeGreaterThan(lineVertices(cut));
  });
});
