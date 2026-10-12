/**
 * Where a guided Walk may stand: the ground within reach of where the scene
 * was captured from.
 *
 * A Gaussian scene holds up only near where it was observed; a few metres off
 * the capture path the splats turn into shards and needles. So the camera
 * walks FREELY, but only over this region, and at the height the imagery was
 * captured from — never snapped to a viewpoint, never shown one.
 *
 * The published viewpoints carry no order (decimated, merged, sorted by
 * position: `streetSceneNavigationSchema`), so the path between them is
 * recovered rather than read: viewpoints are linked by a Gabriel graph — `a`
 * and `b` are linked when no other viewpoint lies inside the circle with
 * diameter `ab` — limited to {@link LINK_MAX_METERS}. That graph keeps the
 * consecutive steps of a walked path, links two walks a street apart across
 * it, has O(n) links whatever the density, and never jumps over a viewpoint.
 * The region is the union of horizontal capsules of radius `reach` around
 * those links, plus a disc around any viewpoint left unlinked.
 *
 * Everything is measured in the ground plane of the scene's own up (never an
 * assumed axis). Queries are answered from a uniform grid over that plane, with
 * no allocation: the engine asks them every frame.
 */
import type { StreetSceneNavigation } from '@goway.to/sdk';

import type { Vec3 } from './types';

/**
 * Viewpoints farther apart than this are never linked: a gap that wide between
 * two capture positions was not walked, so nothing between them was observed
 * from near by. Metres.
 */
export const LINK_MAX_METERS = 6;
/**
 * A capture this wide horizontally is a panorama (a 360° rig): every position
 * saw all around, so a facade is observed from along the whole path and from
 * both sides of it.
 */
export const PANORAMIC_MIN_HORIZONTAL_DEGREES = 170;
/**
 * Reach of a panoramic capture when the publisher states none, metres: about
 * the half-width of the lane a walker films down the middle of a street, where
 * every surface is still seen from within a few degrees of the captured rays.
 */
export const PANORAMIC_REACH_METERS = 3;
/**
 * Reach of a narrower (phone) capture when the publisher states none, metres:
 * it looked along its path or to one side, so much more than a stride off the
 * path shows surfaces it never faced.
 */
export const NARROW_REACH_METERS = 1.2;
/**
 * Heights are blended over every link within reach plus this, so the camera
 * height is continuous as it crosses from one link's capsule into the next.
 */
const HEIGHT_BLEND_METERS = 1.5;
/**
 * A viewpoint's height is the median of the captured heights within this, so a
 * walker's bob or one badly solved pose is not a step the camera takes, while
 * a slope or a stair (the same on both sides) is kept. Metres.
 */
const HEIGHT_MEDIAN_METERS = 3;
/** The query grid never holds more cells than this, however large the scene. */
const MAX_GRID_CELLS = 1 << 18;

/** How far from a capture position the scene holds up, metres. */
export function reachOf(
  navigation: Pick<StreetSceneNavigation, 'fieldOfView' | 'reachMeters'>,
): number {
  if (navigation.reachMeters !== undefined) return navigation.reachMeters;
  return (navigation.fieldOfView?.horizontalDegrees ?? 0) >= PANORAMIC_MIN_HORIZONTAL_DEGREES
    ? PANORAMIC_REACH_METERS
    : NARROW_REACH_METERS;
}

export interface WalkableRegion {
  /** Capsule radius, metres. */
  readonly reach: number;
  /** Whether the ground under `position` is walkable (height is ignored). */
  contains(position: Vec3): boolean;
  /**
   * The captured camera height at the ground under `position`, as a coordinate
   * along up: blended from the heights of the nearby links.
   */
  heightAt(position: Vec3): number;
  /**
   * Where the camera stands for a wished-for `position`: the nearest walkable
   * ground point (unchanged when inside — so motion SLIDES along the edge
   * rather than stopping), at the captured height there. Written into `out`.
   */
  clamp(position: Vec3, out?: Vec3): Vec3;
}

/**
 * The walkable region of `viewpoints` (scene coordinates) for scene `up`, or
 * `null` when there are none.
 */
