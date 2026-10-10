/**
 * Street-View-style guided navigation over a scene's captured viewpoints.
 *
 * A Gaussian scene is trustworthy only from where it was observed: fly the
 * camera into a gap and the splats turn into shards and needles. So when a
 * manifest publishes `navigation`, the camera's POSITION lives on the
 * viewpoint graph — it starts at a viewpoint and glides to the next one — and
 * its LOOK is free but bounded: pitch is clamped and the field of view never
 * exceeds what the source imagery covered, with the excess darkened rather
 * than drawn.
 *
 * Pure numbers, no renderer: the engine asks these questions every input and
 * every frame, and they are unit-tested here.
 */
import type { StreetSceneFieldOfView, StreetSceneViewpoint } from '@goway.to/sdk';

import type { Vec3 } from './types';

const DEG = Math.PI / 180;

export interface StepOptions {
  /** Widest angle between the look direction and a step, degrees. */
  maxAngleDegrees?: number;
  /** Nearer than this is "the same place", metres. */
  minDistanceMeters?: number;
  /** Farther than this is a jump across unobserved space, metres. */
  maxDistanceMeters?: number;
}

export const STEP_MAX_ANGLE_DEGREES = 45;
export const STEP_MIN_DISTANCE_METERS = 0.5;
export const STEP_MAX_DISTANCE_METERS = 6;
/** Guided pitch limit: enough to look at a facade, not at the unobserved sky or ground. */
export const GUIDED_MAX_PITCH_DEGREES = 35;
/** How far the ground is below a viewpoint (a hand-held camera's height). */
export const VIEWPOINT_HEIGHT_METERS = 1.6;
/** Glide duration between viewpoints. */
export const STEP_DURATION_MS = 400;
/** Horizontal view may exceed the captured horizontal FOV by this factor before it is masked. */
export const HORIZONTAL_FOV_SLACK = 1.3;
/** Vertical FOV when a manifest publishes none. */
export const DEFAULT_VERTICAL_FOV_DEGREES = 60;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** `v` with its component along `up` removed: the part that moves you over the ground. */
export function horizontal(v: Vec3, up: Vec3): Vec3 {
  return sub(v, scale(up, dot(v, up)));
}

