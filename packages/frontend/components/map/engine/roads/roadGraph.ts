/**
 * The road graph's shared ground: the metric frame road tiles are read in,
 * polylines and their geometry, the class lane defaults, and the walk that
 * chains road pieces junction to junction.
 *
 * Shared by the city-life SIMULATION (`cityLife/sim/network.ts`) and the
 * street-detail mesher (`cityStreets/streetMesher.ts`): both read the same
 * road tiles (`roadTiles.ts`) into the same graph. Nothing here is
 * simulation — no agent, phase or timing — which is why it lives outside
 * `cityLife/` (`components/__tests__/cityLifeIsolation.test.ts`).
 *
 * Pure and synchronous.
 *
 * ## The frame
 *
 * Metres, x east and y NORTH, from the north-west corner of one z15 tile, the
 * ORIGIN ({@link SimFrame}). Converting a global tile unit to metres uses the
 * mercator scale at the origin tile's middle latitude — exactly what
 * `tileModelMatrix` uses to turn those metres back into mercator.
 */

import { EARTH_CIRCUMFERENCE_M, latitudeFromMercatorY } from '@/lib/map/geo';

const EXTENT = 4096;
const ZOOM = 15;

/**
 * Default lanes per direction where `lanes*` is not recorded. A simulation
 * parameter, and the street-detail mesher's drawing default (`cityStreets/lanes.ts`).
 */
export function defaultLanes(highway: string, oneway: boolean): number {
  if (highway === 'motorway' || highway === 'trunk') return 2;
  if (oneway && (highway === 'primary' || highway === 'secondary')) return 2;
  return 1;
}

export interface SimFrame {
  /** The origin tile (z15). */
  originX: number;
  originY: number;
  /** Metres per global tile unit. */
  metresPerUnit: number;
}

/** The frame for an origin tile: metres per tile unit at its middle latitude. */
export function simFrame(originX: number, originY: number): SimFrame {
  const n = 2 ** ZOOM;
  const lat = latitudeFromMercatorY((originY + 0.5) / n);
  // mercatorPerMetre(lat) = 1 / (C cos lat); one unit is 1/(n·EXTENT) mercator.
  const metresPerUnit = (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (n * EXTENT);
  return { originX, originY, metresPerUnit };
}

/** A polyline with cumulative lengths. */
export interface Polyline {
  xs: Float64Array;
  ys: Float64Array;
  /** `cum[i]`: metres from the start to point i. */
  cum: Float64Array;
  length: number;
}

export function polyline(points: readonly (readonly [number, number])[]): Polyline {
  const n = points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i][0];
    ys[i] = points[i][1];
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  return { xs, ys, cum, length: n > 0 ? cum[n - 1] : 0 };
}

/** The point and heading (radians, from east, counter-clockwise) at `s` metres along. */
export function pointAt(line: Polyline, s: number, out: { x: number; y: number; h: number }): void {
  const { xs, ys, cum } = line;
  const n = xs.length;
  if (n === 1 || line.length <= 0) {
    out.x = xs[0];
    out.y = ys[0];
    out.h = n > 1 ? Math.atan2(ys[n - 1] - ys[0], xs[n - 1] - xs[0]) : 0;
    return;
  }
  const clamped = s <= 0 ? 0 : s >= line.length ? line.length : s;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (clamped - cum[lo]) / span : 0;
  out.x = xs[lo] + (xs[hi] - xs[lo]) * t;
  out.y = ys[lo] + (ys[hi] - ys[lo]) * t;
  out.h = Math.atan2(ys[hi] - ys[lo], xs[hi] - xs[lo]);
}

/** Closest `s` on a polyline to a point, and the distance. */
export function project(line: Polyline, x: number, y: number): { s: number; d: number } {
  let best = { s: 0, d: Number.POSITIVE_INFINITY };
  for (let i = 0; i + 1 < line.xs.length; i++) {
    const ax = line.xs[i];
    const ay = line.ys[i];
    const dx = line.xs[i + 1] - ax;
    const dy = line.ys[i + 1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best.d) best = { s: line.cum[i] + t * Math.sqrt(len2), d };
  }
  return best;
}

/**
 * Offset a polyline sideways: positive `offset` is to the RIGHT of travel.
 * Mitred joins, the mitre capped at twice the offset so a hairpin cannot
 * throw a point across the street.
 */
