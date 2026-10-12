import { describe, expect, test } from 'bun:test';

import { createCameraRig } from '../cameraRig';
import {
  easeInOut,
  GLIDE_MAX_MS,
  GLIDE_MIN_MS,
  GO_MAX_METERS,
  glideDurationMs,
  GUIDED_MAX_PITCH_DEGREES,
  groundHit,
  HORIZONTAL_FOV_SLACK,
  pitchLimitDegrees,
  STICK_DEAD_ZONE_PX,
  STICK_RADIUS_PX,
  stickInput,
  TALL_CAPTURE_MAX_PITCH_DEGREES,
  viewFrustum,
} from '../guidedNavigation';
import type { Vec3 } from '../types';

/** ENU scene: z up, ground ≈ 0, cameras at eye height. */
const UP: Vec3 = [0, 0, 1];

describe('pitch', () => {
  test('±35° for a phone capture, ±60° for one that saw sky and ground', () => {
    expect(pitchLimitDegrees(undefined)).toBe(GUIDED_MAX_PITCH_DEGREES);
    expect(pitchLimitDegrees({ horizontalDegrees: 66, verticalDegrees: 50 })).toBe(
      GUIDED_MAX_PITCH_DEGREES,
    );
    expect(pitchLimitDegrees({ horizontalDegrees: 179, verticalDegrees: 120 })).toBe(
      TALL_CAPTURE_MAX_PITCH_DEGREES,
    );
  });

  test('the guided rig never pitches past the limit', () => {
    const rig = createCameraRig({ position: [0, 0, 1.7], target: [0, 10, 1.7], up: UP });
    rig.setMode('walk');
    rig.setPitchLimit((35 * Math.PI) / 180);
    rig.look(0, 2);
    const d = rig.direction();
    expect(Math.asin(d[2])).toBeCloseTo((35 * Math.PI) / 180, 6);
  });

  test('placeAt keeps the view direction; lookToward keeps the position', () => {
    const rig = createCameraRig({ position: [0, 0, 1.7], target: [0, 10, 1.7], up: UP });
    rig.setMode('walk');
    rig.placeAt([4, 4, 1.7]);
    const pose = rig.pose();
    expect(pose.position).toEqual([4, 4, 1.7]);
    expect(pose.target[1]).toBeGreaterThan(4);
    rig.lookToward([1, 0, 0]);
    expect(rig.pose().position).toEqual([4, 4, 1.7]);
    expect(rig.direction()[0]).toBeCloseTo(1, 6);
  });

  test('walk axes are horizontal whatever the pitch, and written in place', () => {
    const rig = createCameraRig({ position: [0, 0, 1.7], target: [0, 10, 1.7], up: UP });
    rig.setMode('walk');
    rig.look(Math.PI / 2, 0.5);
    const forward: Vec3 = [0, 0, 0];
    const right: Vec3 = [0, 0, 0];
    rig.walkAxes(forward, right);
    // A quarter turn right from north faces east; right is then south.
    expect(forward[0]).toBeCloseTo(1, 9);
    expect(forward[2]).toBeCloseTo(0, 9);
    expect(right[1]).toBeCloseTo(-1, 9);
    const out = { position: [0, 0, 0] as Vec3, target: [0, 0, 0] as Vec3, up: [0, 0, 0] as Vec3 };
    expect(rig.pose(out)).toBe(out);
    expect(out.position).toEqual([0, 0, 1.7]);
  });
});

describe('groundHit', () => {
  const out: Vec3 = [0, 0, 0];

  test('a ray looking down meets the ground plane', () => {
    expect(groundHit([0, 0, 1.6], [0, 1, -1], UP, 0, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0, 9);
    expect(out[1]).toBeCloseTo(1.6, 9);
    expect(out[2]).toBeCloseTo(0, 9);
  });

  test('a ray at or above the horizon never does', () => {
    expect(groundHit([0, 0, 1.6], [0, 1, 0], UP, 0, out)).toBe(false);
    expect(groundHit([0, 0, 1.6], [0, 1, 0.2], UP, 0, out)).toBe(false);
  });

  test('a far hit is cut to the longest go along the ground', () => {
    expect(groundHit([0, 0, 1.6], [0, 1, -0.001], UP, 0, out)).toBe(true);
    expect(out[1]).toBeCloseTo(GO_MAX_METERS, 6);
    expect(out[2]).toBeGreaterThan(1.5);
  });

  test('the plane follows the scene up', () => {
    // Y-up scene: the ground is y = 0.
    expect(groundHit([0, 1.6, 0], [0, -1, -1], [0, 1, 0], 0, out)).toBe(true);
    expect(out[1]).toBeCloseTo(0, 9);
    expect(out[2]).toBeCloseTo(-1.6, 9);
  });
});

describe('glide and thumbstick', () => {
  test('a glide lasts in proportion to its length, within bounds', () => {
    expect(glideDurationMs(0.1)).toBe(GLIDE_MIN_MS);
    expect(glideDurationMs(5)).toBe(2000);
    expect(glideDurationMs(100)).toBe(GLIDE_MAX_MS);
  });

  test('ease-in-out starts and ends at rest and passes the midpoint', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(2)).toBe(1);
  });

  test('the stick: dead zone, proportional, full past its radius; up is forward', () => {
    const out: [number, number] = [9, 9];
    expect(stickInput(STICK_DEAD_ZONE_PX - 1, 0, out)).toEqual([0, 0]);
    stickInput(0, -STICK_RADIUS_PX, out);
    expect(out[0]).toBeCloseTo(1, 9);
    expect(out[1]).toBeCloseTo(0, 9);
    stickInput(STICK_RADIUS_PX * 3, 0, out);
    expect(out[1]).toBeCloseTo(1, 9);
    stickInput(0, (STICK_RADIUS_PX + STICK_DEAD_ZONE_PX) / 2, out);
    expect(out[0]).toBeCloseTo(-0.5, 9);
  });
});

describe('viewFrustum', () => {
  const portrait = { horizontalDegrees: 45, verticalDegrees: 75 };

  test('uses the captured vertical FOV', () => {
    expect(viewFrustum(0.5, portrait).verticalDegrees).toBe(75);
  });

  test('a portrait capture on a portrait screen needs no mask', () => {
    expect(viewFrustum(0.5, portrait).sideMask).toBe(0);
  });

  test('a portrait capture on a landscape screen masks the sides to the allowed width', () => {
    const frustum = viewFrustum(16 / 9, portrait);
    expect(frustum.sideMask).toBeGreaterThan(0.1);
    expect(frustum.sideMask).toBeLessThan(0.5);
    // The unmasked middle spans exactly the captured horizontal FOV × slack.
    const allowed = (portrait.horizontalDegrees * HORIZONTAL_FOV_SLACK * Math.PI) / 180;
    const visibleFraction = 1 - 2 * frustum.sideMask;
    const visibleAngle =
      2 * Math.atan(visibleFraction * Math.tan((frustum.horizontalDegrees * Math.PI) / 360));
    expect(visibleAngle).toBeCloseTo(allowed, 6);
  });

  test('zoom narrows the FOV and with it the mask', () => {
    const wide = viewFrustum(16 / 9, portrait, 1);
    const zoomed = viewFrustum(16 / 9, portrait, 0.5);
    expect(zoomed.verticalDegrees).toBeCloseTo(37.5, 6);
    expect(zoomed.sideMask).toBeLessThan(wide.sideMask);
  });

  test('no captured FOV: the default vertical, nothing masked', () => {
    expect(viewFrustum(2, undefined)).toMatchObject({ verticalDegrees: 60, sideMask: 0 });
  });
});