/** The viewpoint nearest `position`, or `-1` for none. */
export function nearestViewpoint(
  viewpoints: readonly StreetSceneViewpoint[],
  position: Vec3,
): number {
  let best = -1;
  let bestDistance = Infinity;
  viewpoints.forEach((viewpoint, index) => {
    const d = sub(viewpoint.position, position);
    const distance = dot(d, d);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

export interface StepCandidate {
  index: number;
  /** Horizontal distance, metres. */
  distance: number;
  /** Angle from the requested direction, radians. */
  angle: number;
}

interface GroundOffset {
  index: number;
  distance: number;
  offset: Vec3;
}

/** Every viewpoint a step from `from` may land on, in any direction. */
export function stepCandidates(
  viewpoints: readonly StreetSceneViewpoint[],
  from: number,
  up: Vec3,
  options: StepOptions = {},
): GroundOffset[] {
  const min = options.minDistanceMeters ?? STEP_MIN_DISTANCE_METERS;
  const max = options.maxDistanceMeters ?? STEP_MAX_DISTANCE_METERS;
  const origin = viewpoints[from]?.position;
  if (!origin) return [];
  const result: GroundOffset[] = [];
  viewpoints.forEach((viewpoint, index) => {
    if (index === from) return;
    const offset = horizontal(sub(viewpoint.position, origin), up);
    const distance = Math.hypot(offset[0], offset[1], offset[2]);
    if (distance >= min && distance <= max) result.push({ index, distance, offset });
  });
  return result;
}

/**
 * The viewpoint a step in `direction` lands on, or `null` when there is none
 * within the cone.
 *
 * Prefers small angles over short distances, but not absolutely: a viewpoint
 * 1 m away at 30° beats one 5 m away dead ahead, because Street View's arrow
 * goes to the next PLACE along the street, not the farthest one in line.
 */
export function nextViewpoint(
  viewpoints: readonly StreetSceneViewpoint[],
  from: number,
  direction: Vec3,
  up: Vec3,
  options: StepOptions = {},
): StepCandidate | null {
  const maxAngle = (options.maxAngleDegrees ?? STEP_MAX_ANGLE_DEGREES) * DEG;
  const wanted = horizontal(direction, up);
  const wantedLength = Math.hypot(wanted[0], wanted[1], wanted[2]);
  if (!(wantedLength > 1e-9)) return null;

  let best: StepCandidate | null = null;
  let bestScore = Infinity;
  for (const candidate of stepCandidates(viewpoints, from, up, options)) {
    const cos = dot(candidate.offset, wanted) / (candidate.distance * wantedLength);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (angle > maxAngle) continue;
    const score = candidate.distance * (1 + 2 * (angle / maxAngle));
    if (score < bestScore) {
      bestScore = score;
      best = { index: candidate.index, distance: candidate.distance, angle };
    }
  }
  return best;
}

/**
 * The "next step" markers to offer from `from`: the best viewpoint per
 * direction sector, so a dense capture shows a few chevrons, not a carpet.
 */
export function reachableViewpoints(
  viewpoints: readonly StreetSceneViewpoint[],
  from: number,
  up: Vec3,
  { sectors = 8, ...options }: StepOptions & { sectors?: number } = {},
): number[] {
  const candidates = stepCandidates(viewpoints, from, up, options);
  if (candidates.length === 0) return [];
  // Sector angles measured in the ground plane, from any fixed horizontal axis.
  const axisX = horizontal(Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], up);
  const lengthX = Math.hypot(axisX[0], axisX[1], axisX[2]);
  const ex = scale(axisX, 1 / lengthX);
  const ey: Vec3 = [
    up[1] * ex[2] - up[2] * ex[1],
    up[2] * ex[0] - up[0] * ex[2],
    up[0] * ex[1] - up[1] * ex[0],
  ];
  const best = new Map<number, { index: number; distance: number }>();
  for (const candidate of candidates) {
    const angle = Math.atan2(dot(candidate.offset, ey), dot(candidate.offset, ex));
    const sector = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * sectors) % sectors;
    const current = best.get(sector);
    if (!current || candidate.distance < current.distance) best.set(sector, candidate);
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance).map((entry) => entry.index);
}

/** Clamp a pitch (radians) to ± `maxDegrees`. */
export function clampPitch(pitch: number, maxDegrees: number = GUIDED_MAX_PITCH_DEGREES): number {
  const max = maxDegrees * DEG;
  return Math.max(-max, Math.min(max, pitch));
}

export interface ViewFrustum {
  /** The camera's vertical field of view, degrees. */
  verticalDegrees: number;
  /** The horizontal field of view that results at this aspect, degrees. */
  horizontalDegrees: number;
  /**
   * Fraction of the screen width to darken on EACH side, 0–0.5: the part of a
   * wide screen beyond what the capture saw (× {@link HORIZONTAL_FOV_SLACK}).
   */
  sideMask: number;
}

/**
 * The camera FOV for a screen `aspect` (width / height), from the captured
 * field of view.
 *
 * The vertical FOV is the captured one (narrowed further by `zoom` ≤ 1). The
 * horizontal FOV then follows from the aspect; where it exceeds the captured
 * horizontal FOV × 1.3 — a portrait capture on a landscape screen — the sides
 * are masked rather than the view widened into space nobody photographed.
 */
export function viewFrustum(
  aspect: number,
  captured: StreetSceneFieldOfView | undefined,
  zoom = 1,
): ViewFrustum {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const z = Math.max(0.3, Math.min(1, Number.isFinite(zoom) ? zoom : 1));
  const baseVertical = captured
    ? Math.max(20, Math.min(100, captured.verticalDegrees))
    : DEFAULT_VERTICAL_FOV_DEGREES;
  const verticalDegrees = baseVertical * z;
  const halfV = (verticalDegrees * DEG) / 2;
  const horizontalDegrees = (2 * Math.atan(Math.tan(halfV) * safeAspect)) / DEG;
  if (!captured) return { verticalDegrees, horizontalDegrees, sideMask: 0 };

  const allowed = Math.min(179, captured.horizontalDegrees * HORIZONTAL_FOV_SLACK);
  if (horizontalDegrees <= allowed) return { verticalDegrees, horizontalDegrees, sideMask: 0 };
  const visible = Math.tan((allowed * DEG) / 2) / Math.tan((horizontalDegrees * DEG) / 2);
  return {
    verticalDegrees,
    horizontalDegrees,
    sideMask: Math.max(0, Math.min(0.5, (1 - visible) / 2)),
  };
}

/** Ease-in-out (cubic): no lurch at either end of a glide. */
export function easeInOut(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Linear interpolation of two points. */
export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
