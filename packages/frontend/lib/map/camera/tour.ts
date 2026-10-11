/**
 * Camera Studio tours: keyframes in, a smooth camera over time out.
 *
 * A tour is what a user authors in Camera Studio (`features/flyover/studio/`)
 * and shares as a link (`lib/map/tourLink.ts`): an ordered list of
 * KEYFRAMES, each a camera the tour promises to pass through. Like
 * {@link planRouteFlyover} this is pure — the player asks for a time and gets
 * a viewport — so preview, scrub, video export and native playback are one
 * code path.
 *
 * ## A keyframe
 *
 * A keyframe is a MapLibre-shaped camera — a centre, a zoom, a pitch — plus
 * how it aims:
 *
 *  - `path`   — face along the path (a drawn stroke, a street);
 *  - `fixed`  — hold the keyframe's own bearing;
 *  - `lookAt` — turn to face a point (a landmark) wherever the camera is.
 *
 * Between two keyframes the aim is blended over the segment, so a tour can
 * follow a street and then swing round to face a tower without a cut.
 *
 * ## The motion
 *
 * Centres are joined by a centripetal Catmull-Rom spline (see `spline.ts` for
 * why centripetal); zoom and pitch ride the same curve. Time is spread by
 * PERCEIVED motion rather than by keyframe count: a segment costs its ground
 * distance in screen pixels at its zoom, plus its change in zoom, pitch and
 * bearing, and the whole tour then eases in at the start and out at the end.
 * So a long pan at street level takes longer than the same pan from a
 * kilometre up, which is what makes it watchable — the same rule Atlas Camera
 * Studio applies to its interpolated cameras.
 */
import type { GeoCoordinate, ResolvedMapViewport } from '@/components/map/types';

import {
  bearingDelta,
  bearingOf,
  clamp,
  createPlane,
  lerp,
  lerpBearing,
  metresPerPixel,
  normalizeBearing,
  smoothstep,
  trapezoidEase,
} from './plane';
import { bracket, catmullRomPoint, reflect } from './spline';

export const TOUR_AIMS = ['path', 'fixed', 'lookAt'] as const;
export type TourAim = (typeof TOUR_AIMS)[number];

export interface TourKeyframe {
  /** Stable within one editing session (React keys, selection). Never encoded. */
  id: string;
  center: GeoCoordinate;
  zoom: number;
  /** Degrees from straight down, `0..60`. */
  pitch: number;
  /** Degrees clockwise from north. Used when `aim` is `fixed`. */
  bearing: number;
  aim: TourAim;
  /** The point faced when `aim` is `lookAt`. */
  lookAt?: GeoCoordinate;
  /** Pause here, ms. */
  holdMs: number;
}

export interface Tour {
  keyframes: readonly TourKeyframe[];
  /** Playback speed multiplier, `0.25..4`. */
  speed: number;
}

/** The fewest and most keyframes a tour may have. */
export const MIN_TOUR_KEYFRAMES = 2;
export const MAX_TOUR_KEYFRAMES = 64;
/** Longest hold at one keyframe. */
export const MAX_TOUR_HOLD_MS = 10_000;
export const MIN_TOUR_SPEED = 0.25;
export const MAX_TOUR_SPEED = 4;

/** Screen pixels per second the camera travels at speed 1. */
const BASE_PX_PER_S = 260;
/** A zoom level of change "costs" this many pixels of motion. */
const ZOOM_COST_PX = 420;
/** A degree of turn costs this many pixels. */
const BEARING_COST_PX = 3;
/** A degree of tilt costs this many pixels. */
const PITCH_COST_PX = 5;
/** Shortest segment, seconds at speed 1. */
const MIN_SEGMENT_S = 1.2;
/** Samples per segment of the evaluated curve. */
const SAMPLES_PER_SEGMENT = 48;
/** Fraction of the tour spent accelerating and decelerating. */
const EASE_RAMP = 0.12;

export interface CompiledTour {
  durationMs: number;
  /** When the camera is AT each keyframe (the start of its hold). */
  keyframeTimes: readonly number[];
  /** The smoothed path of the camera centre, for drawing. */
  path: readonly GeoCoordinate[];
  cameraAt(timeMs: number): ResolvedMapViewport;
}

