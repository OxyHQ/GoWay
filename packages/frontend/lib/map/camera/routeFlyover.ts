/**
 * A cinematic camera along a computed route: "preview this route in 3D".
 *
 * Pure — a route line and a viewport size in, a function of time out. Nothing
 * here knows about an engine, a clock or React: the player
 * (`features/flyover/useCameraPlayer.ts`) asks {@link FlyoverPlan.frameAt}
 * for a time and hands the camera to `MapApi.moveTo`, which is why the same
 * flyover runs on the web and native forks, and why pause, scrub and skip are
 * just "ask for another time".
 *
 * ## The shot
 *
 *  1. **Take-off** — from a top-down overview of the whole route, the camera
 *     swoops down and tilts into a chase position behind the start.
 *  2. **Follow** — it flies the route at a speed that eases in and out, slows
 *     in turns, and looks AHEAD of where the vehicle is: the bearing points at
 *     where the route is going ({@link LOOK_AHEAD_FRACTION} of its length,
 *     clamped), smoothed along the route so a zig-zag street does not whip the
 *     camera left and right.
 *  3. **Landing** — it rises into a tilted overview of the whole route,
 *     keeping its final heading, so the last frame says where you went.
 *
 * ## What adapts
 *
 *  - **Length** sets the flight time (logarithmically: a 300 m walk is ~16 s,
 *    1.2 km ~26 s, 10 km ~50 s, capped at a minute) and the cruise zoom (closer
 *    for short routes, where 3D buildings are the point; further out for long
 *    ones, where the ground would otherwise smear past).
 *  - **Turns** slow the camera (down to {@link TURN_SLOWDOWN}), pull it back a
 *    little and flatten its pitch, so a turn reads as a turn instead of a
 *    lurch.
 *
 * Everything that depends on the route is precomputed once, per sample along
 * its length, so {@link FlyoverPlan.frameAt} is a binary search and a few
 * interpolations — cheap enough for every animation frame and deterministic,
 * which is what makes scrubbing back land on exactly the frame you saw.
 */
import type { GeoCoordinate, ResolvedMapViewport } from '@/components/map/types';

import {
  bearingDelta,
  bearingOf,
  clamp,
  createPlane,
  fitZoom,
  lerp,
  lerpBearing,
  metresPerPixel,
  normalizeBearing,
  type PlanePoint,
  trapezoidEase,
} from './plane';
import { arcLengths, bracket, catmullRom, dedupe, resample, simplify } from './spline';

/** The camera every frame, plus where the vehicle is. */
export interface FlyoverFrame {
  camera: ResolvedMapViewport;
  vehicle: { position: GeoCoordinate; heading: number };
  /** Metres along the route the vehicle has travelled. */
  distanceMeters: number;
  phase: 'takeoff' | 'follow' | 'landing';
}

export interface FlyoverPlan {
  durationMs: number;
  lengthMeters: number;
  /**
   * Times (ms) worth jumping to: the start of the follow, each maneuver (or
   * each detected turn), the end. Skip back/forward and the reduced-motion
   * stills step through these.
   */
  chapters: readonly number[];
  frameAt(timeMs: number): FlyoverFrame;
  /** The smoothed line the vehicle drives, for drawing. */
  path: readonly GeoCoordinate[];
}

export interface FlyoverInput {
  coordinates: readonly GeoCoordinate[];
  /** The canvas, in px: the overview frames are fitted into it. */
  viewport: { width: number; height: number };
  /** Indices into `coordinates` where something happens (maneuvers). */
  chapterIndices?: readonly number[];
}

/** Seconds of take-off and landing. */
const TAKEOFF_S = 3;
const LANDING_S = 3.5;
/** Pitch while cruising straight; MapCanvas caps pitch at 60 on both forks. */
const CRUISE_PITCH = 58;
/** Pitch taken off in the sharpest turn. */
const TURN_PITCH_DROP = 14;
/** Zoom pulled back in the sharpest turn. */
const TURN_ZOOM_PULL = 0.5;
/** Slowest speed, as a fraction of cruise, in the sharpest turn. */
const TURN_SLOWDOWN = 0.45;
/** How far ahead the camera looks, as a fraction of the route length (clamped). */
const LOOK_AHEAD_FRACTION = 0.04;
/** Where the vehicle sits: this fraction of the viewport height below the centre. */
const VEHICLE_BELOW_CENTRE = 0.14;
/** How far before and after a corner the vehicle's line is rounded, metres. */
const CORNER_REACH_M = 6;
/** Padding of the overview frames, px. */
const OVERVIEW_PADDING = 56;

/** Flight time of the follow phase, seconds, from the route length. */
export function followSeconds(lengthMeters: number): number {
  return clamp(10 + 9 * Math.log2(1 + lengthMeters / 500), 12, 60);
}

