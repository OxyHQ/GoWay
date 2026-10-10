import { describe, expect, test } from 'bun:test';
import type { StreetSceneViewpoint } from '@goway.to/sdk';

import { createCameraRig } from '../cameraRig';
import {
  clampPitch,
  easeInOut,
  GUIDED_MAX_PITCH_DEGREES,
  HORIZONTAL_FOV_SLACK,
  lerp3,
  nearestViewpoint,
  nextViewpoint,
  reachableViewpoints,
  viewFrustum,
} from '../guidedNavigation';
import type { Vec3 } from '../types';

/** ENU scene: z up, ground ≈ 0, cameras at eye height. */
const UP: Vec3 = [0, 0, 1];
const vp = (x: number, y: number, z = 1.7): StreetSceneViewpoint => ({
  position: [x, y, z],
  forward: [0, 1, 0],
});

// A street running north (+y) with a side branch to the east at y = 6.
const STREET: StreetSceneViewpoint[] = [
  vp(0, 0), // 0
  vp(0, 2), // 1 — 2 m ahead
  vp(-0.1, 4.5), // 2 — further ahead, a touch west
  vp(0, -2), // 3 — behind
  vp(0.1, 0.2), // 4 — too close to be a step from 0
  vp(0, 20), // 5 — too far
  vp(3, 2.2), // 6 — ahead-right, ~56° off north from 0
];

describe('nearestViewpoint', () => {
  test('finds the closest viewpoint in 3D', () => {
    expect(nearestViewpoint(STREET, [0.1, 1.8, 1.6])).toBe(1);
    expect(nearestViewpoint(STREET, [0, -5, 0])).toBe(3);
  });
  test('-1 for no viewpoints', () => {
    expect(nearestViewpoint([], [0, 0, 0])).toBe(-1);
  });
});

describe('nextViewpoint', () => {
  test('forward picks the next place ahead, not the farthest in line', () => {
    expect(nextViewpoint(STREET, 0, [0, 1, 0], UP)?.index).toBe(1);
  });

  test('backward picks the one behind', () => {
    expect(nextViewpoint(STREET, 0, [0, -1, 0], UP)?.index).toBe(3);
  });

  test('ignores viewpoints closer than 0.5 m or farther than 6 m', () => {
    const only = [vp(0, 0), vp(0, 0.2), vp(0, 9)];
    expect(nextViewpoint(only, 0, [0, 1, 0], UP)).toBeNull();
  });

  test('ignores viewpoints outside the 45° cone', () => {
    // Looking east-north-east (30° off east): 6 is inside, the street ahead is not.
    const eastish: Vec3 = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0];
    expect(nextViewpoint(STREET, 0, eastish, UP)?.index).toBe(6);
    // Looking due west: nothing.
    expect(nextViewpoint(STREET, 0, [-1, 0, 0], UP)).toBeNull();
  });

  test('pitch does not matter — only the ground direction', () => {
    expect(nextViewpoint(STREET, 0, [0, 1, 3], UP)?.index).toBe(1);
    expect(nextViewpoint(STREET, 0, [0, 0, 1], UP)).toBeNull();
  });

  test('a height difference between viewpoints is not distance', () => {
    const stairs = [vp(0, 0, 1.7), vp(0, 5.5, 4.5)];
    expect(nextViewpoint(stairs, 0, [0, 1, 0], UP)?.index).toBe(1);
  });

  test('reports angle and ground distance', () => {
    const step = nextViewpoint(STREET, 0, [0, 1, 0], UP);
    expect(step?.distance).toBeCloseTo(2, 6);
    expect(step?.angle).toBeCloseTo(0, 6);
  });
});

describe('reachableViewpoints', () => {
  test('one marker per direction sector, nearest first, within range', () => {
    const markers = reachableViewpoints(STREET, 0, UP);
    expect(markers).toContain(1);
    expect(markers).toContain(3);
    expect(markers).toContain(6);
    // 2 shares 1's sector and is farther; 4 is too close; 5 is too far.
    expect(markers).not.toContain(2);
    expect(markers).not.toContain(4);
    expect(markers).not.toContain(5);
    expect(markers[0]).toBe(1);
  });
});

describe('clamps', () => {
  test('pitch is limited to ±35° by default', () => {
    const max = (GUIDED_MAX_PITCH_DEGREES * Math.PI) / 180;
    expect(clampPitch(1.2)).toBeCloseTo(max, 9);
    expect(clampPitch(-1.2)).toBeCloseTo(-max, 9);
    expect(clampPitch(0.1)).toBe(0.1);
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

describe('glide', () => {
  test('ease-in-out starts and ends at rest and passes the midpoint', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(2)).toBe(1);
  });

  test('lerp3', () => {
    expect(lerp3([0, 0, 0], [2, 4, 6], 0.5)).toEqual([1, 2, 3]);
  });
});
