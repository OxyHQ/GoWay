/**
 * Roof shapes from `roof:shape`, as geometry: the frame a roof is laid out in,
 * and the height of its surface over the footprint.
 *
 * Pure, renderer-free and shared by two programs: the city-tile COMPILER
 * (`scripts/build-city-tiles.ts`), which measures a roof's frame on the whole
 * footprint to size a roof whose height OSM does not record, and the mesh
 * WORKER (`osmMesher.ts`), which builds the roof. Tested in
 * `__tests__/city3dRoofs.test.ts`.
 *
 * ## One idea covers most shapes: the roof is the LOWEST of a few planes
 *
 * Every roof in Simple 3D Buildings that has straight slopes and no valley —
 * skillion, gabled, saltbox, hipped, half-hipped, pyramidal, gambrel, mansard —
 * is a CONCAVE height field over the footprint, and a concave piecewise-linear
 * function is exactly the minimum of its planes. A gabled roof is
 * `min(left slope, right slope)`; hipped adds the two end slopes; a gambrel is
 * two planes per side, steep below and shallow above. `round` (a barrel vault)
 * is concave too, and is the minimum of its tangent planes.
 *
 * That gives one mesher for all of them, with no straight skeleton:
 *
 *  - **Walls** rise to the roof along every edge, so gable ends, skillion
 *    high walls and a courtyard's inner walls come for free. An edge's top is
 *    piecewise linear; {@link edgeBreaks} finds where it bends.
 *  - **Roof faces**: plane `i` is the roof wherever it is the lowest, which is
 *    a convex set (the intersection of the half-planes `plane_i <= plane_j`),
 *    so its patch is the footprint clipped by those half-planes
 *    ({@link clipRingByLine}) and triangulated.
 *
 * The planes are laid out in a {@link RoofFrame}: the footprint's
 * minimum-area bounding rectangle (OSM2World and F4Map do the same), with the
 * ridge along its longer side unless `roof:orientation=across`, or
 * perpendicular to `roof:direction` when that is tagged. So an L-shaped house
 * tagged `gabled` gets ONE ridge across its bounding rectangle, not two
 * meeting at a valley — the known limit of this approach, recorded in the doc.
 *
 * `dome`, `onion` and `cone` are not planar and are built by the mesher as
 * surfaces of revolution about the footprint's centroid, from
 * {@link revolutionProfile}.
 *
 * All coordinates here are local metres with `y` north (ENU), the frame the
 * mesher works in; the compiler converts to the same frame before asking.
 */
import type { RoofShape } from '@/lib/map/cityTiles';

import type { Point2 } from './mesher';

/** A roof's layout: centre, ridge axis `u` (unit), and half-extents along `u` and across it. */
export interface RoofFrame {
  cx: number;
  cy: number;
  /** Unit vector along the ridge. `v` (across) is its left perpendicular, `(-uy, ux)`. */
  ux: number;
  uy: number;
  /** Half the frame's extent along the ridge. */
  halfLength: number;
  /** Half the frame's extent across it. */
  halfWidth: number;
}

/** `z = a·x + b·y + c`, metres above the eaves. */
export interface Plane {
  a: number;
  b: number;
  c: number;
}

export const planeAt = (plane: Plane, x: number, y: number): number =>
  plane.a * x + plane.b * y + plane.c;

