/**
 * The street geometry cut to the TERRAIN's own facets, so every street
 * triangle lies flat on the flat triangle of terrain it is drawn on
 * (`docs/MAP_STREETS.md` → Terrain and depth).
 *
 * MapLibre draws the terrain as a mesh of flat triangles, 128 squares a
 * terrain tile, each vertex the DEM read bilinearly between pixel centres
 * (`get_elevation`). The street stands on that mesh as MapLibre draws it on
 * the z15 terrain tile that is the street tile itself (`terrainGround.ts` →
 * `facetAt`). A GPU draws a street triangle flat between its vertices, so one
 * that spans a fold of that ground cuts under a ridge or floats over a valley
 * — a junction polygon is 30 m of asphalt with no vertex inside it. And the
 * street is several layers (asphalt, paint, words) of DIFFERENT triangles: over
 * a curved ground their flat pieces part, and the asphalt rose through the
 * paint (measured on Balmes: 8% of the paint under the asphalt, by up to 12 cm,
 * with every vertex on the bilinear DEM). Cut along the mesh's lines and
 * diagonals, every piece of every layer lies inside one facet, ON it: the
 * layers share one plane there, and the terrain is that plane.
 *
 * Pure and dependency-free: runs in the street worker, after the mesher has
 * laid everything out, on the builder's plain arrays (`meshBuffers.ts`).
 */
import type { Buffers } from './meshBuffers';

/**
 * MapLibre's terrain mesh over one street tile, in the tile's local metres (x
 * east from its west edge, y NORTH from its north edge, so ≤ 0 inside it):
 * `cells` squares a side (its `Terrain.meshSize`, 128, on the z15 terrain tile
 * that is this very tile), lines at `k · sizeM / cells` east and south of the
 * north-west corner, each square split from its north-west corner to its
 * south-east one.
 */
export interface StreetLattice {
  /** Mesh cells across the tile (`terrainGround.ts` → `GroundLattice.meshCells`). */
  cells: number;
  /** The tile's side, metres (the mesher's own frame). */
  sizeM: number;
}

/** Along x (east) when 0, along −y (south) when 1: both run with the mesh's own index. */
type Axis = 0 | 1;

/** Metres east (or south) → mesh coordinate: an integer on each mesh line. */
function latticeOf(lattice: StreetLattice): (c: number) => number {
  const step = lattice.sizeM / lattice.cells;
  return (c) => c / step;
}

/** Metres of mesh line `k`. */
function lineAt(lattice: StreetLattice): (k: number) => number {
  const step = lattice.sizeM / lattice.cells;
  return (k) => k * step;
}

/** The mesh lines strictly between mesh coordinates `lo` and `hi`, as `[first, last]`. */
function linesBetween(lo: number, hi: number): [number, number] {
  return [Math.floor(lo) + 1, Math.ceil(hi) - 1];
}

