/**
 * The viewer's camera, as plain maths.
 *
 * Two modes over one state, because a street wants both: ORBIT to look at a
 * facade from around it, WALK to stand in the street and look along it. The
 * state is a yaw/pitch direction in a basis built from the scene's own up
 * vector — splat frames are rarely Y-up, and a rig that assumed it would roll
 * the street onto its side.
 *
 * No three.js: positions are `[x, y, z]` and the engine copies them into its
 * camera each frame, so this is tested in isolation. What the engine calls per
 * frame or per pointer move (`look`, `placeAt`, `pose(out)`, `direction(out)`,
 * `walkAxes`) works in place and allocates nothing.
 */
import type { SceneViewerControlMode, Vec3 } from './types';

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};

/** Never look exactly straight up or down: the basis degenerates there. */
export const MAX_PITCH = (85 * Math.PI) / 180;
export const MIN_ORBIT_DISTANCE = 1;
export const MAX_ORBIT_DISTANCE = 400;

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

export interface CameraRig {
  readonly mode: SceneViewerControlMode;
  setMode(mode: SceneViewerControlMode): void;
  /** Turn the view by radians (positive yaw turns right, positive pitch looks up). */
  look(deltaYaw: number, deltaPitch: number): void;
  /** Move in metres along the horizontal forward, right, and world up. */
  move(forward: number, right: number, up: number): void;
  /** Dolly: >1 moves away (orbit) or backwards (walk); <1 the opposite. */
  zoom(factor: number): void;
  /** Slide the view sideways and vertically, in metres. */
  pan(right: number, up: number): void;
  /** The pose, written into `out` when given. */
  pose(out?: CameraPose): CameraPose;
  reset(): void;
  /** The current view direction (unit), written into `out` when given. */
  direction(out?: Vec3): Vec3;
  /** The horizontal forward and right (unit) that walking moves along, written in place. */
  walkAxes(forward: Vec3, right: Vec3): void;
  /** Stand at `position`, keeping the view direction (guided navigation). */
  placeAt(position: Vec3): void;
  /** Face `direction` (any length), keeping the position. */
  lookToward(direction: Vec3): void;
  /** Limit pitch to ± `radians` (re-clamps the current pitch). */
  setPitchLimit(radians: number): void;
}

export function createCameraRig(initial: { position: Vec3; target: Vec3; up: Vec3 }): CameraRig {
  const up = unit(initial.up);
  const toTarget0 = sub(initial.target, initial.position);
  // The horizontal forward the yaw is measured from: the initial view's own
  // direction, flattened onto the ground plane. Fall back to any horizontal
  // axis when the initial view looks straight down.
  let forward0 = sub(toTarget0, scale(up, dot(toTarget0, up)));
  if (length(forward0) < 1e-6) forward0 = cross(up, Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const F = unit(forward0);
  const R = unit(cross(F, up));

  let mode: SceneViewerControlMode = 'orbit';
  let pitchLimit = MAX_PITCH;
  let yaw = 0;
  let pitch = 0;
  let distance = 0;
  const target: Vec3 = [0, 0, 0];
  const position: Vec3 = [0, 0, 0];

  function direction(out: Vec3 = [0, 0, 0]): Vec3 {
    const cy = Math.cos(yaw) * Math.cos(pitch);
    const sy = Math.sin(yaw) * Math.cos(pitch);
    const sp = Math.sin(pitch);
    for (let i = 0; i < 3; i++) out[i] = F[i] * cy + R[i] * sy + up[i] * sp;
    return out;
  }
  function walkAxes(forward: Vec3, right: Vec3) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (let i = 0; i < 3; i++) {
      forward[i] = F[i] * c + R[i] * s;
      right[i] = -F[i] * s + R[i] * c;
    }
  }
  const ahead: Vec3 = [0, 0, 0];
  const aside: Vec3 = [0, 0, 0];
  const look: Vec3 = [0, 0, 0];
  /** `position` (orbit) or `target` (walk) from the other, the direction and distance. */
  function sync() {
    direction(look);
    if (mode === 'orbit') for (let i = 0; i < 3; i++) position[i] = target[i] - look[i] * distance;
    else for (let i = 0; i < 3; i++) target[i] = position[i] + look[i] * distance;
  }
  function translate(delta: Vec3) {
    for (let i = 0; i < 3; i++) {
      position[i] += delta[i];
      target[i] += delta[i];
    }
  }

  function reset() {
    const offset = sub(initial.target, initial.position);
    distance = Math.max(MIN_ORBIT_DISTANCE, length(offset));
    const dir = unit(offset);
    pitch = Math.max(
      -MAX_PITCH,
      Math.min(MAX_PITCH, Math.asin(Math.max(-1, Math.min(1, dot(dir, up))))),
    );
    yaw = Math.atan2(dot(dir, R), dot(dir, F));
    for (let i = 0; i < 3; i++) target[i] = initial.target[i];
  }
  reset();

  // The camera position is DERIVED in both modes: orbit keeps the target and
  // distance, walk keeps the position. Switching modes keeps the view.
  sync();

  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next;
    },
    look(deltaYaw, deltaPitch) {
      yaw += deltaYaw;
      pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch + deltaPitch));
      sync();
    },
    move(forwardMeters, rightMeters, upMeters) {
      walkAxes(ahead, aside);
      translate(
        add(add(scale(ahead, forwardMeters), scale(aside, rightMeters)), scale(up, upMeters)),
      );
    },
    zoom(factor) {
      if (!(factor > 0) || !Number.isFinite(factor)) return;
      if (mode === 'orbit') {
        distance = Math.max(MIN_ORBIT_DISTANCE, Math.min(MAX_ORBIT_DISTANCE, distance * factor));
        sync();
      } else {
        // Walking, a pinch or a wheel step moves you along the view.
        translate(scale(direction(), (factor - 1) * -10));
      }
    },
    pan(rightMeters, upMeters) {
      walkAxes(ahead, aside);
      translate(add(scale(aside, rightMeters), scale(up, upMeters)));
    },
    pose(out) {
      if (!out) return { position: [...position], target: [...target], up: [...up] };
      for (let i = 0; i < 3; i++) {
        out.position[i] = position[i];
        out.target[i] = target[i];
        out.up[i] = up[i];
      }
      return out;
    },
    reset() {
      reset();
      pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
      direction(look);
      for (let i = 0; i < 3; i++) position[i] = target[i] - look[i] * distance;
    },
    direction(out) {
      return direction(out);
    },
    walkAxes,
    placeAt(next) {
      direction(look);
      for (let i = 0; i < 3; i++) {
        position[i] = next[i];
        target[i] = next[i] + look[i] * distance;
      }
    },
    lookToward(dir) {
      const d = unit(dir);
      if (length(d) === 0) return;
      pitch = Math.max(
        -pitchLimit,
        Math.min(pitchLimit, Math.asin(Math.max(-1, Math.min(1, dot(d, up))))),
      );
      yaw = Math.atan2(dot(d, R), dot(d, F));
      sync();
    },
    setPitchLimit(radians) {
      pitchLimit = Math.max(0, Math.min(MAX_PITCH, radians));
      pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
      sync();
    },
  };
}
