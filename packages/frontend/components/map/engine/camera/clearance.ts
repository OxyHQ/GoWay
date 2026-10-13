/**
 * The camera never inside a building or under the ground.
 *
 * The camera moves freely; what it may not do is put the EYE inside a
 * building it draws (the walls vanish, or slice through the view) or under
 * the ground. When a gesture or an animation asks for such a camera, this
 * rule raises the eye just enough to clear what is there, keeping:
 *
 *  - the CENTRE (what is under the finger, what a tour looks at),
 *  - the BEARING (a rotation always turns), and
 *  - the eye's position over the ground —
 *
 * and lowering only the pitch and the zoom: the eye goes up over the roof,
 * still looking at the same point. It is the rule MapLibre already applies
 * to its own terrain (`Camera._elevateCameraIfInsideTerrain`: "the same
 * ground position but at higher altitude, still pointing to the same
 * spot"), extended to the buildings, so terrain and buildings hold the eye
 * the same way. Why this and not stopping the gesture at the wall:
 * `docs/MAP_CAMERA_CLEARANCE.md` → Decision.
 *
 * ## Smooth by construction
 *
 * What the eye must clear is a continuous field: every building asks for its
 * top plus a margin over and beside its footprint, falling off at
 * {@link CAMERA_CLEARANCE.slope} past the margin (`volumes.ts` →
 * `prismRequirement`). So a camera that moves a little is corrected a
 * little — no snap at a wall — and the correction is a pure function of the
 * camera asked for: nothing to oscillate. The host keeps the camera ASKED
 * for apart from the one drawn while a gesture lasts (MapLibre's
 * `transformCameraUpdate`), so the gesture is never fought: rotate past a
 * tower and the eye rises over it and comes back down to exactly where the
 * gesture put it.
 *
 * The one thing the field cannot make smooth is DATA arriving: a tile (or a
 * landmark) appearing under the eye changes the field where the eye is.
 * {@link createCameraClearance} lets the part of a change that motion
 * explains through at once and eases the rest in over
 * {@link CAMERA_CLEARANCE.settleMs}; a still camera is eased by its host.
 *
 * Platform-neutral: no DOM, no WebGL, no map engine. The web host is
 * `components/map/cameraClearance.web.ts`; what native lacks is in the note.
 */
import { EARTH_CIRCUMFERENCE_M, metersPerPixel } from '@/lib/map/geo';

import type { Clearance } from './volumes';

export const CAMERA_CLEARANCE = {
  /**
   * Metres the required height falls per metre past a building's margin (a
   * 63° ramp). Steeper lets the eye nearer a wall below its roof; gentler
   * lifts it more slowly as a rotation sweeps it towards one. At 2, a 25 m
   * Eixample building leaves the eye alone 14 m out at street level.
   */
  slope: 2,
  /** Least clearance over a roof, beside a wall and over the ground, metres. */
  minMarginM: 2,
  /**
   * The margin is at least this many near-plane distances, so the near plane
   * (whose corners reach further than its centre) never cuts a wall the eye
   * clears.
   */
  nearPlanes: 1.5,
  /** Data arriving under the eye lifts it with this time constant, ms. */
  settleMs: 120,
  /** The longest frame gap counted towards that settling, ms. */
  maxStepMs: 100,
  /**
   * Below this zoom nothing the city draws is near the eye (buildings start
   * at z15.5), and the rule is not run. So a camera opened from a link
   * (`loadedCamera.ts`, #191: the canvas reports the camera a map opened at,
   * unprompted) is the one drawn below it; above it, a deep link into a tower
   * is lifted on its first update and that is what is reported.
   */
  minZoom: 13,
  /** An eye this far from the last one, metres, has jumped: corrected exactly. */
  jumpM: 2000,
} as const;

/** A height field over mercator `[0, 1]²`: what the drawn buildings ask of an eye. */
export interface ClearanceField {
  /** Changes whenever the answers may have (a tile or landmark drawn or dropped, the ground). */
  readonly version: number;
  /**
   * The height (metres, absolute, as drawn) an eye at mercator `(x, y)` must
   * reach to clear every building drawn there, or `floor` when none asks more.
   */
  requiredHeight(x: number, y: number, clearance: Clearance, floor: number): number;
}

/** The drawn ground at a mercator point, metres (0 on a flat map). */
export type GroundAt = (x: number, y: number) => number;

/** A camera, as every web-mercator host has it. */
export interface CameraPose {
  /** The point looked at, mercator `[0, 1]`, and its latitude. */
  centerX: number;
  centerY: number;
  centerLatitude: number;
  /** The ground under the centre, metres (the point the camera orbits). */
  centerElevationM: number;
  zoom: number;
  /** Degrees from straight down. */
  pitch: number;
  /** Degrees clockwise from north. */
  bearing: number;
  /** Eye to centre, metres. */
  distanceM: number;
  /** Eye to near plane, metres. */
  nearM: number;
}

