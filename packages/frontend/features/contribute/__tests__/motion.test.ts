import { describe, expect, it } from 'bun:test';
import {
  createGoWayClient,
  GoWayValidationError,
  MAX_CAPTURE_MOTION_SAMPLES,
  type CaptureAssetInput,
} from '@goway.to/sdk';
import {
  gravityOf,
  MOTION_WINDOW_SECONDS,
  MotionTrackBuilder,
  recordingOrientation,
  type MotionReading,
} from '../guided/motion';

const G = 9.80665;

/** What expo-sensors reports for a phone whose gravity points along `down`, while it is jolted by `user`. */
function reading(down: [number, number, number], user: [number, number, number] = [0, 0, 0]) {
  return {
    acceleration: { x: user[0], y: user[1], z: user[2] },
    accelerationIncludingGravity: {
      x: user[0] + down[0] * G,
      y: user[1] + down[1] * G,
      z: user[2] + down[2] * G,
    },
  } satisfies MotionReading;
}

describe('gravity from a DeviceMotion reading', () => {
  it('is the part of the acceleration the contributor did not cause, as a unit vector', () => {
    const upright = gravityOf(reading([0, -1, 0], [1.2, -0.7, 2.5]));
    expect(upright).toEqual([0, -1, 0]);
    const tilted = gravityOf(reading([0.6, -0.8, 0]));
    expect(tilted?.[0]).toBeCloseTo(0.6, 9);
    expect(tilted?.[1]).toBeCloseTo(-0.8, 9);
  });

  it('refuses a reading that is not about 1 g, or is missing a half', () => {
    expect(gravityOf({ ...reading([0, -1, 0]), acceleration: null })).toBeNull();
    expect(gravityOf({ acceleration: { x: 0, y: 0, z: 0 } })).toBeNull();
    const weak = reading([0, -0.5, 0]);
    expect(gravityOf(weak)).toBeNull();
  });
});

describe('the recording orientation', () => {
  it('follows the camera on iOS and the portrait-locked display on Android', () => {
    expect(recordingOrientation('ios', 'landscapeLeft')).toBe('landscapeLeft');
    expect(recordingOrientation('ios', null)).toBe('portrait');
    expect(recordingOrientation('android', 'landscapeLeft')).toBe('portrait');
  });
});

describe('the motion track', () => {
  it('averages readings into quarter-second samples in time order', () => {
    const builder = new MotionTrackBuilder('portrait');
    builder.add(0.01, reading([0, -1, 0]));
    builder.add(0.1, reading([0.2, -0.98, 0]));
    builder.add(0.3, reading([0, -1, 0]));
    builder.add(0.2, reading([1, 0, 0])); // late: an earlier window is already closed
    builder.add(0.31, reading([0, -0.2, 0])); // not 1 g: ignored
    const track = builder.finish();
    expect(track?.orientation).toBe('portrait');
    expect(track?.samples.map((sample) => sample.t)).toEqual([0.055, 0.3]);
    const [first] = track?.samples ?? [];
    expect(first?.gravity[0]).toBeGreaterThan(0.09);
    expect(first?.gravity[0]).toBeLessThan(0.11);
    expect(Math.hypot(...(first?.gravity ?? [0, 0, 0]))).toBeCloseTo(1, 3);
  });

  it('is undefined when the sensor said nothing usable', () => {
    expect(new MotionTrackBuilder('portrait').finish()).toBeUndefined();
  });

  it('stops at the contract bound and is accepted by the SDK as a registration body', async () => {
    const builder = new MotionTrackBuilder('landscapeRight');
    const windows = MAX_CAPTURE_MOTION_SAMPLES + 50;
    for (let w = 0; w < windows; w += 1)
      builder.add((w + 0.5) * MOTION_WINDOW_SECONDS, reading([0.0123, -0.9921, -0.1245]));
    const motion = builder.finish();
    expect(motion?.samples).toHaveLength(MAX_CAPTURE_MOTION_SAMPLES);

    const calls: unknown[] = [];
    const client = createGoWayClient({
      apiBaseUrl: 'https://api.example.test',
      fetch: async (url) => {
        calls.push(url);
        return new Response('{}', { status: 503 });
      },
    });
    const input: CaptureAssetInput = {
      mediaKind: 'video',
      source: 'guided_session',
      contentHash: 'a'.repeat(64),
      byteSize: 42,
      contentType: 'video/mp4',
      location: [{ origin: 'device_capture', coordinate: { latitude: 41, longitude: 2 } }],
      ...(motion ? { motion } : {}),
    };
    const outcome = await client.captures.register('s', input).catch((error: unknown) => error);
    expect(outcome).not.toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(1);
  });
});