/** The convex hull (Andrew's monotone chain), counter-clockwise. */
export function convexHull(points: readonly Point2[]): Point2[] {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point2, a: Point2, b: Point2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** The bounding rectangle of `points` in the frame whose ridge axis is `(ux, uy)`. */
function frameAlong(points: readonly Point2[], ux: number, uy: number): RoofFrame {
  const vx = -uy;
  const vy = ux;
  let sMin = Infinity;
  let sMax = -Infinity;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const [x, y] of points) {
    const s = x * ux + y * uy;
    const t = x * vx + y * vy;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const sMid = (sMin + sMax) / 2;
  const tMid = (tMin + tMax) / 2;
  return {
    cx: sMid * ux + tMid * vx,
    cy: sMid * uy + tMid * vy,
    ux,
    uy,
    halfLength: (sMax - sMin) / 2,
    halfWidth: (tMax - tMin) / 2,
  };
}

export interface RoofFrameOptions {
  /** `roof:direction`: compass bearing the slope faces (downhill). Overrides the rest. */
  direction?: number;
  /** `roof:orientation=across`: the ridge runs along the SHORTER side. */
  across?: boolean;
}

/**
 * The frame a roof is laid out in, from its footprint's exterior ring(s).
 * `null` for a footprint with no area.
 *
 * With `direction`, the slope faces that bearing, so `v` (across the ridge)
 * points along it and the ridge is perpendicular. Without it, the frame is the
 * minimum-area bounding rectangle (rotating calipers over the hull), ridge
 * along the longer side — or the shorter with `across`.
 */
export function roofFrame(
  exterior: readonly Point2[],
  options: RoofFrameOptions = {},
): RoofFrame | null {
  const hull = convexHull(exterior);
  if (hull.length < 3) return null;
  if (options.direction !== undefined && Number.isFinite(options.direction)) {
    const radians = (options.direction * Math.PI) / 180;
    // Bearing → ENU unit vector (x east, y north); `v = (-uy, ux)` must equal it.
    const dx = Math.sin(radians);
    const dy = Math.cos(radians);
    const frame = frameAlong(hull, dy, -dx);
    return frame.halfWidth > 0 && frame.halfLength > 0 ? frame : null;
  }
  let best: RoofFrame | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) continue;
    const frame = frameAlong(hull, (b[0] - a[0]) / length, (b[1] - a[1]) / length);
    const area = frame.halfLength * frame.halfWidth;
    if (area < bestArea - 1e-9) {
      bestArea = area;
      best = frame;
    }
  }
  if (!best || best.halfWidth <= 0 || best.halfLength <= 0) return null;
  // The ridge runs along the longer side (or the shorter, `across`).
  const swap = options.across ? best.halfLength > best.halfWidth : best.halfLength < best.halfWidth;
  if (swap) {
    best = {
      cx: best.cx,
      cy: best.cy,
      ux: -best.uy,
      uy: best.ux,
      halfLength: best.halfWidth,
      halfWidth: best.halfLength,
    };
  }
  return best;
}

/** A plane given in the frame's own coordinates, `z = α·s + β·t + γ`, converted to `x, y`. */
function framePlane(frame: RoofFrame, alpha: number, beta: number, gamma: number): Plane {
  const { cx, cy, ux, uy } = frame;
  const vx = -uy;
  const vy = ux;
  // s = (x − cx)·u, t = (x − cx)·v.
  const a = alpha * ux + beta * vx;
  const b = alpha * uy + beta * vy;
  return { a, b, c: gamma - a * cx - b * cy };
}

/** Shapes {@link roofPlanes} builds; the rest are revolution surfaces or flat. */
export const PLANAR_ROOF_SHAPES: ReadonlySet<RoofShape> = new Set([
  'skillion',
  'gabled',
  'saltbox',
  'hipped',
  'half-hipped',
  'pyramidal',
  'gambrel',
  'mansard',
  'round',
]);

/** Tangent points (as a fraction of the half-width) of a barrel vault's facets. */
const ROUND_TANGENTS = [0, 0.35, 0.6, 0.78, 0.9, 0.97];

/**
 * The planes whose minimum is the roof, `height` metres tall over its eaves.
 * Empty for a shape that is not planar (see {@link PLANAR_ROOF_SHAPES}).
 */
