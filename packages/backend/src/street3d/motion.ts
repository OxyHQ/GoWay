/**
 * From a phone's motion track to one measured gravity per privacy-safe frame.
 *
 * A capture recorded in the app carries `motion`: gravity, as the phone's
 * sensor fusion measured it, at seconds since the recording started, in the
 * DEVICE's axes (x to the right of the screen, y to its top, z out of the
 * screen). The solve wants it per FRAME and in that frame's CAMERA axes (x
 * right, y down, z forward into the scene — the OpenCV/COLMAP convention), so
 * two things happen here, both pure:
 *
 * 1. **When.** A video's keyframes are chosen by the privacy worker, which
 *    reports each one's `timestampSeconds`; the measurement at that instant is
 *    interpolated between the two samples around it. A photo is the instant
 *    `t = 0`. A frame further than {@link MAX_EXTRAPOLATION_SECONDS} outside the
 *    track, or between two samples more than {@link MAX_SAMPLE_GAP_SECONDS}
 *    apart (the app was suspended), gets none.
 * 2. **Which axes.** The back camera looks along −z of the device, and the
 *    recorded picture is turned with the phone: `orientation` says how. A
 *    privacy-safe frame is cut from the picture as it is DISPLAYED, so its
 *    shape must agree — a portrait picture is taller than wide — or the whole
 *    capture's measurements are dropped rather than handed to the solve in the
 *    wrong axes.
 *
 * Nothing here fails a capture: a measurement is a prior, and no prior is the
 * state every capture before this one was in. Design note:
 * `docs/STREET3D_MOTION_PRIORS.md`.
 */

import type { CaptureMotionOrientation } from '@goway/contracts';

export type Vector3 = readonly [number, number, number];

/** A capture's motion track as it is stored: parallel arrays, in time order. */
export interface MotionTrack {
  orientation: CaptureMotionOrientation;
  sampleSeconds: readonly number[];
  gravityX: readonly number[];
  gravityY: readonly number[];
  gravityZ: readonly number[];
}

/** Two neighbouring samples further apart than this do not describe the time between them. */
export const MAX_SAMPLE_GAP_SECONDS = 2;
/** How far before the first sample or after the last one the nearest still counts. */
export const MAX_EXTRAPOLATION_SECONDS = 1;

function unit([x, y, z]: Vector3): Vector3 | null {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return [x / length, y / length, z / length];
}

/**
 * A device-axes vector in the camera axes of the picture as displayed.
 *
 * `portrait` is the identity turn: the picture's right is the device's +x and
 * its down the device's −y. `landscapeLeft` (top of the phone to the left) has
 * the device's +x pointing up the picture and its +y to the picture's left;
 * `landscapeRight` the reverse. Every case is a proper rotation.
 */
export function deviceToCamera([x, y, z]: Vector3, orientation: CaptureMotionOrientation): Vector3 {
  switch (orientation) {
    case 'portrait':
      return [x, -y, -z];
    case 'portraitUpsideDown':
      return [-x, y, -z];
    case 'landscapeLeft':
      return [-y, -x, -z];
    case 'landscapeRight':
      return [y, x, -z];
  }
}

/** Whether a picture of this shape can have been recorded in this orientation. */
export function pictureMatchesOrientation(
  orientation: CaptureMotionOrientation,
  width: number,
  height: number,
): boolean {
  const portrait = orientation === 'portrait' || orientation === 'portraitUpsideDown';
  return portrait ? height >= width : width >= height;
}

/** Gravity in device axes at `t` seconds, or null where the track does not say. */
export function gravityAt(track: MotionTrack, t: number): Vector3 | null {
  const times = track.sampleSeconds;
  const count = times.length;
  if (
    count === 0 ||
    track.gravityX.length !== count ||
    track.gravityY.length !== count ||
    track.gravityZ.length !== count ||
    !Number.isFinite(t)
  )
    return null;
  const sample = (i: number): Vector3 => [
    track.gravityX[i] as number,
    track.gravityY[i] as number,
    track.gravityZ[i] as number,
  ];
  const first = times[0] as number;
  const last = times[count - 1] as number;
  if (t <= first) return t >= first - MAX_EXTRAPOLATION_SECONDS ? unit(sample(0)) : null;
  if (t >= last) return t <= last + MAX_EXTRAPOLATION_SECONDS ? unit(sample(count - 1)) : null;
  // The first sample after `t`: binary search, the track can hold thousands.
  let low = 1;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((times[middle] as number) <= t) low = middle + 1;
    else high = middle;
  }
  const before = times[low - 1] as number;
  const after = times[low] as number;
  // A frame exactly at a sample is that sample, whatever gap follows it.
  if (t === before) return unit(sample(low - 1));
  if (after - before > MAX_SAMPLE_GAP_SECONDS) return null;
  const weight = (t - before) / (after - before);
  const a = sample(low - 1);
  const b = sample(low);
  return unit([
    a[0] + (b[0] - a[0]) * weight,
    a[1] + (b[1] - a[1]) * weight,
    a[2] + (b[2] - a[2]) * weight,
  ]);
}

/** One privacy-safe frame, as far as its gravity is concerned. */
export interface DerivedFrame {
  width: number;
  height: number;
  /** Seconds into a video; absent for a photo, which is the instant `t = 0`. */
  timestampSeconds?: number | undefined;
}

/**
 * The measured gravity of each frame, in its camera axes, or null.
 *
 * All or nothing per CAPTURE on the shape check: one capture has one
 * orientation, so a frame whose shape contradicts it says the whole track is
 * in axes this function would get wrong.
 */
export function framesGravity(
  track: MotionTrack | null | undefined,
  frames: readonly DerivedFrame[],
): (Vector3 | null)[] {
  if (!track) return frames.map(() => null);
  if (
    !frames.every((frame) =>
      pictureMatchesOrientation(track.orientation, frame.width, frame.height),
    )
  )
    return frames.map(() => null);
  return frames.map((frame) => {
    const device = gravityAt(track, frame.timestampSeconds ?? 0);
    return device ? unit(deviceToCamera(device, track.orientation)) : null;
  });
}
