/**
 * Building footprints → a bevelled, occlusion-baked triangle mesh, for one tile.
 *
 * Runs inside the mesh Web Worker (`meshWorker.ts`) and nowhere else at
 * runtime; it is a separate module so that it is pure, imports no renderer and
 * no map engine, and can be tested on its own (`__tests__/city3dMesher.test.ts`).
 *
 * ## What one building becomes
 *
 * ```
 *        Q_i ________ Q_i+1        roof, at `top`, on the INSET ring Q
 *          /          \            bevel strip: P (at top − b) → Q (at top)
 *    P_i  /____________\  P_i+1    wall top, at `top − b`
 *        |              |
 *        |     wall     |          walls, base → top − b, on the footprint P
 *        |______________|
 * ```
 *
 * `b` is the bevel: the roof is the footprint moved INWARD by `b` and lifted to
 * `top`, and the walls stop `b` short of it, so the roof line is a 45° chamfer
 * rather than a hard edge. That chamfer is what `fill-extrusion` cannot draw
 * and what makes a building read as an object instead of a cut-out: it catches
 * the light differently from both the roof and the wall, so every roof line
 * gets a highlight or a shadow of its own.
 *
 * ## The rules the input forces on us (measured, see `buildings3d.ts`)
 *
 *  - Heights are normalised exactly as the `fill-extrusion` layer normalises
 *    them ({@link buildingSpan}): `render_height` floored at 3 m, a
 *    `render_min_height` at or above the roof dropped to the ground, `hide_3d`
 *    honoured. The two renderers must agree about the city's shape; only the
 *    shading is allowed to differ.
 *  - OpenMapTiles unions touching footprints at z14, so one "building" can be
 *    an Eixample block with a courtyard, or a multipolygon of thousands of
 *    rings. Nothing is assumed about ring count.
 *  - Features cross tile edges and are clipped there (with a buffer). Walls
 *    and bevels along a CLIP line would be fake walls in the middle of a
 *    building, so the mesher clips every ring to the tile square itself and
 *    marks edges that lie on the square's boundary as **cut**: no wall, no
 *    bevel, and the inset leaves them in place. The neighbouring tile draws
 *    the other half and the two roofs meet flush.
 *
 * ## Orientation
 *
 * The vector-tile spec defines an exterior ring as one with POSITIVE area in
 * tile coordinates (`y` down), which draws clockwise on a north-up map.
 * Negating `y` into ENU does not change the picture, so an exterior is still
 * clockwise there — negative area. {@link polygonsOf} therefore REVERSES every
 * ring on the way in: exteriors become counter-clockwise (positive) and
 * courtyards clockwise. Walked that way the SOLID is always on the left, which
 * is the one fact the inset, the outward wall normal and the corner-concavity
 * test all rely on — for exteriors and courtyards alike, with no special case.
 * (The first version of this file skipped the reversal and dropped 1,465 of a
 * Manhattan tile's 1,488 buildings as "holes with no exterior".)
 *
 * ## Honesty
 *
 * Everything this emits is a function of the footprint and its two heights.
 * No windows, no floors, no storefronts: a facade texture would claim detail
 * the data does not hold (the tiles carry no `building:levels`, no roof shape,
 * no use). See `docs/MAP_3D_CITY.md` → "Honesty".
 */
import earcut from 'earcut';

import { concavity, cornerOcclusion, AO } from './occlusion';

/** Mesh tuning, in metres unless stated. */
export const MESH = {
  /** Same floor as `buildings3d.ts`'s `MIN_HEIGHT_M`: every prism is a real volume. */
  minHeightM: 3,
  /** The chamfer's width (and rise) when nothing constrains it. */
  bevelM: 0.7,
  /** The chamfer may use at most this fraction of the building's own height. */
  bevelHeightFraction: 0.2,
  /** …and at most this fraction of its characteristic width (2·area / perimeter). */
  bevelWidthFraction: 0.35,
  /** An inset corner may move at most this many bevel widths (a mitre limit). */
  miterLimit: 2.5,
  /** Rings smaller than this many m² are dropped (slivers left by clipping). */
  minRingAreaM2: 1,
  /** Tone is the building height in metres, saturating here (one byte). */
  toneMaxM: 255,
} as const;