/** Cruise zoom from the route length. */
export function cruiseZoom(lengthMeters: number): number {
  return clamp(17.6 - 0.5 * Math.log2(1 + lengthMeters / 1000), 14.5, 17.5);
}

/** Insert vertices so no segment is longer than `maxStep` (endpoints kept exactly). */
function densify(points: readonly number[][], maxStep: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxStep));
    for (let k = 0; k < steps; k++)
      out.push([lerp(a[0], b[0], k / steps), lerp(a[1], b[1], k / steps)]);
  }
  out.push(points[points.length - 1].slice());
  return out;
}

/** Gaussian-smooth a series sampled at a fixed spacing, `sigma` in samples. */
function gaussian(values: Float64Array, sigma: number): Float64Array {
  if (sigma < 0.5 || values.length < 3) return values.slice();
  const radius = Math.ceil(sigma * 3);
  const weights = new Float64Array(radius * 2 + 1);
  for (let k = -radius; k <= radius; k++)
    weights[k + radius] = Math.exp(-(k * k) / (2 * sigma * sigma));
  const out = new Float64Array(values.length);
  const last = values.length - 1;
  for (let i = 0; i <= last; i++) {
    let sum = 0;
    let total = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = Math.max(0, Math.min(last, i + k));
      sum += values[j] * weights[k + radius];
      total += weights[k + radius];
    }
    out[i] = sum / total;
  }
  return out;
}

/** Unwrap a bearing series so consecutive values never jump by more than 180°. */
function unwrap(bearings: Float64Array): Float64Array {
  const out = new Float64Array(bearings.length);
  if (bearings.length === 0) return out;
  out[0] = bearings[0];
  for (let i = 1; i < bearings.length; i++)
    out[i] = out[i - 1] + bearingDelta(out[i - 1], bearings[i]);
  return out;
}