export function offsetPolyline(
  points: readonly (readonly [number, number])[],
  offset: number,
): [number, number][] {
  const n = points.length;
  if (n < 2 || offset === 0) return points.map(([x, y]) => [x, y]);
  const out: [number, number][] = [];
  const normal = (i: number): [number, number] => {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const len = Math.hypot(dx, dy) || 1;
    // Right of (dx, dy) in a y-north frame is (dy, −dx).
    return [dy / len, -dx / len];
  };
  for (let i = 0; i < n; i++) {
    let nx: number;
    let ny: number;
    if (i === 0) [nx, ny] = normal(0);
    else if (i === n - 1) [nx, ny] = normal(n - 2);
    else {
      const [ax, ay] = normal(i - 1);
      const [bx, by] = normal(i);
      const mx = ax + bx;
      const my = ay + by;
      const mlen = Math.hypot(mx, my);
      if (mlen < 1e-6) {
        [nx, ny] = [ax, ay];
      } else {
        const cos = (mx / mlen) * ax + (my / mlen) * ay;
        const scale = Math.min(2, 1 / Math.max(cos, 0.5));
        nx = (mx / mlen) * scale;
        ny = (my / mlen) * scale;
      }
    }
    out.push([points[i][0] + nx * offset, points[i][1] + ny * offset]);
  }
  return out;
}

/** The part of a polyline between `from` and `to` metres along it. */
export function slice(line: Polyline, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  const at = { x: 0, y: 0, h: 0 };
  pointAt(line, from, at);
  out.push([at.x, at.y]);
  for (let i = 0; i < line.xs.length; i++) {
    if (line.cum[i] > from && line.cum[i] < to) out.push([line.xs[i], line.ys[i]]);
  }
  pointAt(line, to, at);
  out.push([at.x, at.y]);
  return out;
}

/** A piece of road between two graph nodes, as {@link chainPieces} walks it. */
export interface ChainablePiece {
  a: number;
  b: number;
  oneway: boolean;
}

/**
 * Pieces → chains running junction to junction: each chain continues through
 * every node exactly two pieces meet at (`degreeOf(node) === 2`) when the next
 * piece is `compatible` with it, reversing a two-way piece drawn the other way
 * (never a one-way one). Each piece is in exactly one chain, oriented. Shared
 * by the simulation's lane graph and the street-detail mesher
 * (`engine/cityStreets/`), which chain the same pieces with different notions
 * of "the same carriageway".
 */
export function chainPieces<P extends ChainablePiece>(
  pieces: readonly P[],
  degreeOf: (node: number) => number,
  reverse: (piece: P) => P,
  compatible: (piece: P, next: P) => boolean,
): P[][] {
  const piecesAt = new Map<number, number[]>();
  pieces.forEach(({ a, b }, i) => {
    for (const n of a === b ? [a] : [a, b]) {
      const list = piecesAt.get(n);
      if (list) list.push(i);
      else piecesAt.set(n, [i]);
    }
  });
  const visited = new Uint8Array(pieces.length);
  /** Oriented continuation of `piece` through its `b` end, or null. */
  const continueFrom = (piece: P): { index: number; piece: P } | null => {
    const n = piece.b;
    if (degreeOf(n) !== 2) return null;
    for (const index of piecesAt.get(n) ?? []) {
      if (visited[index]) continue;
      let next = pieces[index];
      if (next.a !== n) {
        if (next.oneway) continue; // would run against it
        next = reverse(next);
      }
      if (next.a !== n || !compatible(piece, next)) continue;
      return { index, piece: next };
    }
    return null;
  };
  const chains: P[][] = [];
  for (let start = 0; start < pieces.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    // Walk backwards to the chain's first piece, then forwards from it.
    let head = pieces[start];
    const backwards: P[] = [];
    for (;;) {
      const back = continueFrom(reverse(head));
      if (!back) break;
      visited[back.index] = 1;
      head = reverse(back.piece);
      backwards.push(head);
    }
    const chain = [...backwards.reverse(), pieces[start]];
    let tail = pieces[start];
    for (;;) {
      const next = continueFrom(tail);
      if (!next) break;
      visited[next.index] = 1;
      chain.push(next.piece);
      tail = next.piece;
    }
    chains.push(chain);
  }
  return chains;
}