/**
 * Split every triangle of `buffers` that crosses a lattice line or a square's
 * diagonal into pieces that do not, in place: new vertices are appended
 * (positions, offsets and uvs interpolated; the byte attributes are the
 * primitive's own, taken from an end of the cut edge), and the index list is
 * rewritten in order, so the levels' ranges stay where they were.
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
  const toLattice = latticeOf(lattice);
  const line = lineAt(lattice);
  const { positions, offsets, uvs, attrs } = buffers;
  const withOffsets = offsets.length > 0;
  const withUvs = uvs.length > 0;
  /** A vertex's lattice coordinate along an axis. */
  const coord = (v: number, axis: Axis) =>
    toLattice(axis === 0 ? positions[v * 3] : -positions[v * 3 + 1]);
  const cuts = new Map<string, number>();

  /** The vertex where edge p–q crosses zero of `side` (a cut cached under `key`). */
  const cut = (
    p: number,
    q: number,
    key: string,
    side: (v: number) => number,
    snap?: (v: number) => void,
  ): number => {
    const lo = Math.min(p, q);
    const hi = Math.max(p, q);
    const k = `${lo}:${hi}:${key}`;
    const known = cuts.get(k);
    if (known !== undefined) return known;
    const a = side(lo);
    const b = side(hi);
    const t = a / (a - b);
    let v: number;
    // A crossing at (or a rounding error from) an end is that end: a line
    // through a lattice corner already cut there makes no second vertex.
    if (!(t > 1e-9)) v = lo;
    else if (!(t < 1 - 1e-9)) v = hi;
    else {
      v = positions.length / 3;
      for (let c = 0; c < 3; c++) {
        positions.push(positions[lo * 3 + c] + (positions[hi * 3 + c] - positions[lo * 3 + c]) * t);
      }
      snap?.(v);
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
    cuts.set(k, v);
    return v;
  };

  /** Split a convex polygon where `side` changes sign: the part below zero, and the part at or above it. */
  const slice = (
    poly: number[],
    key: string,
    side: (v: number) => number,
    snap?: (v: number) => void,
  ): [number[], number[]] => {
    const before: number[] = [];
    const after: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const pBefore = side(p) < 0;
      const qBefore = side(q) < 0;
      (pBefore ? before : after).push(p);
      if (pBefore !== qBefore) {
        const m = cut(p, q, key, side, snap);
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
    // The lattice lines, one axis then the other.
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
        const [first, last] = linesBetween(lo, hi);
        let rest = poly;
        for (let k = first; k <= last; k++) {
          const [before, after] = slice(
            rest,
            `${axis}:${k}`,
            (v) => coord(v, axis) - k,
            // The cut lies exactly on the line, whatever the rounding did.
            (v) => {
              if (axis === 0) positions[v * 3] = line(k);
              else positions[v * 3 + 1] = -line(k);
            },
          );
          if (before.length >= 3) next.push(before);
          rest = after;
        }
        if (rest.length >= 3) next.push(rest);
      }
      pieces = next;
    }
    // Then each square's diagonal, north-west to south-east (east − south = 0).
    const next: number[][] = [];
    for (const poly of pieces) {
      let cx = 0;
      let cs = 0;
      for (const v of poly) {
        cx += coord(v, 0);
        cs += coord(v, 1);
      }
      const kx = Math.floor(cx / poly.length);
      const ks = Math.floor(cs / poly.length);
      const side = (v: number) => coord(v, 0) - kx - (coord(v, 1) - ks);
      let crosses = false;
      let sign = 0;
      for (const v of poly) {
        const s = Math.sign(side(v));
        if (s !== 0 && sign !== 0 && s !== sign) crosses = true;
        if (s !== 0) sign = s;
      }
      if (!crosses) {
        next.push(poly);
        continue;
      }
      const [before, after] = slice(poly, `d:${kx}:${ks}`, side);
      if (before.length >= 3) next.push(before);
      if (after.length >= 3) next.push(after);
    }
    pieces = next;
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
 * A polyline with a point added wherever it crosses a lattice line or a
 * square's diagonal — what a painted line needs to lie on the ground's facets
 * (its vertices are centre points; see {@link splitToLattice}). The added
 * points lie on the original segments, so the line's mitred normals do not
 * change.
 */
export function densifyToLattice(
  points: readonly [number, number][],
  lattice: StreetLattice,
): [number, number][] {
  if (!(lattice.sizeM / lattice.cells > 0) || points.length < 2) return points.slice();
  const toLattice = latticeOf(lattice);
  const out: [number, number][] = [points[0]];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const la = [toLattice(ax), toLattice(-ay)];
    const lb = [toLattice(bx), toLattice(-by)];
    const ts: number[] = [];
    for (const axis of [0, 1] as const) {
      const a = la[axis];
      const b = lb[axis];
      if (a === b) continue;
      const [first, last] = linesBetween(Math.min(a, b), Math.max(a, b));
      for (let k = first; k <= last; k++) ts.push((k - a) / (b - a));
    }
    ts.sort((p, q) => p - q);
    // Between consecutive crossings the segment is inside one square: add
    // where it crosses that square's diagonal.
    const bounds = [0, ...ts.filter((t) => t > 0 && t < 1), 1];
    const all: number[] = [];
    for (let j = 0; j + 1 < bounds.length; j++) {
      const t0 = bounds[j];
      const t1 = bounds[j + 1];
      const tm = (t0 + t1) / 2;
      const kx = Math.floor(la[0] + (lb[0] - la[0]) * tm);
      const ks = Math.floor(la[1] + (lb[1] - la[1]) * tm);
      const side = (t: number) =>
        la[0] + (lb[0] - la[0]) * t - kx - (la[1] + (lb[1] - la[1]) * t - ks);
      const s0 = side(t0);
      const s1 = side(t1);
      if (t0 > 0) all.push(t0);
      if ((s0 < 0 && s1 > 0) || (s0 > 0 && s1 < 0)) all.push(t0 + ((t1 - t0) * s0) / (s0 - s1));
    }
    for (const t of all) out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    out.push([bx, by]);
  }
  return out;
}