/** A point as `[x, y]`. */
export type Point2 = readonly [number, number];

/** One feature from the `building` source-layer, as decoded from the tile. */
export interface BuildingFeature {
  /** Every ring, in TILE UNITS as stored (y down), exteriors and holes interleaved. */
  rings: readonly (readonly Point2[])[];
  /** Raw tile properties; untrusted. */
  properties: {
    render_height?: unknown;
    render_min_height?: unknown;
    hide_3d?: unknown;
  };
}

export interface MeshTileOptions {
  /** Tile extent in tile units (4096 for GoWay's tiles). */
  extent: number;
  /** The tile's side in metres (`tileSizeMetres`). */
  tileSizeMetres: number;
}

/**
 * A finished tile mesh, ready to transfer out of the worker.
 *
 * - `positions`: local ENU metres (x east, y north, z up), 3 per vertex.
 * - `normals`: unit normals ×127, 3 per vertex.
 * - `shade`: per vertex `[cornerAo × 255, tone]`; tone is the building's
 *   height in metres (0–255), which the shader turns into the height ramp.
 * - `indices`: triangles, counter-clockwise seen from outside in ENU.
 */
export interface TileMesh {
  positions: Float32Array;
  normals: Int8Array;
  shade: Uint8Array;
  indices: Uint32Array;
  /** Axis-aligned bounds of `positions`, for the renderer's culling. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** How many polygons (after splitting multipolygons) produced geometry. */
  polygons: number;
  /**
   * The first vertex of each unit placed on terrain (`terrainGround.ts`) —
   * here each polygon, in `osmMesher.ts` each building; a unit's vertices are
   * contiguous and run to the next one's start.
   */
  polygonStarts: Uint32Array;
  /** Each unit's footprint box in local metres: `minX, minY, maxX, maxY`. */
  polygonBoxes: Float32Array;
}

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A feature's vertical span, or `null` when it must not be extruded.
 *
 * Mirrors `HEIGHT`, `BASE` and `NOT_HIDDEN` in `buildings3d.ts` — see there for
 * the measured tiles that make each rule necessary.
 */
