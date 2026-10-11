/**
 * Footprint simplification for the far-field levels of detail (`lodMesher.ts`).
 *
 * Douglas–Peucker on a CLOSED ring, in local metres, with two constraints the
 * plain algorithm does not have:
 *
 *  - **Cut edges survive untouched.** An edge on the tile boundary (`Ring.cut`,
 *    see `mesher.ts`) is where the neighbouring tile's half of the same block
 *    meets this one. Both of its ends are pinned, so the edge is kept exactly
 *    and the two tiles still meet flush at every level of detail — a far tile
 *    at one level beside a near tile at another shows no crack.
 *  - **A ring that collapses is reported, not drawn.** Simplifying a sliver or
 *    a narrow courtyard can leave fewer than three points or flip its area;
 *    the caller drops such a ring rather than draw a folded roof.
 *
 * Pure and renderer-free, like the rest of the mesh pipeline; it runs in the
 * mesh Web Worker and is pinned by `__tests__/city3dLod.test.ts`.
 */
import type { Point2, Ring } from './mesher';

/** Squared distance from `p` to the segment `a → b`. */
export function segmentDistanceSq(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

/**
 * Mark the points of the open run `points[from..to]` (indices modulo `n`) that
 * Douglas–Peucker keeps at `toleranceM`. Iterative, so a 30,000-point ring
 * cannot overflow the stack.
 */
function markRun(
  points: readonly Point2[],
  keep: Uint8Array,
  from: number,
  to: number,
  toleranceSq: number,
): void {
  const n = points.length;
  const stack: number[] = [from, to];
  while (stack.length > 0) {
    const end = stack.pop() as number;
    const start = stack.pop() as number;
    const span = (end - start + n) % n;
    if (span < 2) continue;
    const a = points[start];
    const b = points[end];
    let worst = -1;
    let worstSq = toleranceSq;
    for (let k = 1; k < span; k++) {
      const i = (start + k) % n;
      const d = segmentDistanceSq(points[i], a, b);
      if (d > worstSq) {
        worstSq = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(start, worst, worst, end);
  }
}

/**
 * The ring with every point Douglas–Peucker can drop at `toleranceM` dropped,
 * cut edges kept intact. Returns the ring unchanged when the tolerance is 0.
 */
export function simplifyRing(ring: Ring, toleranceM: number): Ring {
  const { points, cut } = ring;
  const n = points.length;
  if (toleranceM <= 0 || n <= 4) return ring;

  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (cut[i]) {
      keep[i] = 1;
      keep[(i + 1) % n] = 1;
    }
  }
  // Two anchors are needed to start a closed ring: without a pinned point,
  // take the first point and the one farthest from it.
  let anchors = 0;
  for (let i = 0; i < n; i++) anchors += keep[i];
  if (anchors === 0) {
    let far = 1;
    let farSq = -1;
    for (let i = 1; i < n; i++) {
      const dx = points[i][0] - points[0][0];
      const dy = points[i][1] - points[0][1];
      const d = dx * dx + dy * dy;
      if (d > farSq) {
        farSq = d;
        far = i;
      }
    }
    keep[0] = 1;
    keep[far] = 1;
  } else if (anchors === 1) {
    const only = keep.indexOf(1);
    keep[(only + Math.floor(n / 2)) % n] = 1;
  }

  // Simplify each run between consecutive anchors.
  const toleranceSq = toleranceM * toleranceM;
  const pinned: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) pinned.push(i);
  for (let k = 0; k < pinned.length; k++) {
    markRun(points, keep, pinned[k], pinned[(k + 1) % pinned.length], toleranceSq);
  }

  const outPoints: Point2[] = [];
  const outCut: boolean[] = [];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    outPoints.push(points[i]);
    // An edge of the simplified ring is cut only if it IS an original cut edge:
    // both ends kept and adjacent in the original.
    const next = (i + 1) % n;
    outCut.push(cut[i] && keep[next] === 1);
  }
  return { points: outPoints, cut: outCut };
}