/** Where a pose's eye is. */
export interface Eye {
  x: number;
  y: number;
  altitudeM: number;
  /** Over the ground, from the eye to the centre, metres. */
  horizontalM: number;
}

const DEG = Math.PI / 180;

/** Mercator units per metre at a latitude. */
function mercatorPerMetre(latitude: number): number {
  return 1 / (EARTH_CIRCUMFERENCE_M * Math.cos(latitude * DEG));
}

/**
 * Eye to centre, metres, for a perspective camera on 512-px Web Mercator
 * tiles: the screen's half height over the tangent of half the vertical field
 * of view, in pixels, at the zoom's metres per pixel.
 */
export function cameraDistanceM(
  zoom: number,
  latitude: number,
  fovDeg: number,
  heightPx: number,
): number {
  return ((0.5 * heightPx) / Math.tan((fovDeg * DEG) / 2)) * metersPerPixel(latitude, zoom);
}

/** The eye of a pose: behind the centre along the bearing, up by the pitch. */
export function eyeOf(pose: CameraPose): Eye {
  const pitch = pose.pitch * DEG;
  const bearing = pose.bearing * DEG;
  const horizontalM = pose.distanceM * Math.sin(pitch);
  const k = mercatorPerMetre(pose.centerLatitude);
  return {
    x: pose.centerX - horizontalM * Math.sin(bearing) * k,
    // Mercator y runs south; the eye is behind, i.e. south of a north-facing view.
    y: pose.centerY + horizontalM * Math.cos(bearing) * k,
    altitudeM: pose.centerElevationM + pose.distanceM * Math.cos(pitch),
    horizontalM,
  };
}

/**
 * The pose with its eye at `altitudeM`, over the same ground and looking at
 * the same centre: a lower pitch and a lower zoom, nothing else.
 */
export function liftedPose(pose: CameraPose, altitudeM: number): { pitch: number; zoom: number } {
  const eye = eyeOf(pose);
  const up = Math.max(1e-3, altitudeM - pose.centerElevationM);
  const distanceM = Math.hypot(eye.horizontalM, up);
  return {
    pitch: Math.atan2(eye.horizontalM, up) / DEG,
    zoom: pose.zoom - Math.log2(distanceM / pose.distanceM),
  };
}

/** The pose a correction draws (the same pose for none). */
export function applyCorrection(pose: CameraPose, correction: Correction): CameraPose {
  if (!correction) return pose;
  const scale = 2 ** (pose.zoom - correction.zoom);
  return {
    ...pose,
    pitch: correction.pitch,
    zoom: correction.zoom,
    distanceM: pose.distanceM * scale,
    nearM: pose.nearM * scale,
  };
}

/** What a pose's eye must clear, and the margin it was measured with. */
export interface Requirement {
  /** The least altitude the eye may have, metres (it may already be above it). */
  altitudeM: number;
  marginM: number;
}

/**
 * The altitude the eye must reach: the ground and every building, with a
 * margin of at least {@link CAMERA_CLEARANCE.nearPlanes} near planes — at the
 * camera's distance AFTER the lift, so applying the answer and asking again
 * gives the same answer (the near plane moves out with the eye; three rounds
 * converge to the centimetre).
 */
export function requirementFor(
  pose: CameraPose,
  field: ClearanceField | null,
  ground: GroundAt,
): Requirement {
  const eye = eyeOf(pose);
  const groundM = ground(eye.x, eye.y);
  const nearPerMetre = pose.nearM / pose.distanceM;
  let altitudeM = eye.altitudeM;
  let marginM: number = CAMERA_CLEARANCE.minMarginM;
  for (let round = 0; round < 3; round++) {
    const distanceM = Math.hypot(eye.horizontalM, altitudeM - pose.centerElevationM);
    marginM = Math.max(
      CAMERA_CLEARANCE.minMarginM,
      CAMERA_CLEARANCE.nearPlanes * nearPerMetre * distanceM,
    );
    const floor = groundM + marginM;
    const need = field
      ? field.requiredHeight(eye.x, eye.y, { marginM, slope: CAMERA_CLEARANCE.slope }, floor)
      : floor;
    const next = Math.max(need, eye.altitudeM);
    if (Math.abs(next - altitudeM) < 0.01) {
      altitudeM = next;
      break;
    }
    altitudeM = next;
  }
  return { altitudeM, marginM };
}

/** How far a pose's eye must rise to clear what is there (0: it is clear). */
export function liftFor(pose: CameraPose, field: ClearanceField | null, ground: GroundAt): number {
  return Math.max(0, requirementFor(pose, field, ground).altitudeM - eyeOf(pose).altitudeM);
}

/**
 * The camera ASKED for, held at the surface on the two axes a gesture pushes
 * the eye into a building with: a zoom in or a tilt towards the horizon that
 * would raise the lift needed is taken back to where the gesture was the
 * update before (`previous`), so the camera asked for never runs ahead into
 * the building and reversing the pinch or the tilt answers at once — no dead
 * zone. The bearing is never held: a rotation still lifts the eye over a
 * tower and sets it back down. The host writes the answer back into the
 * camera its gesture accumulates (`cameraClearance.web.ts`).
 */
