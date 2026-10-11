/**
 * A phone's motion track becomes one gravity per privacy-safe frame, in that
 * frame's camera axes — or none, never a wrong one.
 */

import { describe, expect, it } from 'bun:test';
import { CAPTURE_MOTION_ORIENTATIONS } from '@goway/contracts';
import {
  deviceToCamera,
  framesGravity,
  gravityAt,
  MAX_EXTRAPOLATION_SECONDS,
  type MotionTrack,
  type Vector3,
} from '../motion';

const close = (actual: Vector3 | null | undefined, expected: Vector3, digits = 6) => {
  expect(actual).not.toBeNull();
  const [x, y, z] = actual as Vector3;
  expect(x).toBeCloseTo(expected[0], digits);
  expect(y).toBeCloseTo(expected[1], digits);
  expect(z).toBeCloseTo(expected[2], digits);
};

const degrees = (value: number) => (value * Math.PI) / 180;

function track(orientation: MotionTrack['orientation'], samples: [number, Vector3][]): MotionTrack {
  return {
    orientation,
    sampleSeconds: samples.map(([t]) => t),
    gravityX: samples.map(([, g]) => g[0]),
    gravityY: samples.map(([, g]) => g[1]),
    gravityZ: samples.map(([, g]) => g[2]),
  };
}

describe('device axes to camera axes', () => {
  it('puts gravity at the bottom of the picture for a level phone, however it is held', () => {
    // Held level, the device's DOWN is a different axis in each orientation.
    close(deviceToCamera([0, -1, 0], 'portrait'), [0, 1, 0]);
    close(deviceToCamera([0, 1, 0], 'portraitUpsideDown'), [0, 1, 0]);
    close(deviceToCamera([-1, 0, 0], 'landscapeLeft'), [0, 1, 0]); // top of the phone to the left
    close(deviceToCamera([1, 0, 0], 'landscapeRight'), [0, 1, 0]);
  });

  it('turns a phone pitched down at the street into gravity ahead of the camera', () => {
    // Top of the phone tipped away from the contributor by 30°: the back camera looks down.
    const device: Vector3 = [0, -Math.cos(degrees(30)), -Math.sin(degrees(30))];
    close(deviceToCamera(device, 'portrait'), [0, Math.cos(degrees(30)), Math.sin(degrees(30))]);
  });

  it('is a proper rotation in every orientation, never a reflection', () => {
    for (const orientation of CAPTURE_MOTION_ORIENTATIONS) {
      const ex = deviceToCamera([1, 0, 0], orientation);
      const ey = deviceToCamera([0, 1, 0], orientation);
      const ez = deviceToCamera([0, 0, 1], orientation);
      const determinant =
        ex[0] * (ey[1] * ez[2] - ey[2] * ez[1]) -
        ex[1] * (ey[0] * ez[2] - ey[2] * ez[0]) +
        ex[2] * (ey[0] * ez[1] - ey[1] * ez[0]);
      expect(determinant).toBe(1);
      // The back camera always looks out of the back of the phone.
      close(ez, [0, 0, -1]);
    }
  });
});

describe('gravity at an instant', () => {
  const tilted: Vector3 = [Math.sin(degrees(20)), -Math.cos(degrees(20)), 0];
  const walk = track('portrait', [
    [0, [0, -1, 0]],
    [0.25, [0, -1, 0]],
    [0.5, tilted],
    [3.0, [0, -1, 0]],
  ]);

  it('interpolates between the samples around it, as a direction', () => {
    const halfway = gravityAt(walk, 0.375);
    close(halfway, [Math.sin(degrees(10)), -Math.cos(degrees(10)), 0], 2);
    expect(Math.hypot(...(halfway as Vector3))).toBeCloseTo(1, 9);
    close(gravityAt(walk, 0.5), tilted);
  });

  it('extends the ends a little and no further', () => {
    close(gravityAt(walk, -0.5), [0, -1, 0]);
    close(gravityAt(walk, 3 + MAX_EXTRAPOLATION_SECONDS), [0, -1, 0]);
    expect(gravityAt(walk, -1.5)).toBeNull();
    expect(gravityAt(walk, 4.5)).toBeNull();
  });

  it('says nothing across a gap in the track or about a malformed one', () => {
    expect(gravityAt(walk, 1.5)).toBeNull(); // 0.5 → 3.0: the app was not sampling
    expect(gravityAt({ ...walk, gravityZ: [0] }, 0.1)).toBeNull();
    expect(gravityAt(walk, Number.NaN)).toBeNull();
  });
});

describe('gravity per privacy-safe frame', () => {
  const portrait = track('portrait', [
    [0, [0, -1, 0]],
    [1, [0, -Math.cos(degrees(30)), -Math.sin(degrees(30))]],
  ]);

  it('reads each keyframe at its own timestamp, and a photo at the instant it was taken', () => {
    const [video, photo] = [
      framesGravity(portrait, [{ width: 1080, height: 1920, timestampSeconds: 1 }]),
      framesGravity(portrait, [{ width: 1080, height: 1920 }]),
    ];
    close(video[0], [0, Math.cos(degrees(30)), Math.sin(degrees(30))]);
    close(photo[0], [0, 1, 0]);
  });

  it('drops the whole capture when a frame is the wrong shape for its orientation', () => {
    const frames = [
      { width: 1080, height: 1920, timestampSeconds: 0 },
      { width: 1920, height: 1080, timestampSeconds: 1 },
    ];
    expect(framesGravity(portrait, frames)).toEqual([null, null]);
    const landscape = track('landscapeLeft', [[0, [-1, 0, 0]]]);
    close(
      framesGravity(landscape, [{ width: 1920, height: 1080, timestampSeconds: 0 }])[0],
      [0, 1, 0],
    );
    expect(framesGravity(landscape, [{ width: 1080, height: 1920 }])).toEqual([null]);
  });

  it('is empty without a track', () => {
    expect(framesGravity(null, [{ width: 10, height: 10 }])).toEqual([null]);
  });
});
