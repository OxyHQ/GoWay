/**
 * Sample the phone's gravity for the length of a guided recording.
 *
 * `expo-sensors` DeviceMotion is Core Motion's device motion on iOS and the
 * platform's fused sensors on Android. Neither asks the user anything:
 * reading device motion needs no permission, and this never calls
 * `DeviceMotion.requestPermissionsAsync()` — that asks for the pedometer
 * (iOS "Motion & Fitness", Android "Physical activity"), which GoWay does not
 * use. It starts when the contributor taps Start and stops with the recorder,
 * so nothing is sampled while the app is merely open.
 *
 * Only the native guided camera uses it. A browser exposes `devicemotion` with
 * engine-specific signs and a permission prompt on iOS, and a desktop has no
 * sensor at all; the web recorder sends no motion.
 */
import { DeviceMotion } from 'expo-sensors';
import type { CaptureMotionInput, CaptureMotionOrientation } from '@goway.to/sdk';
import { MotionTrackBuilder } from './motion';

/** 20 readings a second, averaged down to four by the builder. */
const UPDATE_INTERVAL_MS = 50;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface MotionCapture {
  /** Stop sampling; the track, or undefined when the sensor said nothing usable. Idempotent. */
  stop(): CaptureMotionInput | undefined;
}

/** Start sampling NOW: call it immediately before the recorder starts. */
export function startMotionCapture(orientation: CaptureMotionOrientation): MotionCapture {
  const builder = new MotionTrackBuilder(orientation);
  const startedAt = now();
  let subscription: { remove(): void } | null = null;
  try {
    DeviceMotion.setUpdateInterval(UPDATE_INTERVAL_MS);
    subscription = DeviceMotion.addListener((reading) =>
      builder.add((now() - startedAt) / 1000, reading),
    );
  } catch {
    // No sensor (or no native module): the recording simply carries no motion.
    subscription = null;
  }
  let stopped = false;
  let track: CaptureMotionInput | undefined;
  return {
    stop() {
      if (!stopped) {
        stopped = true;
        subscription?.remove();
        track = builder.finish();
      }
      return track;
    },
  };
}