export function buildingSpan(
  properties: BuildingFeature['properties'],
): { base: number; top: number } | null {
  if (properties.hide_3d === true) return null;
  const top = Math.max(finite(properties.render_height) ?? 0, MESH.minHeightM);
  const min = finite(properties.render_min_height) ?? 0;
  const base = min >= top ? 0 : Math.max(0, min);
  return { base, top };
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

/** A ring in local metres plus, per edge `i → i+1`, whether it lies on the tile boundary. */
export interface Ring {
  points: Point2[];
  cut: boolean[];
}

/** Twice the signed area (shoelace); positive is counter-clockwise in a y-up frame. */
export function signedArea(points: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Drop the closing duplicate and any consecutive repeats. */
function dedupe(points: readonly Point2[]): Point2[] {
  const out: Point2[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  while (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  ) {
    out.pop();
  }
  return out;
}

/**
 * Clip a ring to the square `[0, extent]²` (Sutherland–Hodgman), in tile units.
 *
 * Sutherland–Hodgman is exact for a convex clip window, keeps the ring's
 * orientation, and on a concave ring produces zero-width "bridges" along the
 * boundary — which is harmless here precisely because every edge on the
 * boundary is marked cut and draws nothing.
 */
export function clipRingToTile(points: readonly Point2[], extent: number): Point2[] {
  type Edge = { inside: (p: Point2) => boolean; cross: (a: Point2, b: Point2) => Point2 };
  const at = (a: Point2, b: Point2, t: number): Point2 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const edges: Edge[] = [
    { inside: (p) => p[0] >= 0, cross: (a, b) => [0, at(a, b, a[0] / (a[0] - b[0]))[1]] },
    {
      inside: (p) => p[0] <= extent,
      cross: (a, b) => [extent, at(a, b, (extent - a[0]) / (b[0] - a[0]))[1]],
    },
    { inside: (p) => p[1] >= 0, cross: (a, b) => [at(a, b, a[1] / (a[1] - b[1]))[0], 0] },
    {
      inside: (p) => p[1] <= extent,
      cross: (a, b) => [at(a, b, (extent - a[1]) / (b[1] - a[1]))[0], extent],
    },
  ];
  let output: Point2[] = dedupe(points);
  for (const edge of edges) {
    if (output.length === 0) break;
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentIn = edge.inside(current);
      const previousIn = edge.inside(previous);
      if (currentIn) {
        if (!previousIn) output.push(edge.cross(previous, current));
        output.push(current);
      } else if (previousIn) {
        output.push(edge.cross(previous, current));
      }
    }
  }
  return dedupe(output);
}

/** Whether the edge `a → b` lies along one side of the tile square. */
export function isCutEdge(a: Point2, b: Point2, extent: number): boolean {
  return (
    (a[0] === 0 && b[0] === 0) ||
    (a[0] === extent && b[0] === extent) ||
    (a[1] === 0 && b[1] === 0) ||
    (a[1] === extent && b[1] === extent)
  );
}

/**
 * Clip, convert to local metres, and group into polygons (exterior + holes).
 *
 * Grouping follows the vector-tile rule: an exterior (positive area once
 * reversed into ENU) opens a polygon, and the holes that follow it are its
 * courtyards. A hole with no open
 * polygon, a ring under {@link MESH.minRingAreaM2} and a ring with fewer than
 * three points are dropped.
 */
export function polygonsOf(
  rings: readonly (readonly Point2[])[],
  { extent, tileSizeMetres }: MeshTileOptions,
): Ring[][] {
  const scale = tileSizeMetres / extent;
  const polygons: Ring[][] = [];
  let current: Ring[] | null = null;
  for (const raw of rings) {
    // Reversed: see "Orientation" in the module header.
    const clipped = clipRingToTile(raw, extent).reverse();
    if (clipped.length < 3) continue;
    const cut = clipped.map((point, i) =>
      isCutEdge(point, clipped[(i + 1) % clipped.length], extent),
    );
    const points = clipped.map(([x, y]): Point2 => [x * scale, -y * scale]);
    const area = signedArea(points);
    if (Math.abs(area) < MESH.minRingAreaM2) continue;
    if (area > 0) {
      current = [{ points, cut }];
      polygons.push(current);
    } else if (current) {
      current.push({ points, cut });
    }
  }
  return polygons;
}

// ---------------------------------------------------------------------------
// Bevel
// ---------------------------------------------------------------------------

/**
 * The bevel width for one polygon: {@link MESH.bevelM}, cut down for short
 * buildings and for narrow ones.
 *
 * "Narrow" is measured as `2·area / perimeter`, which is the width of a long
 * thin rectangle and half the side of a square — a cheap stand-in for the
 * polygon's inradius that needs no medial axis. A bevel wider than about a
 * third of that would let opposite insets meet.
 */
export function bevelWidth(polygon: readonly Ring[], height: number): number {
  let area = 0;
  let perimeter = 0;
  for (const ring of polygon) {
    area += signedArea(ring.points);
    const n = ring.points.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = ring.points[i];
      const [x2, y2] = ring.points[(i + 1) % n];
      perimeter += Math.hypot(x2 - x1, y2 - y1);
    }
  }
  if (perimeter <= 0 || area <= 0) return 0;
  const width = (2 * area) / perimeter;
  return Math.max(
    0,
    Math.min(MESH.bevelM, MESH.bevelHeightFraction * height, MESH.bevelWidthFraction * width),
  );
}

/** Left-hand unit normal of `a → b` — pointing INTO the solid. */
function leftNormal(a: Point2, b: Point2): Point2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return length === 0 ? [0, 0] : [-dy / length, dx / length];
}

