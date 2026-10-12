/**
 * The street geometry cut along the TERRAIN's own lattice, so every street
 * triangle lies on one smooth piece of the drawn ground
 * (`docs/MAP_STREETS.md` → Terrain and depth).
 *
 * MapLibre draws the terrain from its DEM read bilinearly between pixel
 * centres (`get_elevation` in its vertex prelude): a surface that is smooth
 * inside each square of four pixel centres and creased along the lines
 * through them. The street reads the same surface at each of its vertices
 * (`terrainGround.ts` → `GroundGrid`), and a GPU draws a triangle flat between
 * its vertices — so a triangle that spans a crease cuts under a ridge or
 * floats over a valley. A junction polygon is 30 m of asphalt with no vertex
 * inside it; the DEM's pixels are ≈14 m at Barcelona's latitude. Measured on
 * the Mallorca–Marina tile with every vertex on the right surface: the terrain
 * still covered 0.4% of the street, by up to 25 cm. Cut on the lattice, every
 * triangle lies inside one square, where the bilinear surface is a smooth
 * saddle that differs from MapLibre's own 128-cell mesh by millimetres at
 * street zooms (`city3dGroundLattice.test.ts`).
 *
 * Pure and dependency-free: runs in the street worker, after the mesher has
 * laid everything out, on the builder's plain arrays (`meshBuffers.ts`).
 */
import type { Buffers } from './meshBuffers';

/**
 * The terrain's lattice over one tile, in the tile's local metres (x east from
 * its west edge, y NORTH from its north edge, so ≤ 0 inside it): the lines
 * through the DEM's pixel centres, at `(k + ½) · sizeM / cells` east and south
 * of the north-west corner.
 */
export interface StreetLattice {
  /** DEM pixels across the tile (`terrainGround.ts` → `latticeCells`). */
  cells: number;
  /** The tile's side, metres (the mesher's own frame). */
  sizeM: number;
  /**
   * Lines per DEM pixel (default 1): 2 adds the lines halfway between the
   * pixel centres — the lines MapLibre's own mesh has at street level — so a
   * piece spans at most a quarter of a pixel's square and the bilinear twist
   * inside it a quarter as far (the quality profile's
   * `streets.groundSubdivision`).
   */
  sub?: number;
}

/** Along x (east) when 0, along −y (south) when 1: both run with the DEM's pixel index. */
type Axis = 0 | 1;

/** Where line `k` of a lattice is, metres: pixel centres at every `sub`-th line. */
function lineAt(lattice: StreetLattice): (k: number) => number {
  const step = lattice.sizeM / lattice.cells;
  const sub = Math.max(1, Math.round(lattice.sub ?? 1));
  return (k) => (k / sub + 0.5) * step;
}

/** The lattice lines strictly between `lo` and `hi`, as their indices `k`, ascending. */
function linesBetween(lo: number, hi: number, lattice: StreetLattice): [number, number] {
  const step = lattice.sizeM / lattice.cells;
  const sub = Math.max(1, Math.round(lattice.sub ?? 1));
  const first = Math.floor((lo / step - 0.5) * sub) + 1;
  const last = Math.ceil((hi / step - 0.5) * sub) - 1;
  return [first, last];
}

/**
 * Split every triangle of `buffers` that crosses a lattice line into pieces
 * that do not, in place: new vertices are appended (positions, offsets and
 * uvs interpolated; the byte attributes are the primitive's own, taken from
 * an end of the cut edge), and the index list is rewritten in order, so the
 * levels' ranges stay where they were.
 *
 * Crack-free: a cut is computed from the edge's two vertices in index order
 * and kept by `(edge, line)`, so two triangles sharing an edge share its cut
 * vertex exactly.
 *
 * Not for painted LINES: a line vertex is a centre point plus a half-width
 * offset that the shader widens to a pixel (`streetMaterials.ts`), so a cut
 * across a line would give a vertex part-way across that the widening flings
 * to the edge. Lines are cut along their length instead
 * ({@link densifyToLattice}).
 */