export function roofPlanes(shape: RoofShape, frame: RoofFrame, height: number): Plane[] {
  const H = height;
  const W = frame.halfWidth;
  const L = frame.halfLength;
  const p = (alpha: number, beta: number, gamma: number) => framePlane(frame, alpha, beta, gamma);
  const sides = (slope: number) => [p(0, -slope, H), p(0, slope, H)];
  switch (shape) {
    case 'skillion':
      // High at t = −W, down to the eaves at t = +W: the slope faces +v, which
      // is the tagged `roof:direction` when there is one.
      return [p(0, -H / (2 * W), H / 2)];
    case 'gabled':
      return sides(H / W);
    case 'saltbox': {
      // The ridge a third of the way across: a long slope and a short steep one.
      const t0 = -W / 3;
      return [
        p(0, -H / (W - t0), H + (H * t0) / (W - t0)),
        p(0, H / (W + t0), H - (H * t0) / (W + t0)),
      ];
    }
    case 'hipped':
      return [...sides(H / W), p(-H / W, 0, (H * L) / W), p(H / W, 0, (H * L) / W)];
    case 'half-hipped': {
      // Gable walls up to 60% of the roof, then a short steep hip to the ridge.
      const depth = 0.35 * W;
      const slope = (0.4 * H) / depth;
      return [...sides(H / W), p(-slope, 0, 0.6 * H + slope * L), p(slope, 0, 0.6 * H + slope * L)];
    }
    case 'pyramidal':
      return [...sides(H / W), p(-H / L, 0, H), p(H / L, 0, H)];
    case 'gambrel':
    case 'mansard': {
      // Steep lower slopes over the outer half of each side, shallow above.
      const tb = 0.5 * W;
      const hb = 0.7 * H;
      const lower = hb / (W - tb);
      const upper = (H - hb) / tb;
      const planes = [
        p(0, -lower, lower * W),
        p(0, lower, lower * W),
        p(0, -upper, H),
        p(0, upper, H),
      ];
      if (shape === 'mansard') {
        // The same two slopes on the ends, with the same horizontal depths.
        const reach = L - W;
        planes.push(
          p(-lower, 0, lower * L),
          p(lower, 0, lower * L),
          p(-upper, 0, H + upper * reach),
          p(upper, 0, H + upper * reach),
        );
      }
      return planes;
    }
    case 'round': {
      const planes: Plane[] = [];
      for (const u of ROUND_TANGENTS) {
        const root = Math.sqrt(1 - u * u);
        // Tangent to z = H·√(1 − (t/W)²) at t = ±u·W.
        const slope = (H * u) / (root * W);
        const value = H * root + slope * u * W;
        planes.push(p(0, -slope, value));
        if (u > 0) planes.push(p(0, slope, value));
      }
      // The last facet: the chord from the outermost tangent point down to the
      // eaves at t = ±W. Without it the barrel ended at the last tangent plane,
      // which is still 0.12 × H high at the edge — a step the walls climbed.
      // Steeper than every tangent, so the roof stays concave.
      const last = ROUND_TANGENTS[ROUND_TANGENTS.length - 1];
      const edgeSlope = (H * Math.sqrt(1 - last * last)) / ((1 - last) * W);
      planes.push(p(0, -edgeSlope, edgeSlope * W), p(0, edgeSlope, edgeSlope * W));
      return planes;
    }
    default:
      return [];
  }
}

/** The roof's height above the eaves at a point: the lowest plane, never below 0. */
export function roofHeightAt(planes: readonly Plane[], x: number, y: number): number {
  let lowest = Infinity;
  for (const plane of planes) {
    const z = planeAt(plane, x, y);
    if (z < lowest) lowest = z;
  }
  return Math.max(0, lowest);
}

/**
 * Where along the edge `a → b` (as fractions in `(0, 1)`, sorted) the roof's
 * height stops being linear: the crossings of every pair of planes that is
 * the lowest there. Walls get a vertex at each, so their tops follow the roof
 * exactly.
 */
export function edgeBreaks(a: Point2, b: Point2, planes: readonly Plane[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      const da = planeAt(planes[i], a[0], a[1]) - planeAt(planes[j], a[0], a[1]);
      const db = planeAt(planes[i], b[0], b[1]) - planeAt(planes[j], b[0], b[1]);
      if (da === db || da * db >= 0) continue;
      const t = da / (da - db);
      if (t <= 1e-6 || t >= 1 - 1e-6) continue;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      // Only a crossing of the two LOWEST planes bends the roof.
      const here = planeAt(planes[i], x, y);
      if (planes.every((plane) => planeAt(plane, x, y) >= here - 1e-6)) out.push(t);
    }
  }
  out.sort((p, q) => p - q);
  return out.filter((t, k) => k === 0 || t - out[k - 1] > 1e-6);
}