/**
 * The ring moved into the solid: each edge by its own distance (`width`, or 0
 * for a cut edge), each corner to where its two offset edges meet.
 *
 * The meeting point solves `q·nPrev = dPrev` and `q·nNext = dNext` for the
 * corner's offset `q`. Near-collinear edges have no stable intersection and
 * take the average normal instead; a corner that would move more than
 * {@link MESH.miterLimit} widths (a needle-sharp angle) is pulled back to that.
 */
export function insetRing(ring: Ring, width: number): Point2[] {
  const { points, cut } = ring;
  const n = points.length;
  const out: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n];
    const here = points[i];
    const next = points[(i + 1) % n];
    const dPrev = cut[(i + n - 1) % n] ? 0 : width;
    const dNext = cut[i] ? 0 : width;
    const np = leftNormal(prev, here);
    const nn = leftNormal(here, next);
    const det = np[0] * nn[1] - np[1] * nn[0];
    let qx: number;
    let qy: number;
    if (Math.abs(det) < 1e-3) {
      const same = np[0] * nn[0] + np[1] * nn[1] > 0;
      const d = same ? (dPrev + dNext) / 2 : 0;
      qx = np[0] * d;
      qy = np[1] * d;
    } else {
      qx = (dPrev * nn[1] - dNext * np[1]) / det;
      qy = (np[0] * dNext - nn[0] * dPrev) / det;
    }
    const limit = MESH.miterLimit * Math.max(dPrev, dNext);
    const length = Math.hypot(qx, qy);
    if (length > limit && length > 0) {
      qx *= limit / length;
      qy *= limit / length;
    }
    out.push([here[0] + qx, here[1] + qy]);
  }
  return out;
}

/**
 * Whether an inset kept the ring's shape: every edge still points the way it
 * did. An edge that reverses is where the inset folded over itself (a corridor
 * narrower than two bevels), and drawing that would put a roof inside out.
 */
export function insetIsValid(original: readonly Point2[], inset: readonly Point2[]): boolean {
  const n = original.length;
  for (let i = 0; i < n; i++) {
    const a = original[i];
    const b = original[(i + 1) % n];
    const p = inset[i];
    const q = inset[(i + 1) % n];
    const dot = (b[0] - a[0]) * (q[0] - p[0]) + (b[1] - a[1]) * (q[1] - p[1]);
    if (dot <= 0 && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) return false;
  }
  return true;
}

