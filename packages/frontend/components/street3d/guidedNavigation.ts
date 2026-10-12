/**
 * Guided Walk over a scene that publishes where it was captured from.
 *
 * A Gaussian scene is trustworthy only from where it was observed: fly the
 * camera into a gap and the splats turn into shards and needles. So when a
 * manifest publishes `navigation`, the camera WALKS freely but only over the
 * observed ground (`walkableRegion.ts`), at the height it was captured from,
 * and its LOOK is free but bounded: pitch is clamped and the field of view
 * never exceeds what the source imagery covered, with the excess darkened
 * rather than drawn.
 *
 * Pure numbers, no renderer: the engine asks these questions every input and
 * every frame, and they are unit-tested here.
 */
import type { StreetSceneFieldOfView } from '@goway.to/sdk';

import type { Vec3 } from './types';

const DEG = Math.PI / 180;

/** Guided pitch limit: enough to look at a facade, not at the unobserved sky or ground. */
export const GUIDED_MAX_PITCH_DEGREES = 35;
/** A capture at least this tall vertically (a 360° rig) saw sky and ground too… */
export const TALL_CAPTURE_VERTICAL_DEGREES = 100;
/** …so its pitch may reach this far. */
export const TALL_CAPTURE_MAX_PITCH_DEGREES = 60;
/** How far the ground is below a capture position (a hand-held or pole camera's height). */
export const CAPTURE_HEIGHT_METERS = 1.6;
/** Walking pace, metres per second. */
export const WALK_SPEED_MPS = 1.4;
/** Shift: a run, metres per second. */
export const RUN_SPEED_MPS = 3.5;
/** A click glides at this average speed, metres per second… */
export const GLIDE_SPEED_MPS = 2.5;
/** …taking no less and no more than these, ms. */
export const GLIDE_MIN_MS = 350;
export const GLIDE_MAX_MS = 2500;
/** A click farther than this along the ground glides only this far toward it, metres. */
export const GO_MAX_METERS = 25;
/** Horizontal view may exceed the captured horizontal FOV by this factor before it is masked. */
export const HORIZONTAL_FOV_SLACK = 1.3;
/** Vertical FOV when a manifest publishes none. */
export const DEFAULT_VERTICAL_FOV_DEGREES = 60;
/** Thumbstick deflection for full speed, px. */
export const STICK_RADIUS_PX = 56;
/** Thumbstick deflection ignored as a resting thumb, px. */
export const STICK_DEAD_ZONE_PX = 8;

/** How far the view may pitch, degrees: further when the capture saw sky and ground. */
export function pitchLimitDegrees(captured: StreetSceneFieldOfView | undefined): number {
  return (captured?.verticalDegrees ?? 0) >= TALL_CAPTURE_VERTICAL_DEGREES
    ? TALL_CAPTURE_MAX_PITCH_DEGREES
    : GUIDED_MAX_PITCH_DEGREES;
}

/**
 * Where a ray from `origin` along `direction` meets the ground plane at
 * `groundHeight` (a coordinate along unit `up`), written into `out`; capped at
 * {@link GO_MAX_METERS} along the ground. `false` when the ray never comes
 * down to it (the sky, the horizon).
 */
export function groundHit(
  origin: Vec3,
  direction: Vec3,
  up: Vec3,
  groundHeight: number,
  out: Vec3,
): boolean {
  const fall = direction[0] * up[0] + direction[1] * up[1] + direction[2] * up[2];
  const above = origin[0] * up[0] + origin[1] * up[1] + origin[2] * up[2] - groundHeight;
  if (!(fall < -1e-6) || !(above > 0)) return false;
  let t = above / -fall;
  // The run along the ground, without the drop.
  const along = Math.sqrt(
    Math.max(0, direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2 - fall * fall),
  );
  if (along * t > GO_MAX_METERS) t = GO_MAX_METERS / along;
  out[0] = origin[0] + direction[0] * t;
  out[1] = origin[1] + direction[1] * t;
  out[2] = origin[2] + direction[2] * t;
  return true;
}

/** How long a glide over `meters` takes, ms: proportional, within bounds. */
export function glideDurationMs(meters: number): number {
  return Math.max(GLIDE_MIN_MS, Math.min(GLIDE_MAX_MS, (meters / GLIDE_SPEED_MPS) * 1000));
}

/**
 * A thumbstick deflection (screen px, y down) as walking input: `forward` and
 * `right` in −1…1, zero inside the dead zone, full past
 * {@link STICK_RADIUS_PX}, and proportional between — a light thumb strolls.
 * Written into `out` as `[forward, right]`.
 */
export function stickInput(dx: number, dy: number, out: [number, number]): [number, number] {
  const length = Math.hypot(dx, dy);
  if (!(length > STICK_DEAD_ZONE_PX)) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const strength =
    Math.min(STICK_RADIUS_PX, length - STICK_DEAD_ZONE_PX) / (STICK_RADIUS_PX - STICK_DEAD_ZONE_PX);
  const k = Math.min(1, strength) / length;
  out[0] = -dy * k;
  out[1] = dx * k;
  return out;
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