/**
 * Clip a ring to the half-plane `a·x + b·y + c >= 0` (Sutherland–Hodgman).
 *
 * Exact and orientation-preserving for any ring; on a concave ring that the
 * line crosses more than twice it leaves zero-width bridges along the line,
 * which triangulate to nothing and lie exactly on a crease of the roof, where
 * both neighbouring patches have the same height.
 */
export function clipRingByLine(ring: readonly Point2[], a: number, b: number, c: number): Point2[] {
  const out: Point2[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const current = ring[i];
    const previous = ring[(i + n - 1) % n];
    const dc = a * current[0] + b * current[1] + c;
    const dp = a * previous[0] + b * previous[1] + c;
    if (dc >= 0) {
      if (dp < 0) out.push(intersect(previous, current, dp, dc));
      out.push(current);
    } else if (dp >= 0) {
      out.push(intersect(previous, current, dp, dc));
    }
  }
  return out;
}

function intersect(p: Point2, q: Point2, dp: number, dq: number): Point2 {
  const t = dp / (dp - dq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/**
 * The part of a polygon (exterior + holes, as rings) where plane `index` is
 * the lowest: each ring clipped by `plane_j − plane_index >= 0` for every other
 * plane. Rings that vanish are dropped; an empty result means the plane is
 * nowhere the roof.
 */
export function roofPatch(
  rings: readonly (readonly Point2[])[],
  planes: readonly Plane[],
  index: number,
): Point2[][] {
  const own = planes[index];
  const out: Point2[][] = [];
  for (let r = 0; r < rings.length; r++) {
    let ring: Point2[] = rings[r].slice();
    for (let j = 0; j < planes.length && ring.length >= 3; j++) {
      if (j === index) continue;
      const other = planes[j];
      // Tolerance on the side of keeping: a sliver of overlap along a crease
      // is invisible, a crack is not.
      ring = clipRingByLine(ring, other.a - own.a, other.b - own.b, other.c - own.c + 1e-4);
    }
    if (ring.length >= 3) out.push(ring);
    else if (r === 0) return [];
  }
  return out;
}

/** The area centroid of a ring (falls back to the vertex mean for a degenerate one). */
export function ringCentroid(points: readonly Point2[]): Point2 {
  let area = 0;
  let x = 0;
  let y = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    x += (x1 + x2) * cross;
    y += (y1 + y2) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    let mx = 0;
    let my = 0;
    for (const [px, py] of points) {
      mx += px;
      my += py;
    }
    return [mx / Math.max(1, n), my / Math.max(1, n)];
  }
  return [x / (3 * area), y / (3 * area)];
}

/**
 * Whether every edge of a counter-clockwise ring sees `centre` on its left —
 * i.e. the ring is star-shaped about it, so a fan of triangles to an apex
 * above it (a cone, a pyramid) or rings shrunk toward it (a dome) stay inside
 * the footprint.
 */
export function isStarShaped(points: readonly Point2[], centre: Point2): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const cross = (b[0] - a[0]) * (centre[1] - a[1]) - (b[1] - a[1]) * (centre[0] - a[0]);
    if (cross <= 0) return false;
  }
  return true;
}

/**
 * A surface of revolution's profile, as `[heightFraction, radiusFraction]`
 * from the eaves (`[0, 1]`) to the top (`[1, 0]`).
 */
export function revolutionProfile(shape: 'dome' | 'onion' | 'cone'): [number, number][] {
  if (shape === 'cone') {
    return [
      [0, 1],
      [1, 0],
    ];
  }
  if (shape === 'onion') {
    return [
      [0, 1],
      [0.12, 1.12],
      [0.28, 1.2],
      [0.45, 1.08],
      [0.6, 0.8],
      [0.74, 0.48],
      [0.86, 0.22],
      [0.95, 0.07],
      [1, 0],
    ];
  }
  // A hemisphere: eight rings, closer together near the top where it turns.
  const out: [number, number][] = [];
  const steps = 8;
  for (let k = 0; k <= steps; k++) {
    const phi = (k / steps) * (Math.PI / 2);
    out.push([Math.sin(phi), Math.cos(phi)]);
  }
  return out;
}