export function createWalkableRegion(
  viewpoints: readonly { position: Vec3 }[],
  up: Vec3,
  reach: number,
): WalkableRegion | null {
  const n = viewpoints.length;
  if (n === 0 || !(reach > 0)) return null;

  // An orthonormal ground basis (e1, e2) under the scene's up.
  const upLength = Math.hypot(up[0], up[1], up[2]) || 1;
  const ux = up[0] / upLength;
  const uy = up[1] / upLength;
  const uz = up[2] / upLength;
  let ax = Math.abs(ux) < 0.9 ? 1 : 0;
  let ay = Math.abs(ux) < 0.9 ? 0 : 1;
  let az = 0;
  const along = ax * ux + ay * uy + az * uz;
  ax -= along * ux;
  ay -= along * uy;
  az -= along * uz;
  const axisLength = Math.hypot(ax, ay, az);
  const e1x = ax / axisLength;
  const e1y = ay / axisLength;
  const e1z = az / axisLength;
  const e2x = uy * e1z - uz * e1y;
  const e2y = uz * e1x - ux * e1z;
  const e2z = ux * e1y - uy * e1x;

  const pu = new Float64Array(n);
  const pv = new Float64Array(n);
  const captured = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = viewpoints[i].position;
    pu[i] = x * e1x + y * e1y + z * e1z;
    pv[i] = x * e2x + y * e2y + z * e2z;
    captured[i] = x * ux + y * uy + z * uz;
  }
  const near = groundBuckets(pu, pv, LINK_MAX_METERS);
  const ph = new Float64Array(n);
  const around: number[] = [];
  for (let i = 0; i < n; i++) {
    around.length = 0;
    near(pu[i], pv[i], (j) => {
      if ((pu[j] - pu[i]) ** 2 + (pv[j] - pv[i]) ** 2 <= HEIGHT_MEDIAN_METERS ** 2)
        around.push(captured[j]);
    });
    around.sort((a, b) => a - b);
    const middle = around.length >> 1;
    ph[i] = around.length % 2 ? around[middle] : (around[middle - 1] + around[middle]) / 2;
  }

  // ── Links: a Gabriel graph limited to LINK_MAX_METERS ─────────────────────

  const links = gabrielLinks(pu, pv, LINK_MAX_METERS, near);
  const linked = new Uint8Array(n);
  for (let k = 0; k < links.length; k++) linked[links[k]] = 1;
  const segments: number[] = [];
  for (let k = 0; k < links.length; k += 2) segments.push(links[k], links[k + 1]);
  // An unlinked viewpoint is a zero-length segment: a disc.
  for (let i = 0; i < n; i++) if (!linked[i]) segments.push(i, i);

  const count = segments.length / 2;
  const sAu = new Float64Array(count);
  const sAv = new Float64Array(count);
  const sAh = new Float64Array(count);
  const sDu = new Float64Array(count);
  const sDv = new Float64Array(count);
  const sDh = new Float64Array(count);
  const sLen2 = new Float64Array(count);
  for (let s = 0; s < count; s++) {
    const a = segments[2 * s];
    const b = segments[2 * s + 1];
    sAu[s] = pu[a];
    sAv[s] = pv[a];
    sAh[s] = ph[a];
    sDu[s] = pu[b] - pu[a];
    sDv[s] = pv[b] - pv[a];
    sDh[s] = ph[b] - ph[a];
    sLen2[s] = sDu[s] * sDu[s] + sDv[s] * sDv[s];
  }

  // ── Query grid ────────────────────────────────────────────────────────────
  //
  // Every segment is registered in each cell its bounding box, grown by
  // `margin`, overlaps; so one cell lists every segment that can matter to a
  // point in it, for containment and for the height blend.

  const margin = reach + HEIGHT_BLEND_METERS;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    minU = Math.min(minU, pu[i]);
    maxU = Math.max(maxU, pu[i]);
    minV = Math.min(minV, pv[i]);
    maxV = Math.max(maxV, pv[i]);
  }
  minU -= margin;
  minV -= margin;
  maxU += margin;
  maxV += margin;
  let cell = margin;
  while (Math.ceil((maxU - minU) / cell) * Math.ceil((maxV - minV) / cell) > MAX_GRID_CELLS)
    cell *= 1.5;
  const nu = Math.max(1, Math.ceil((maxU - minU) / cell));
  const nv = Math.max(1, Math.ceil((maxV - minV) / cell));
  const cellU = (u: number) => Math.max(0, Math.min(nu - 1, Math.floor((u - minU) / cell)));
  const cellV = (v: number) => Math.max(0, Math.min(nv - 1, Math.floor((v - minV) / cell)));

  const cellStart = new Int32Array(nu * nv + 1);
  const forEachCell = (s: number, visit: (index: number) => void) => {
    const u0 = cellU(Math.min(sAu[s], sAu[s] + sDu[s]) - margin);
    const u1 = cellU(Math.max(sAu[s], sAu[s] + sDu[s]) + margin);
    const v0 = cellV(Math.min(sAv[s], sAv[s] + sDv[s]) - margin);
    const v1 = cellV(Math.max(sAv[s], sAv[s] + sDv[s]) + margin);
    for (let cv = v0; cv <= v1; cv++) for (let cu = u0; cu <= u1; cu++) visit(cv * nu + cu);
  };
  for (let s = 0; s < count; s++) {
    forEachCell(s, (index) => {
      cellStart[index + 1] += 1;
    });
  }
  for (let c = 0; c < nu * nv; c++) cellStart[c + 1] += cellStart[c];
  const cellItems = new Int32Array(cellStart[nu * nv]);
  const fill = cellStart.slice(0, nu * nv);
  for (let s = 0; s < count; s++) {
    forEachCell(s, (index) => {
      cellItems[fill[index]++] = s;
    });
  }

  // ── Queries (scratch results, no allocation) ───────────────────────────────

  /** Nearest point on segment `s` to (u, v): sets `hitT` and returns the squared distance. */
  let hitT = 0;
  function segmentDistance2(s: number, u: number, v: number): number {
    const du = u - sAu[s];
    const dv = v - sAv[s];
    const t = sLen2[s] > 0 ? Math.max(0, Math.min(1, (du * sDu[s] + dv * sDv[s]) / sLen2[s])) : 0;
    hitT = t;
    const qu = du - t * sDu[s];
    const qv = dv - t * sDv[s];
    return qu * qu + qv * qv;
  }

  function insideAt(u: number, v: number): boolean {
    if (u < minU || u > maxU || v < minV || v > maxV) return false;
    const c = cellV(v) * nu + cellU(u);
    const reach2 = reach * reach;
    for (let k = cellStart[c]; k < cellStart[c + 1]; k++)
      if (segmentDistance2(cellItems[k], u, v) <= reach2) return true;
    return false;
  }

  /** The nearest segment to (u, v) anywhere: sets `nearS`, `nearT`, returns the distance. */
  let nearS = 0;
  let nearT = 0;
  function nearest(u: number, v: number): number {
    const cu = cellU(u);
    const cv = cellV(v);
    let best = Infinity;
    const rings = Math.max(nu, nv);
    for (let k = 0; k <= rings; k++) {
      for (let y = cv - k; y <= cv + k; y++) {
        if (y < 0 || y >= nv) continue;
        const edge = y === cv - k || y === cv + k;
        for (let x = cu - k; x <= cu + k; x += edge ? 1 : 2 * k) {
          if (x >= 0 && x < nu) {
            const c = y * nu + x;
            for (let i = cellStart[c]; i < cellStart[c + 1]; i++) {
              const s = cellItems[i];
              const d2 = segmentDistance2(s, u, v);
              if (d2 < best) {
                best = d2;
                nearS = s;
                nearT = hitT;
              }
            }
          }
          if (k === 0) break;
        }
      }
      // Anything not yet seen is registered only beyond ring k, so it lies
      // farther than k cells plus the registration margin.
      if (best < Infinity && Math.sqrt(best) <= k * cell + margin) break;
    }
    return Math.sqrt(best);
  }

  function heightAtGround(u: number, v: number): number {
    if (u >= minU && u <= maxU && v >= minV && v <= maxV) {
      const c = cellV(v) * nu + cellU(u);
      let sum = 0;
      let weights = 0;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const s = cellItems[k];
        const d = Math.sqrt(segmentDistance2(s, u, v));
        if (d >= margin) continue;
        const w = (1 - d / margin) ** 2;
        sum += w * (sAh[s] + hitT * sDh[s]);
        weights += w;
      }
      if (weights > 0) return sum / weights;
    }
    nearest(u, v);
    return sAh[nearS] + nearT * sDh[nearS];
  }

  const groundU = (p: Vec3) => p[0] * e1x + p[1] * e1y + p[2] * e1z;
  const groundV = (p: Vec3) => p[0] * e2x + p[1] * e2y + p[2] * e2z;

  return {
    reach,
    contains(position) {
      return insideAt(groundU(position), groundV(position));
    },
    heightAt(position) {
      return heightAtGround(groundU(position), groundV(position));
    },
    clamp(position, out = [0, 0, 0]) {
      let u = groundU(position);
      let v = groundV(position);
      if (!insideAt(u, v)) {
        const distance = nearest(u, v);
        const s = nearS;
        const qu = sAu[s] + nearT * sDu[s];
        const qv = sAv[s] + nearT * sDv[s];
        // Onto the capsule's edge, a hair inside so `contains` agrees.
        const k = distance > 0 ? (reach * (1 - 1e-9)) / distance : 0;
        u = qu + (u - qu) * k;
        v = qv + (v - qv) * k;
      }
      const h = heightAtGround(u, v);
      out[0] = u * e1x + v * e2x + h * ux;
      out[1] = u * e1y + v * e2y + h * uy;
      out[2] = u * e1z + v * e2z + h * uz;
      return out;
    },
  };
}

