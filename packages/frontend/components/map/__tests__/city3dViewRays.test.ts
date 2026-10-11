/**
 * Reading the camera back out of the projection matrix the host hands over
 * (`engine/city3d/viewRays.ts`). Checked against a camera built by hand —
 * position, look direction, field of view — so a sign error in the inverse or
 * in the mercator → ENU flip (mercator y is SOUTH) shows up as a number.
 */
import { describe, expect, test } from 'bun:test';

import { invertMat4, viewRays } from '@/components/map/engine/city3d/viewRays';

type Vec = [number, number, number];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec): Vec => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Column-major a × b. */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

/** OpenGL perspective × lookAt, in the frame the camera is given in. */
function camera(eye: Vec, target: Vec, up: Vec, fovY: number, aspect: number): number[] {
  const f = norm(sub(target, eye));
  const s = norm(cross(f, up));
  const u = cross(s, f);
  const view = [
    s[0],
    u[0],
    -f[0],
    0,
    s[1],
    u[1],
    -f[1],
    0,
    s[2],
    u[2],
    -f[2],
    0,
    -dot(s, eye),
    -dot(u, eye),
    dot(f, eye),
    1,
  ];
  const near = 1;
  const far = 1e5;
  const t = 1 / Math.tan(fovY / 2);
  const proj = [
    t / aspect,
    0,
    0,
    0,
    0,
    t,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ];
  return multiply(proj, view);
}

describe('invertMat4', () => {
  test('M · M⁻¹ = I, and a singular matrix is null', () => {
    const m = camera([300, 200, 50], [0, 0, 0], [0, 0, 1], 0.6, 1.6);
    const inverse = invertMat4(m);
    expect(inverse).not.toBeNull();
    const identity = multiply(m, inverse ?? []);
    for (let i = 0; i < 16; i++)
      expect(Math.abs(identity[i] - (i % 5 === 0 ? 1 : 0))).toBeLessThan(1e-6);
    expect(invertMat4(new Array(16).fill(0))).toBeNull();
  });
});

describe('viewRays', () => {
  // A real (right-handed) camera in ENU metres, 1 km south of the centre and
  // 400 m up, looking at it; then fed mercator, which is what a host hands
  // over: ENU = (x, −y, z) · metresPerMercator.
  const metresPerMercator = 30_000_000;
  const enuCamera = camera([0, -1000, 400], [0, 0, 0], [0, 0, 1], 0.6435, 1.6);
  const mercatorToEnu = [
    metresPerMercator,
    0,
    0,
    0,
    0,
    -metresPerMercator,
    0,
    0,
    0,
    0,
    metresPerMercator,
    0,
    0,
    0,
    0,
    1,
  ];
  const projection = multiply(enuCamera, mercatorToEnu);

  test('recovers the camera in ENU metres (y north: the camera is SOUTH, so negative)', () => {
    const rays = viewRays(projection, metresPerMercator);
    expect(rays).not.toBeNull();
    const [x, y, z] = rays?.camera ?? [0, 0, 0];
    expect(Math.abs(x)).toBeLessThan(1e-3);
    expect(Math.abs(y + 1000)).toBeLessThan(1e-3);
    expect(Math.abs(z - 400)).toBeLessThan(1e-3);
  });

  test('corner rays: bottom ones fall to the ground, all look north, left is west', () => {
    const rays = viewRays(projection, metresPerMercator);
    if (!rays) throw new Error('expected rays');
    const [bl, br, tl, tr] = rays.corners;
    for (const ray of [bl, br, tl, tr]) expect(ray[1]).toBeGreaterThan(0);
    expect(bl[2]).toBeLessThan(0);
    expect(br[2]).toBeLessThan(0);
    expect(tl[2]).toBeGreaterThan(bl[2]);
    expect(bl[0]).toBeLessThan(0);
    expect(br[0]).toBeGreaterThan(0);
    // The centre of the screen looks at the map centre.
    const centre = norm([
      (bl[0] + br[0] + tl[0] + tr[0]) / 4,
      (bl[1] + br[1] + tl[1] + tr[1]) / 4,
      (bl[2] + br[2] + tl[2] + tr[2]) / 4,
    ]);
    const toTarget = norm([0, 1000, -400]);
    expect(dot(centre, toTarget)).toBeGreaterThan(0.99999);
  });

  test('a matrix with no camera in it is refused', () => {
    expect(viewRays(new Array(16).fill(0), metresPerMercator)).toBeNull();
  });
});