/** The signed turn at `here`, in radians: positive left (convex for a solid-on-left ring). */
export function turnAngle(prev: Point2, here: Point2, next: Point2): number {
  const ax = here[0] - prev[0];
  const ay = here[1] - prev[1];
  const bx = next[0] - here[0];
  const by = next[1] - here[1];
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/**
 * The positions along a wall of length `length` where vertices go: its two
 * ends, plus the corner-occlusion reach from each end that is concave — so the
 * darkening fades out at {@link AO.cornerReachM} instead of across the wall.
 */
export function wallColumns(length: number, startConcave: boolean, endConcave: boolean): number[] {
  const columns = [0, length];
  if (startConcave && AO.cornerReachM < length) columns.push(AO.cornerReachM);
  if (endConcave && length - AO.cornerReachM > 0) columns.push(length - AO.cornerReachM);
  columns.sort((a, b) => a - b);
  return columns.filter((value, i) => i === 0 || value - columns[i - 1] > 1e-3);
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/** Growable typed buffers; a z14 tile in a dense city is ~10⁶ vertices. */
class MeshBuilder {
  private positions = new Float32Array(3 * 4096);
  private normals = new Int8Array(3 * 4096);
  private shade = new Uint8Array(2 * 4096);
  private indices = new Uint32Array(6 * 4096);
  private vertexCount = 0;
  private indexCount = 0;
  private readonly polygonStarts: number[] = [];
  private readonly polygonBoxes: number[] = [];
  readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  vertex(
    x: number,
    y: number,
    z: number,
    normal: readonly number[],
    ao: number,
    tone: number,
  ): number {
    if (this.vertexCount * 3 + 3 > this.positions.length) {
      // `shade` holds 2 per vertex to the others' 3, so it never fills first.
      this.positions = grow(this.positions);
      this.normals = grow(this.normals);
      this.shade = grow(this.shade);
    }
    const v = this.vertexCount++;
    // Element writes, not `.set([...])`: this runs ~10⁶ times per dense tile,
    // and a throwaway array per call is most of the cost.
    const p = v * 3;
    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;
    this.normals[p] = Math.round(normal[0] * 127);
    this.normals[p + 1] = Math.round(normal[1] * 127);
    this.normals[p + 2] = Math.round(normal[2] * 127);
    this.shade[v * 2] = Math.round(Math.max(0, Math.min(1, ao)) * 255);
    this.shade[v * 2 + 1] = tone;
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
    return v;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.indices.length) this.indices = grow(this.indices);
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  /** A quad from two bottom and two top vertices, counter-clockwise seen from its front. */
  quad(b0: number, b1: number, t1: number, t0: number): void {
    this.triangle(b0, b1, t1);
    this.triangle(b0, t1, t0);
  }

  /** Vertices emitted so far: where the next polygon starts. */
  get vertices(): number {
    return this.vertexCount;
  }

  /** Record a polygon that drew, from its first vertex, with its footprint's box. */
  polygon(start: number, footprint: readonly Point2[]): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of footprint) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    this.polygonStarts.push(start);
    this.polygonBoxes.push(minX, minY, maxX, maxY);
  }

  finish(polygons: number): TileMesh | null {
    if (this.indexCount === 0) return null;
    return {
      positions: this.positions.slice(0, this.vertexCount * 3),
      normals: this.normals.slice(0, this.vertexCount * 3),
      shade: this.shade.slice(0, this.vertexCount * 2),
      indices: this.indices.slice(0, this.indexCount),
      bounds: { min: [...this.min], max: [...this.max] },
      polygons,
      polygonStarts: Uint32Array.from(this.polygonStarts),
      polygonBoxes: Float32Array.from(this.polygonBoxes),
    };
  }
}

function grow<T extends Float32Array | Int8Array | Uint8Array | Uint32Array>(array: T): T {
  const next = new (array.constructor as new (length: number) => T)(array.length * 2);
  next.set(array);
  return next;
}

const UP = [0, 0, 1] as const;

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

// ---------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------