interface Sample {
  x: number;
  y: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/** What a keyframe aims at from a point on the path, as a bearing. */
function aimBearing(
  keyframe: TourKeyframe,
  point: { x: number; y: number },
  tangent: number,
  toPlane: (c: GeoCoordinate) => { x: number; y: number },
): number {
  if (keyframe.aim === 'fixed') return keyframe.bearing;
  if (keyframe.aim === 'lookAt' && keyframe.lookAt) {
    const target = toPlane(keyframe.lookAt);
    const dx = target.x - point.x;
    const dy = target.y - point.y;
    // Standing on the target there is no direction to face; keep the path's.
    return Math.hypot(dx, dy) > 1 ? bearingOf(dx, dy) : tangent;
  }
  return tangent;
}

/**
 * Compile a tour for playback, or `null` when it is not one (fewer than two
 * keyframes).
 */
export function compileTour(tour: Tour): CompiledTour | null {
  const keyframes = tour.keyframes;
  if (keyframes.length < MIN_TOUR_KEYFRAMES) return null;
  const speed = clamp(Number.isFinite(tour.speed) ? tour.speed : 1, MIN_TOUR_SPEED, MAX_TOUR_SPEED);
  const plane = createPlane(keyframes[0].center);
  const toPlane = (c: GeoCoordinate) => plane.toPlane(c);

  const control = keyframes.map((k) => {
    const p = plane.toPlane(k.center);
    return [p.x, p.y, k.zoom, k.pitch];
  });

  // A fixed number of samples per segment (not a spacing): a segment that is
  // a pure rotation in place has no length, and still needs samples to turn.
  const samples: number[][] = [control[0]];
  const keyIndex = [0];
  for (let i = 0; i < control.length - 1; i++) {
    const seg = segmentSamples(control, i, SAMPLES_PER_SEGMENT);
    for (let k = 1; k < seg.length; k++) samples.push(seg[k]);
    keyIndex.push(samples.length - 1);
  }

  // Path tangents, then each sample's bearing blended between the aims of the
  // two keyframes around it.
  const n = samples.length;
  const tangents = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    tangents[i] = Math.hypot(dx, dy) > 1e-6 ? bearingOf(dx, dy) : Number.NaN;
  }
  // A keyframe that does not move (a pivot) has no tangent: borrow the nearest.
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(tangents[i])) continue;
    let j = 1;
    let found = Number.NaN;
    while (Number.isNaN(found) && (i - j >= 0 || i + j < n)) {
      if (i + j < n && !Number.isNaN(tangents[i + j])) found = tangents[i + j];
      else if (i - j >= 0 && !Number.isNaN(tangents[i - j])) found = tangents[i - j];
      j++;
    }
    tangents[i] = Number.isNaN(found) ? keyframes[0].bearing : found;
  }

  const evaluated: Sample[] = [];
  for (let seg = 0; seg < keyframes.length - 1; seg++) {
    const from = keyIndex[seg];
    const to = keyIndex[seg + 1];
    for (let i = seg === 0 ? from : from + 1; i <= to; i++) {
      const point = { x: samples[i][0], y: samples[i][1] };
      const u = to > from ? (i - from) / (to - from) : 1;
      const a = aimBearing(keyframes[seg], point, tangents[i], toPlane);
      const b = aimBearing(keyframes[seg + 1], point, tangents[i], toPlane);
      evaluated.push({
        x: point.x,
        y: point.y,
        zoom: samples[i][2],
        pitch: clamp(samples[i][3], 0, 60),
        bearing: lerpBearing(a, b, smoothstep(u)),
      });
    }
  }

  // Perceived motion between consecutive samples.
  const cost = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = evaluated[i - 1];
    const b = evaluated[i];
    const zoom = (a.zoom + b.zoom) / 2;
    const lat = plane.toGeo(b).latitude;
    const ground = Math.hypot(b.x - a.x, b.y - a.y) / metresPerPixel(lat, zoom);
    const step =
      ground +
      Math.abs(b.zoom - a.zoom) * ZOOM_COST_PX +
      Math.abs(bearingDelta(a.bearing, b.bearing)) * BEARING_COST_PX +
      Math.abs(b.pitch - a.pitch) * PITCH_COST_PX;
    cost[i] = cost[i - 1] + step;
  }
  // Each segment at least MIN_SEGMENT_S long: stretch its cost if needed.
  const minCost = MIN_SEGMENT_S * BASE_PX_PER_S;
  const adjusted = new Float64Array(n);
  let carried = 0;
  for (let seg = 0; seg < keyframes.length - 1; seg++) {
    const from = keyIndex[seg];
    const to = keyIndex[seg + 1];
    const segCost = cost[to] - cost[from];
    const factor = segCost < minCost ? (segCost > 0 ? minCost / segCost : 0) : 1;
    for (let i = from + 1; i <= to; i++) {
      const piece = factor === 0 ? minCost / (to - from) : (cost[i] - cost[i - 1]) * factor;
      carried += piece;
      adjusted[i] = carried;
    }
  }
  const motionTotal = adjusted[n - 1];
  const motionMs = ((motionTotal / BASE_PX_PER_S) * 1000) / speed;

  // Holds are inserted at keyframes as flat stretches of time.
  const holds = keyframes.map((k) => clamp(k.holdMs, 0, MAX_TOUR_HOLD_MS) / speed);
  const holdTotal = holds.reduce((sum, h) => sum + h, 0);
  const durationMs = motionMs + holdTotal;

  // Timeline: a list of (time → motion position) pieces. Motion time is eased
  // over the whole tour, holds interrupt it.
  const easedFraction = (motionFraction: number) => trapezoidEase(motionFraction, EASE_RAMP);
  const invertEase = (target: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (easedFraction(mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  // Motion time (before holds) at which each keyframe is reached.
  const keyMotionMs = keyIndex.map((index) => {
    if (motionTotal <= 0 || adjusted[index] <= 0) return 0;
    if (adjusted[index] >= motionTotal) return motionMs;
    return invertEase(adjusted[index] / motionTotal) * motionMs;
  });
  const keyframeTimes: number[] = [];
  let holdSoFar = 0;
  for (let k = 0; k < keyframes.length; k++) {
    keyframeTimes.push(keyMotionMs[k] + holdSoFar);
    holdSoFar += holds[k];
  }

  const viewportAt = (sample: Sample): ResolvedMapViewport => {
    const geo = plane.toGeo(sample);
    return {
      latitude: geo.latitude,
      longitude: geo.longitude,
      zoom: sample.zoom,
      bearing: normalizeBearing(sample.bearing),
      pitch: sample.pitch,
    };
  };

  const atMotionMs = (motionTime: number): Sample => {
    const fraction = motionMs > 0 ? easedFraction(clamp(motionTime / motionMs, 0, 1)) : 1;
    const target = fraction * motionTotal;
    const i = bracket(adjusted, target);
    const span = adjusted[i + 1] - adjusted[i];
    const t = span > 0 ? clamp((target - adjusted[i]) / span, 0, 1) : 0;
    const a = evaluated[i];
    const b = evaluated[Math.min(n - 1, i + 1)];
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      zoom: lerp(a.zoom, b.zoom, t),
      pitch: lerp(a.pitch, b.pitch, t),
      bearing: lerpBearing(a.bearing, b.bearing, t),
    };
  };

  return {
    durationMs,
    keyframeTimes,
    path: evaluated.map((s) => plane.toGeo(s)),
    cameraAt(timeMs) {
      let t = clamp(Number.isFinite(timeMs) ? timeMs : 0, 0, durationMs);
      // Walk the holds: inside one, the camera sits at its keyframe.
      let held = 0;
      for (let k = 0; k < keyframes.length; k++) {
        const arrive = keyframeTimes[k];
        if (t < arrive) break;
        if (t <= arrive + holds[k]) {
          return viewportAt(evaluated[keyIndex[k]]);
        }
        held += holds[k];
      }
      t -= held;
      return viewportAt(atMotionMs(t));
    },
  };
}

/** The samples of segment `i → i+1` of a multi-channel centripetal Catmull-Rom, inclusive. */
function segmentSamples(control: readonly number[][], i: number, count: number): number[][] {
  const p1 = control[i];
  const p2 = control[i + 1];
  const p0 = i > 0 ? control[i - 1] : reflect(p1, p2);
  const p3 = i + 2 < control.length ? control[i + 2] : reflect(p2, p1);
  const out: number[][] = [p1.slice()];
  for (let k = 1; k < count; k++) out.push(catmullRomPoint(p0, p1, p2, p3, k / count, 0.5));
  out.push(p2.slice());
  return out;
}
