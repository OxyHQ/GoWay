/**
 * Which way was down while a guided recording ran, as the phone measured it.
 *
 * Pure, so the arithmetic is tested once; `motionSensor.ts` feeds it from
 * `expo-sensors`. What it produces is the contract's `motion` — gravity as a
 * unit vector in the DEVICE's axes (x to the right of the screen, y to its
 * top, z out of it), at seconds since the recording started, plus how the
 * recorded picture is turned. GoWay's reconstruction uses it to tell up from
 * down (`docs/STREET3D_MOTION_PRIORS.md`). It is not a position: no
 * coordinate, no compass heading and no acceleration leave the phone.
 *
 * Gravity is `accelerationIncludingGravity − acceleration`. On iOS that
 * difference is exactly Core Motion's fused gravity vector; on Android it is
 * the platform's gravity sensor, with the sign `expo-sensors` gives both
 * platforms (pointing DOWN). Readings are averaged into
 * {@link MOTION_WINDOW_SECONDS} windows — a walking phone sways, and the
 * keyframes a reconstruction uses are half a second apart at the closest.
 */
import {
  MAX_CAPTURE_MOTION_SAMPLES,
  type CaptureMotionInput,
  type CaptureMotionOrientation,
  type CaptureMotionSample,
} from '@goway.to/sdk';

/** One averaged sample per window: four a second. */
export const MOTION_WINDOW_SECONDS = 0.25;
/** Standard gravity, m/s². */
const G = 9.80665;
/**
 * A reading whose gravity is further than this from 1 g is not a gravity
 * estimate (a sensor still settling, or a value from the wrong field).
 */
const GRAVITY_TOLERANCE = 0.2;

export type Vector3 = [number, number, number];

/** The fields of an `expo-sensors` DeviceMotion measurement this reads. */
export interface MotionReading {
  acceleration?: { x: number; y: number; z: number } | null;
  accelerationIncludingGravity?: { x: number; y: number; z: number } | null;
}

/** Gravity in device axes as a unit vector pointing down, or null for an unusable reading. */
export function gravityOf(reading: MotionReading): Vector3 | null {
  const total = reading.accelerationIncludingGravity;
  const user = reading.acceleration;
  if (!total || !user) return null;
  const g: Vector3 = [total.x - user.x, total.y - user.y, total.z - user.z];
  const length = Math.hypot(...g);
  if (!Number.isFinite(length) || Math.abs(length / G - 1) > GRAVITY_TOLERANCE) return null;
  return [g[0] / length, g[1] / length, g[2] / length];
}

/**
 * How the recorded picture is turned.
 *
 * iOS: `expo-camera` records in the orientation its own motion check last
 * reported (`onResponsiveOrientationChanged`), portrait until it has reported
 * one. Android: the recorder follows the DISPLAY, and the app is locked to
 * portrait, so the picture is always the device's natural orientation —
 * turned sideways if the phone was, which the gravity then says.
 */
export function recordingOrientation(
  os: string,
  cameraOrientation: CaptureMotionOrientation | null,
): CaptureMotionOrientation {
  return os === 'ios' ? (cameraOrientation ?? 'portrait') : 'portrait';
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** Averages readings into windows; `finish()` is the contract's `motion`, or undefined. */
export class MotionTrackBuilder {
  private readonly samples: CaptureMotionSample[] = [];
  private window = -1;
  private sum: Vector3 = [0, 0, 0];
  private seconds = 0;
  private count = 0;

  constructor(private readonly orientation: CaptureMotionOrientation) {}

  /** A reading taken `t` seconds after the recording started. */
  add(t: number, reading: MotionReading): void {
    if (!Number.isFinite(t) || t < 0) return;
    const gravity = gravityOf(reading);
    if (!gravity) return;
    const window = Math.floor(t / MOTION_WINDOW_SECONDS);
    if (window < this.window) return; // late delivery: time only moves forward
    if (window !== this.window) {
      this.flush();
      this.window = window;
    }
    this.sum = [this.sum[0] + gravity[0], this.sum[1] + gravity[1], this.sum[2] + gravity[2]];
    this.seconds += t;
    this.count += 1;
  }

  finish(): CaptureMotionInput | undefined {
    this.flush();
    return this.samples.length > 0
      ? { orientation: this.orientation, samples: [...this.samples] }
      : undefined;
  }

  private flush(): void {
    if (this.count === 0) return;
    const length = Math.hypot(...this.sum);
    const t = round(this.seconds / this.count, 3);
    const previous = this.samples[this.samples.length - 1];
    if (
      length > 1e-6 &&
      this.samples.length < MAX_CAPTURE_MOTION_SAMPLES &&
      (previous === undefined || t > previous.t)
    ) {
      this.samples.push({
        t,
        gravity: [
          round(this.sum[0] / length, 4),
          round(this.sum[1] / length, 4),
          round(this.sum[2] / length, 4),
        ],
      });
    }
    this.sum = [0, 0, 0];
    this.seconds = 0;
    this.count = 0;
  }
}