/** Mesh one polygon (exterior + holes) into `builder`. Returns whether it drew anything. */
function meshPolygon(
  builder: MeshBuilder,
  polygon: readonly Ring[],
  base: number,
  top: number,
  tone: number,
): boolean {
  // Try the full bevel, then half of it, then none. An inset that folds over
  // itself is drawn as a plain prism rather than a broken bevelled one.
  // Measured on real z14 tiles: the full width folds on 5.5% of Barcelona's
  // 15,501 polygons and 2.2% of a Manhattan tile's 4,405 — almost all of them
  // short zig-zag edges left by tile simplification. The half-width retry
  // rescues all but 143 (0.9%) and 21 (0.5%) of them.
  const full = bevelWidth(polygon, top - base);
  let bevel = 0;
  let insets = polygon.map((ring) => ring.points.slice());
  for (const candidate of [full, full / 2]) {
    if (candidate <= 0) break;
    const tried = polygon.map((ring) => insetRing(ring, candidate));
    if (polygon.every((ring, i) => insetIsValid(ring.points, tried[i]))) {
      bevel = candidate;
      insets = tried;
      break;
    }
  }
  const wallTop = top - bevel;

  polygon.forEach((ring, r) => {
    const { points, cut } = ring;
    const inset = insets[r];
    const n = points.length;
    // Concavity per vertex; a vertex on a cut edge borders the tile boundary,
    // not a real corner, and is never occluded.
    const concave = points.map((here, i) =>
      cut[i] || cut[(i + n - 1) % n]
        ? 0
        : concavity(turnAngle(points[(i + n - 1) % n], here, points[(i + 1) % n])),
    );

    for (let i = 0; i < n; i++) {
      if (cut[i]) continue;
      const a = points[i];
      const b = points[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      const ux = dx / length;
      const uy = dy / length;
      // Outward = right of the direction of travel, since the solid is on the left.
      const outward = [uy, -ux, 0];

      // Wall, split into columns at the corner-occlusion reach.
      const cA = concave[i];
      const cB = concave[(i + 1) % n];
      const columns = wallColumns(length, cA > 0, cB > 0);
      let previous: [number, number] | null = null;
      for (const s of columns) {
        const ao = Math.min(cornerOcclusion(cA, s), cornerOcclusion(cB, length - s));
        const x = a[0] + ux * s;
        const y = a[1] + uy * s;
        const bottom = builder.vertex(x, y, base, outward, ao, tone);
        const upper = builder.vertex(x, y, wallTop, outward, ao, tone);
        if (previous) builder.quad(previous[0], bottom, upper, previous[1]);
        previous = [bottom, upper];
      }

      // Bevel strip: wall top on the footprint → roof edge on the inset.
      if (bevel > 0) {
        const qa = inset[i];
        const qb = inset[(i + 1) % n];
        const mx = (qa[0] + qb[0]) / 2 - (a[0] + b[0]) / 2;
        const my = (qa[1] + qb[1]) / 2 - (a[1] + b[1]) / 2;
        // cross(edge, rise) where rise = (mx, my, bevel): outward and up.
        const normal = normalize3(uy * bevel, -ux * bevel, ux * my - uy * mx);
        const p0 = builder.vertex(a[0], a[1], wallTop, normal, 1, tone);
        const p1 = builder.vertex(b[0], b[1], wallTop, normal, 1, tone);
        const q1 = builder.vertex(qb[0], qb[1], top, normal, 1, tone);
        const q0 = builder.vertex(qa[0], qa[1], top, normal, 1, tone);
        builder.quad(p0, p1, q1, q0);
      }
    }
  });

  // Roof: the inset rings, triangulated, facing up.
  const flat: number[] = [];
  const holes: number[] = [];
  insets.forEach((ring, r) => {
    if (r > 0) holes.push(flat.length / 2);
    for (const [x, y] of ring) flat.push(x, y);
  });
  const triangles = earcut(flat, holes.length > 0 ? holes : null, 2);
  if (triangles.length === 0) return true;
  const first = builder.vertex(flat[0], flat[1], top, UP, 1, tone);
  for (let i = 2; i < flat.length; i += 2) builder.vertex(flat[i], flat[i + 1], top, UP, 1, tone);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    // earcut does not promise a winding; make every roof triangle face up.
    const ccw =
      (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) -
        (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]) >=
      0;
    if (ccw) builder.triangle(first + a, first + b, first + c);
    else builder.triangle(first + a, first + c, first + b);
  }
  return true;
}

/**
 * Mesh every building of one tile. `null` when the tile has nothing to draw.
 */
export function meshBuildings(
  features: readonly BuildingFeature[],
  options: MeshTileOptions,
): TileMesh | null {
  const builder = new MeshBuilder();
  let polygons = 0;
  for (const feature of features) {
    const span = buildingSpan(feature.properties);
    if (!span) continue;
    const rawHeight = finite(feature.properties.render_height) ?? 0;
    const tone = Math.round(Math.max(0, Math.min(MESH.toneMaxM, rawHeight)));
    for (const polygon of polygonsOf(feature.rings, options)) {
      const start = builder.vertices;
      if (meshPolygon(builder, polygon, span.base, span.top, tone)) {
        polygons++;
        builder.polygon(start, polygon[0].points);
      }
    }
  }
  return builder.finish(polygons);
}