/** Inverse of a monotonic `f` on [0, 1] by bisection. */
function invert(f: (x: number) => number, y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

interface Pose {
  x: number;
  y: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

/** Ease-in-out for the take-off and landing. */
function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * Between two camera poses, with the centre moving in step with the SCALE
 * rather than with time — the zoom-and-pan rule (van Wijk & Nuij): when the
 * camera is far out a metre of ground is a fraction of a pixel, so the centre
 * should cover most of its distance then, and creep at the close end. A
 * linear blend does the opposite and the ground rushes past at the bottom of
 * the swoop.
 */
function blendPoses(a: Pose, b: Pose, t: number): Pose {
  const zoom = lerp(a.zoom, b.zoom, t);
  const wa = 2 ** -a.zoom;
  const wb = 2 ** -b.zoom;
  const w = 2 ** -zoom;
  const k = Math.abs(wa - wb) > 1e-12 ? (wa - w) / (wa - wb) : t;
  return {
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
    zoom,
    bearing: lerpBearing(a.bearing, b.bearing, t),
    pitch: lerp(a.pitch, b.pitch, t),
  };
}

/**
 * Plan a flyover, or `null` when there is nothing to fly (fewer than two
 * distinct, drawable points, or a route under five metres).
 */
export function planRouteFlyover(input: FlyoverInput): FlyoverPlan | null {
  const raw = input.coordinates.filter(
    (c) =>
      Number.isFinite(c.latitude) &&
      Number.isFinite(c.longitude) &&
      Math.abs(c.latitude) <= 85.051129 &&
      Math.abs(c.longitude) <= 180,
  );
  if (raw.length < 2) return null;
  const plane = createPlane(raw[0]);

  // Raw plane points, keeping the source index so maneuvers can be placed.
  const indexed = raw.map((c, index) => ({ ...plane.toPlane(c), index }));
  const distinct = dedupe(indexed);
  if (distinct.length < 2) return null;
  const rawLengths = arcLengths(distinct.map((p) => [p.x, p.y]));
  const length = rawLengths[rawLengths.length - 1];
  if (!(length >= 5)) return null;

  // The vehicle's line: the route itself with its corners rounded just enough
  // to be driven, at a spacing that keeps a 100 km route to ~4,000 samples.
  const spacing = clamp(length / 4000, 1, 25);
  const control = simplify(distinct, 1.5).map((p) => [p.x, p.y]);
  // Densified before smoothing, so the spline only rounds the last few metres
  // into each corner: through three far-apart vertices a Catmull-Rom bends
  // whole straight legs, and the vehicle would drive beside the road.
  const curve = catmullRom(densify(control, CORNER_REACH_M), {
    spacing: Math.min(2, spacing),
  }).samples;
  const { samples, lengths } = resample(curve, spacing);
  const n = samples.length;
  const total = lengths[n - 1];
  const at = (s: number): PlanePoint => {
    const i = bracket(lengths, s);
    const span = lengths[i + 1] - lengths[i];
    const t = span > 0 ? clamp((s - lengths[i]) / span, 0, 1) : 0;
    const a = samples[i];
    const b = samples[Math.min(n - 1, i + 1)];
    return { x: lerp(a[0], b[0], t), y: lerp(a[1], b[1], t) };
  };

  // The last direction, for looking past the end of the route.
  const tail = samples[n - 1];
  const beforeTail = samples[Math.max(0, n - 2)];
  const tailLength = Math.hypot(tail[0] - beforeTail[0], tail[1] - beforeTail[1]) || 1;
  const tailDir = {
    x: (tail[0] - beforeTail[0]) / tailLength,
    y: (tail[1] - beforeTail[1]) / tailLength,
  };
  const ahead = (s: number): PlanePoint => {
    if (s <= total) return at(s);
    const over = s - total;
    return { x: tail[0] + tailDir.x * over, y: tail[1] + tailDir.y * over };
  };

  // Look-ahead bearing, smoothed along the route.
  const look = clamp(total * LOOK_AHEAD_FRACTION, 40, 400);
  const rawBearings = new Float64Array(n);
  const rawHeadings = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = samples[i];
    const target = ahead(lengths[i] + look);
    rawBearings[i] = bearingOf(target.x - p[0], target.y - p[1]);
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(n - 1, i + 1)];
    rawHeadings[i] = bearingOf(next[0] - prev[0], next[1] - prev[1]);
  }
  const bearings = gaussian(unwrap(rawBearings), (look * 0.5) / spacing);
  const headings = gaussian(unwrap(rawHeadings), 3 / spacing);

  // How hard the camera is turning, 0 (straight) … 1 (a right angle within
  // one look-ahead), itself smoothed so the speed eases into a turn.
  const turnRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = bearings[Math.max(0, i - 1)];
    const b = bearings[Math.min(n - 1, i + 1)];
    const ds = lengths[Math.min(n - 1, i + 1)] - lengths[Math.max(0, i - 1)] || 1;
    turnRaw[i] = clamp((Math.abs(b - a) / ds) * (look / 45), 0, 1);
  }
  const turn = gaussian(turnRaw, (look * 0.5) / spacing);

  // Time along the route: slower where it turns.
  const effort = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const slowness = 1 / lerp(1, TURN_SLOWDOWN, (turn[i] + turn[i - 1]) / 2);
    effort[i] = effort[i - 1] + (lengths[i] - lengths[i - 1]) * slowness;
  }
  const effortTotal = effort[n - 1];

  const followMs = followSeconds(total) * 1000;
  const takeoffMs = TAKEOFF_S * 1000;
  const landingMs = LANDING_S * 1000;
  const durationMs = takeoffMs + followMs + landingMs;
  const ramp = Math.min(0.15, 2500 / followMs);
  const zoomBase = cruiseZoom(total);

  const sampleSeries = (series: Float64Array, s: number): number => {
    const i = bracket(lengths, s);
    const span = lengths[i + 1] - lengths[i];
    const t = span > 0 ? clamp((s - lengths[i]) / span, 0, 1) : 0;
    return lerp(series[i], series[Math.min(n - 1, i + 1)], t);
  };

  const followPose = (s: number): Pose & { vehicle: PlanePoint; heading: number } => {
    const vehicle = at(s);
    const bearing = normalizeBearing(sampleSeries(bearings, s));
    const bend = sampleSeries(turn, s);
    const zoom = zoomBase - TURN_ZOOM_PULL * bend;
    const pitch = CRUISE_PITCH - TURN_PITCH_DROP * bend;
    // Centre ahead of the vehicle, so it sits in the lower part of the frame
    // with the road it is about to drive above it.
    const lat = plane.toGeo(vehicle).latitude;
    const lead = VEHICLE_BELOW_CENTRE * input.viewport.height * metresPerPixel(lat, zoom);
    const rad = (bearing * Math.PI) / 180;
    return {
      x: vehicle.x + Math.sin(rad) * lead,
      y: vehicle.y + Math.cos(rad) * lead,
      zoom,
      bearing,
      pitch,
      vehicle,
      heading: normalizeBearing(sampleSeries(headings, s)),
    };
  };

  // Overviews: the whole route, top-down to take off from, tilted to land on.
  const outline = control.map(([x, y]) => ({ x, y }));
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of outline) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const overviewZoom = Math.min(
    zoomBase - 0.5,
    fitZoom(outline, plane, input.viewport, OVERVIEW_PADDING),
  );
  const startPose = followPose(0);
  const endPose = followPose(total);
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const takeoff: Pose = { ...centre, zoom: overviewZoom, bearing: 0, pitch: 0 };
  const landing: Pose = {
    ...centre,
    zoom: overviewZoom - 0.35,
    bearing: endPose.bearing,
    pitch: 45,
  };

  const distanceAtFollow = (fraction: number): number => {
    const target = trapezoidEase(fraction, ramp) * effortTotal;
    const i = bracket(effort, target);
    const span = effort[i + 1] - effort[i];
    const t = span > 0 ? clamp((target - effort[i]) / span, 0, 1) : 0;
    return lerp(lengths[i], lengths[Math.min(n - 1, i + 1)], t);
  };
  const timeAtDistance = (s: number): number => {
    const i = bracket(lengths, s);
    const span = lengths[i + 1] - lengths[i];
    const t = span > 0 ? clamp((s - lengths[i]) / span, 0, 1) : 0;
    const e = lerp(effort[i], effort[Math.min(n - 1, i + 1)], t) / (effortTotal || 1);
    return takeoffMs + invert((x) => trapezoidEase(x, ramp), e) * followMs;
  };

  const toViewport = (pose: Pose): ResolvedMapViewport => {
    const geo = plane.toGeo(pose);
    return {
      latitude: geo.latitude,
      longitude: geo.longitude,
      zoom: pose.zoom,
      bearing: normalizeBearing(pose.bearing),
      pitch: clamp(pose.pitch, 0, 60),
    };
  };

  // Chapters: the maneuvers when the route has them, else the sharpest turns.
  const chapterDistances: number[] = [];
  if (input.chapterIndices && input.chapterIndices.length > 0) {
    for (const index of input.chapterIndices) {
      // The first distinct vertex at or after the maneuver's index.
      const k = distinct.findIndex((p) => p.index >= index);
      if (k >= 0) chapterDistances.push(rawLengths[k] * (total / length));
    }
  } else {
    const minGap = Math.max(look * 2, total / 12);
    for (let i = 1; i < n - 1; i++) {
      if (turn[i] > 0.35 && turn[i] >= turn[i - 1] && turn[i] > turn[i + 1]) {
        const last = chapterDistances[chapterDistances.length - 1];
        if (last === undefined || lengths[i] - last >= minGap) chapterDistances.push(lengths[i]);
      }
    }
  }
  const chapterTimes = new Set<number>([0, takeoffMs]);
  for (const s of chapterDistances) {
    if (s > 1 && s < total - 1) chapterTimes.add(Math.round(timeAtDistance(s)));
  }
  chapterTimes.add(takeoffMs + followMs);
  // Never more than a fifth of the flight between two chapters, so the
  // reduced-motion stills and the skip buttons always have somewhere to go.
  const sorted = [...chapterTimes].sort((a, b) => a - b);
  const filled: number[] = [];
  const maxGap = followMs / 5;
  for (let i = 0; i < sorted.length; i++) {
    filled.push(sorted[i]);
    const next = sorted[i + 1];
    if (next === undefined) break;
    const pieces = Math.ceil((next - sorted[i]) / maxGap);
    for (let k = 1; k < pieces; k++)
      filled.push(Math.round(sorted[i] + ((next - sorted[i]) * k) / pieces));
  }
  filled.push(durationMs);
  const chapters = [...new Set(filled)].sort((a, b) => a - b);

  const path = samples.map(([x, y]) => plane.toGeo({ x, y }));

  return {
    durationMs,
    lengthMeters: total,
    chapters,
    path,
    frameAt(timeMs) {
      const t = clamp(Number.isFinite(timeMs) ? timeMs : 0, 0, durationMs);
      if (t < takeoffMs) {
        const pose = blendPoses(takeoff, startPose, easeInOutCubic(t / takeoffMs));
        return {
          camera: toViewport(pose),
          vehicle: { position: plane.toGeo(startPose.vehicle), heading: startPose.heading },
          distanceMeters: 0,
          phase: 'takeoff',
        };
      }
      if (t <= takeoffMs + followMs) {
        const s = distanceAtFollow((t - takeoffMs) / followMs);
        const pose = followPose(s);
        return {
          camera: toViewport(pose),
          vehicle: { position: plane.toGeo(pose.vehicle), heading: pose.heading },
          distanceMeters: s,
          phase: 'follow',
        };
      }
      const pose = blendPoses(
        endPose,
        landing,
        easeInOutCubic((t - takeoffMs - followMs) / landingMs),
      );
      return {
        camera: toViewport(pose),
        vehicle: { position: plane.toGeo(endPose.vehicle), heading: endPose.heading },
        distanceMeters: total,
        phase: 'landing',
      };
    },
  };
}
