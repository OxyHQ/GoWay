/**
 * Curves for camera paths: simplification, centripetal Catmull-Rom, and
 * arc-length sampling.
 *
 * ## Why centripetal
 *
 * A Catmull-Rom spline passes THROUGH its control points, which is what both
 * users of this file need: a flyover must stay on the road it is flying, and
 * a Studio keyframe is a place the camera promised to be. The parameterisation
 * decides how it gets there. Uniform Catmull-Rom (α = 0) overshoots and forms
 * cusps and self-intersecting loops where control points are unevenly spaced —
 * exactly the shape of a route polyline (two vertices a metre apart at a
 * junction, then nothing for 300 m) and of a hand-drawn stroke. Centripetal
 * (α = ½) is proven free of cusps and self-intersections within a segment
 * (Yuksel, Schaefer & Keyser, "Parameterization and applications of
 * Catmull–Rom curves", 2011), and chordal (α = 1) bulges wide in tight turns.
 * Atlas Camera Studio smooths drawn camera paths for the same reason.
 *
 * Points carry extra channels (zoom, pitch…) after `x` and `y`. The knot
 * spacing is measured on `x`/`y` only, so a channel rides the curve's own
 * timing rather than bending it.
 */
import type { PlanePoint } from './plane';

/** A point in the plane plus any number of extra channels (zoom, pitch…). */
export type CurvePoint = readonly number[];

/** Perpendicular distance from `p` to the segment `a`–`b`. */
function segmentDistance(p: PlanePoint, a: PlanePoint, b: PlanePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker: the fewest points that stay within `tolerance`
 * metres of the original line. Endpoints are always kept. Iterative, so a
 * 10,000-vertex route cannot overflow the stack.
 */
export function simplify<T extends PlanePoint>(points: readonly T[], tolerance: number): T[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(points[i], points[first], points[last]);
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Drop consecutive points closer than `epsilon` metres (a route repeats its junction vertices). */
export function dedupe<T extends PlanePoint>(points: readonly T[], epsilon = 0.01): T[] {
  const out: T[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > epsilon) out.push(p);
  }
  return out;
}

function knotStep(a: CurvePoint, b: CurvePoint, alpha: number): number {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // A zero step (coincident points) would divide by zero below; a tiny one
  // degrades that segment to a straight blend, which is the right answer for
  // "the camera stays here and turns".
  return Math.max(d ** alpha, 1e-6);
}

/**
 * Evaluate one Catmull-Rom segment between `p1` and `p2` at `u ∈ [0, 1]`
 * (Barry–Goldman pyramid; every channel shares the knots).
 */
export function catmullRomPoint(
  p0: CurvePoint,
  p1: CurvePoint,
  p2: CurvePoint,
  p3: CurvePoint,
  u: number,
  alpha: number,
): number[] {
  const t0 = 0;
  const t1 = t0 + knotStep(p0, p1, alpha);
  const t2 = t1 + knotStep(p1, p2, alpha);
  const t3 = t2 + knotStep(p2, p3, alpha);
  const t = t1 + (t2 - t1) * u;
  const out = new Array<number>(p1.length);
  for (let c = 0; c < p1.length; c++) {
    const a1 = ((t1 - t) / (t1 - t0)) * p0[c] + ((t - t0) / (t1 - t0)) * p1[c];
    const a2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
    const a3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
    const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    out[c] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  }
  return out;
}

/** A phantom end point: the end reflected through its neighbour, so the curve leaves straight. */
export function reflect(end: CurvePoint, neighbour: CurvePoint): number[] {
  return end.map((value, c) => 2 * value - neighbour[c]);
}

export interface CatmullRomOptions {
  /** 0 uniform, 0.5 centripetal (default), 1 chordal. */
  alpha?: number;
  /** Target spacing of the output, in metres along x/y. */
  spacing: number;
  /** Hard cap on the samples per segment, for a pathological input. */
  maxSamplesPerSegment?: number;
}

/**
 * A dense polyline through every control point.
 *
 * Returns the samples and, for each control point, the index of the sample
 * that IS that control point — so a caller can find "where keyframe 3 is" on
 * the curve without searching for it.
 */
export function catmullRom(
  points: readonly CurvePoint[],
  options: CatmullRomOptions,
): { samples: number[][]; controlIndex: number[] } {
  const alpha = options.alpha ?? 0.5;
  const maxPer = options.maxSamplesPerSegment ?? 512;
  if (points.length === 0) return { samples: [], controlIndex: [] };
  if (points.length === 1) return { samples: [points[0].slice()], controlIndex: [0] };

  const samples: number[][] = [points[0].slice()];
  const controlIndex = [0];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = i > 0 ? points[i - 1] : reflect(points[0], points[1]);
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i + 2 < points.length ? points[i + 2] : reflect(points[i + 1], points[i]);
    const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const count = Math.max(1, Math.min(maxPer, Math.ceil(chord / Math.max(options.spacing, 1e-3))));
    for (let k = 1; k <= count; k++) {
      // The last sample of a segment is its end control point, exactly.
      samples.push(k === count ? p2.slice() : catmullRomPoint(p0, p1, p2, p3, k / count, alpha));
    }
    controlIndex.push(samples.length - 1);
  }
  return { samples, controlIndex };
}

/** Cumulative x/y arc length of a polyline, starting at 0. */
export function arcLengths(points: readonly CurvePoint[]): Float64Array {
  const out = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    out[i] =
      out[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return out;
}

/**
 * The index `i` with `values[i] <= target < values[i + 1]`, for a
 * non-decreasing array. Clamped to the ends.
 */
export function bracket(values: ArrayLike<number>, target: number): number {
  const last = values.length - 1;
  if (last <= 0 || target <= values[0]) return 0;
  if (target >= values[last]) return Math.max(0, last - 1);
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Linearly interpolate a polyline (every channel) at arc length `s`. */
export function sampleAtLength(
  points: readonly CurvePoint[],
  lengths: ArrayLike<number>,
  s: number,
): number[] {
  if (points.length === 1) return points[0].slice();
  const i = bracket(lengths, s);
  const span = lengths[i + 1] - lengths[i];
  const t = span > 0 ? Math.max(0, Math.min(1, (s - lengths[i]) / span)) : 0;
  return points[i].map((value, c) => value + (points[i + 1][c] - value) * t);
}

/**
 * Resample a polyline at a fixed spacing along its own length.
 *
 * Every downstream step (look-ahead, curvature, speed) is then a function of
 * DISTANCE rather than of vertex index, which is what makes it independent of
 * how densely the routing engine happened to draw a street.
 */
export function resample(
  points: readonly CurvePoint[],
  spacing: number,
): { samples: number[][]; lengths: Float64Array } {
  const lengths = arcLengths(points);
  const total = lengths[lengths.length - 1] ?? 0;
  if (points.length < 2 || total === 0) {
    const only = points[0] ? [points[0].slice()] : [];
    return { samples: only, lengths: new Float64Array(only.length) };
  }
  const count = Math.max(1, Math.ceil(total / spacing));
  const samples: number[][] = [];
  const out = new Float64Array(count + 1);
  for (let k = 0; k <= count; k++) {
    const s = (total * k) / count;
    samples.push(sampleAtLength(points, lengths, s));
    out[k] = s;
  }
  return { samples, lengths: out };
}