/** Visits every point in the 3×3 build cells around (u, v): all within one cell size of it. */
type Near = (u: number, v: number, visit: (index: number) => void) => void;

/** A build-time bucket grid of `cell`-sized cells over ground points. */
function groundBuckets(pu: Float64Array, pv: Float64Array, cell: number): Near {
  let minU = Infinity;
  let minV = Infinity;
  for (let i = 0; i < pu.length; i++) {
    minU = Math.min(minU, pu[i]);
    minV = Math.min(minV, pv[i]);
  }
  const buckets = new Map<string, number[]>();
  const cellOf = (value: number, min: number) => Math.floor((value - min) / cell);
  for (let i = 0; i < pu.length; i++) {
    const key = `${cellOf(pu[i], minU)},${cellOf(pv[i], minV)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }
  return (u, v, visit) => {
    const cu = cellOf(u, minU);
    const cv = cellOf(v, minV);
    for (let dv = -1; dv <= 1; dv++)
      for (let du = -1; du <= 1; du++)
        for (const index of buckets.get(`${cu + du},${cv + dv}`) ?? []) visit(index);
  };
}

/**
 * Gabriel-graph links between ground points no farther apart than `maxLength`,
 * as a flat `[a, b, a, b, …]` list. Coincident points are not linked (each is
 * its own disc). Built once per scene.
 */
export function gabrielLinks(
  pu: Float64Array,
  pv: Float64Array,
  maxLength: number,
  near: Near = groundBuckets(pu, pv, maxLength),
): number[] {
  const links: number[] = [];
  const max2 = maxLength * maxLength;
  for (let a = 0; a < pu.length; a++) {
    near(pu[a], pv[a], (b) => {
      if (b <= a) return;
      const lu = pu[b] - pu[a];
      const lv = pv[b] - pv[a];
      const length2 = lu * lu + lv * lv;
      if (length2 > max2 || length2 < 1e-12) return;
      // The circle on `ab` as diameter has radius ≤ maxLength / 2, so every
      // point that could lie inside it is near its centre.
      const mu = pu[a] + lu / 2;
      const mv = pv[a] + lv / 2;
      const r2 = (length2 / 4) * (1 - 1e-9);
      let blocked = false;
      near(mu, mv, (c) => {
        if (blocked || c === a || c === b) return;
        if ((pu[c] - mu) ** 2 + (pv[c] - mv) ** 2 < r2) blocked = true;
      });
      if (!blocked) links.push(a, b);
    });
  }
  return links;
}