export function splitToLattice(buffers: Buffers, lattice: StreetLattice): void {
  if (!(lattice.sizeM / lattice.cells > 0) || buffers.indices.length === 0) return;
  const line = lineAt(lattice);
  const { positions, offsets, uvs, attrs } = buffers;
  const withOffsets = offsets.length > 0;
  const withUvs = uvs.length > 0;
  const coord = (v: number, axis: Axis) => (axis === 0 ? positions[v * 3] : -positions[v * 3 + 1]);
  const cuts = new Map<string, number>();

  const cut = (p: number, q: number, axis: Axis, k: number): number => {
    const lo = Math.min(p, q);
    const hi = Math.max(p, q);
    const key = `${lo}:${hi}:${axis}:${k}`;
    const known = cuts.get(key);
    if (known !== undefined) return known;
    const a = coord(lo, axis);
    const b = coord(hi, axis);
    const t = (line(k) - a) / (b - a);
    let v: number;
    if (!(t > 0)) v = lo;
    else if (!(t < 1)) v = hi;
    else {
      v = positions.length / 3;
      for (let c = 0; c < 3; c++) {
        positions.push(positions[lo * 3 + c] + (positions[hi * 3 + c] - positions[lo * 3 + c]) * t);
      }
      // The cut lies exactly on the line, whatever the rounding above did.
      if (axis === 0) positions[v * 3] = line(k);
      else positions[v * 3 + 1] = -line(k);
      if (withOffsets) {
        for (let c = 0; c < 2; c++) {
          offsets.push(offsets[lo * 2 + c] + (offsets[hi * 2 + c] - offsets[lo * 2 + c]) * t);
        }
      }
      if (withUvs) {
        for (let c = 0; c < 2; c++)
          uvs.push(uvs[lo * 2 + c] + (uvs[hi * 2 + c] - uvs[lo * 2 + c]) * t);
      }
      for (let c = 0; c < 4; c++) attrs.push(attrs[lo * 4 + c]);
    }
    cuts.set(key, v);
    return v;
  };

  /** Split a convex polygon at line `k`: the part before it and the part on and after it. */
  const slice = (poly: number[], axis: Axis, k: number): [number[], number[]] => {
    const at = line(k);
    const before: number[] = [];
    const after: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const pBefore = coord(p, axis) < at;
      const qBefore = coord(q, axis) < at;
      (pBefore ? before : after).push(p);
      if (pBefore !== qBefore) {
        const m = cut(p, q, axis, k);
        before.push(m);
        after.push(m);
      }
    }
    return [before, after];
  };

  const source = buffers.indices;
  const out: number[] = [];
  for (let i = 0; i < source.length; i += 3) {
    const tri = [source[i], source[i + 1], source[i + 2]];
    let pieces = [tri];
    for (const axis of [0, 1] as const) {
      const next: number[][] = [];
      for (const poly of pieces) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of poly) {
          const c = coord(v, axis);
          if (c < lo) lo = c;
          if (c > hi) hi = c;
        }
        const [first, last] = linesBetween(lo, hi, lattice);
        let rest = poly;
        for (let k = first; k <= last; k++) {
          const [before, after] = slice(rest, axis, k);
          if (before.length >= 3) next.push(before);
          rest = after;
        }
        if (rest.length >= 3) next.push(rest);
      }
      pieces = next;
    }
    if (pieces.length === 1 && pieces[0] === tri) {
      out.push(tri[0], tri[1], tri[2]);
      continue;
    }
    // Each piece is convex (a triangle cut by straight lines): a fan, winding kept.
    for (const poly of pieces) {
      for (let j = 1; j + 1 < poly.length; j++) out.push(poly[0], poly[j], poly[j + 1]);
    }
  }
  buffers.indices = out;
}

/**
 * A polyline with a point added wherever it crosses a lattice line — what a
 * painted line needs to follow the ground's creases (its vertices are centre
 * points; see {@link splitToLattice}). The added points lie on the original
 * segments, so the line's mitred normals do not change.
 */
export function densifyToLattice(
  points: readonly [number, number][],
  lattice: StreetLattice,
): [number, number][] {
  if (!(lattice.sizeM / lattice.cells > 0) || points.length < 2) return points.slice();
  const line = lineAt(lattice);
  const out: [number, number][] = [points[0]];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const ts: number[] = [];
    for (const axis of [0, 1] as const) {
      const a = axis === 0 ? ax : -ay;
      const b = axis === 0 ? bx : -by;
      if (a === b) continue;
      const [first, last] = linesBetween(Math.min(a, b), Math.max(a, b), lattice);
      for (let k = first; k <= last; k++) ts.push((line(k) - a) / (b - a));
    }
    ts.sort((p, q) => p - q);
    for (const t of ts) {
      if (t > 0 && t < 1) out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
    out.push([bx, by]);
  }
  return out;
}