export function holdAtSurface(
  pose: CameraPose,
  previous: { zoom: number; pitch: number },
  field: ClearanceField | null,
  ground: GroundAt,
): { zoom: number; pitch: number } {
  let held = pose;
  if (pose.pitch > previous.pitch) {
    const back = applyCorrection(held, { pitch: previous.pitch, zoom: held.zoom });
    if (liftFor(held, field, ground) > liftFor(back, field, ground) + HOLD_EPSILON_M) held = back;
  }
  if (held.zoom > previous.zoom) {
    const back = applyCorrection(held, { pitch: held.pitch, zoom: previous.zoom });
    if (liftFor(held, field, ground) > liftFor(back, field, ground) + HOLD_EPSILON_M) held = back;
  }
  return { zoom: held.zoom, pitch: held.pitch };
}

/** A change of lift smaller than this, metres, is not a push into anything. */
const HOLD_EPSILON_M = 0.01;

/**
 * Whether the eye is INSIDE something: a building's prism (no margin, no
 * ramp) or the ground. What the browser check samples every frame; not what
 * the rule enforces, which is stricter.
 */
export function eyeInside(
  pose: CameraPose,
  field: ClearanceField | null,
  ground: GroundAt,
): { inside: boolean; depthM: number } {
  const eye = eyeOf(pose);
  const groundM = ground(eye.x, eye.y);
  const top = field
    ? field.requiredHeight(eye.x, eye.y, { marginM: 0, slope: Number.POSITIVE_INFINITY }, groundM)
    : groundM;
  return { inside: top > eye.altitudeM, depthM: Math.max(0, top - eye.altitudeM) };
}

/** The correction for one camera change, or `null` when the camera asked for is clear. */
export type Correction = { pitch: number; zoom: number } | null;

export interface CameraClearance {
  /**
   * The camera to draw for the camera asked for (`pose`), at time `now` (ms):
   * `null` to draw it as asked.
   */
  constrain(
    pose: CameraPose,
    field: ClearanceField | null,
    ground: GroundAt,
    now: number,
  ): Correction;
  /** The exact correction, with no settling: for a still camera (`null`: clear). */
  settle(pose: CameraPose, field: ClearanceField | null, ground: GroundAt): Correction;
  /** Forget the last camera: the next one is corrected exactly. */
  reset(): void;
}

/** How far the last corrected eye was lifted, and from where. */
interface Last {
  x: number;
  y: number;
  altitudeM: number;
  marginM: number;
  liftM: number;
  at: number;
}

export function createCameraClearance(): CameraClearance {
  let last: Last | null = null;
  const settle: CameraClearance['settle'] = (pose, field, ground) => {
    if (pose.zoom < CAMERA_CLEARANCE.minZoom) return null;
    const { altitudeM } = requirementFor(pose, field, ground);
    return altitudeM > eyeOf(pose).altitudeM + 0.01 ? liftedPose(pose, altitudeM) : null;
  };
  return {
    settle,
    reset() {
      last = null;
    },
    constrain(pose, field, ground, now) {
      if (pose.zoom < CAMERA_CLEARANCE.minZoom) {
        last = null;
        return null;
      }
      const eye = eyeOf(pose);
      const { altitudeM, marginM } = requirementFor(pose, field, ground);
      const target = altitudeM - eye.altitudeM;
      let liftM = target;
      if (last) {
        // A fixed field changes under a moving eye by at most its slope per
        // metre moved, plus what the eye's own height and margin changed:
        // that much of a change is the camera's motion and passes at once.
        // More is the field itself changing (a tile drawn or dropped under
        // the eye): eased in, never snapped.
        const metres =
          Math.hypot(eye.x - last.x, eye.y - last.y) / mercatorPerMetre(pose.centerLatitude);
        if (metres < CAMERA_CLEARANCE.jumpM) {
          const slope = CAMERA_CLEARANCE.slope + 1;
          const explained =
            slope * metres +
            Math.abs(eye.altitudeM - last.altitudeM) +
            slope * Math.abs(marginM - last.marginM);
          const change = target - last.liftM;
          if (Math.abs(change) > explained) {
            const dt = Math.min(CAMERA_CLEARANCE.maxStepMs, Math.max(0, now - last.at));
            const eased =
              (Math.abs(change) - explained) * (1 - Math.exp(-dt / CAMERA_CLEARANCE.settleMs));
            liftM = last.liftM + Math.sign(change) * (explained + eased);
          }
        }
      }
      last = { x: eye.x, y: eye.y, altitudeM: eye.altitudeM, marginM, liftM, at: now };
      return liftM > 0.01 ? liftedPose(pose, eye.altitudeM + liftM) : null;
    },
  };
}
