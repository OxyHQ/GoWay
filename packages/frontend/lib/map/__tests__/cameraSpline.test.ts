/**
 * Path smoothing: centripetal Catmull-Rom passes through every control point
 * and does not loop or overshoot where control points are unevenly spaced —
 * the shape of a route polyline and of a hand-drawn stroke.
 */
import { describe, expect, test } from 'bun:test';

import {
  arcLengths,
  catmullRom,
  dedupe,
  resample,
  sampleAtLength,
  simplify,
} from '@/lib/map/camera/spline';

/** Does the polyline cross itself? O(n²), fine for a test. */
function selfIntersects(points: readonly (readonly number[])[]): boolean {
  const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 2; j < points.length - 1; j++) {
      const [a, b, c, d] = [points[i], points[i + 1], points[j], points[j + 1]];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    }
  }
  return false;
}

describe('catmullRom', () => {
  test('passes through every control point, at the index it reports', () => {
    const control = [
      [0, 0, 15],
      [100, 0, 16],
      [100, 100, 17],
      [250, 120, 15.5],
    ];
    const { samples, controlIndex } = catmullRom(control, { spacing: 5 });
    expect(controlIndex).toHaveLength(control.length);
    for (const [k, index] of controlIndex.entries()) expect(samples[index]).toEqual(control[k]);
  });

  test('centripetal: no loop where spacing is wildly uneven', () => {
    // A junction: two points 0.5 m apart between two 300 m legs. Uniform
    // Catmull-Rom forms a cusp loop here; centripetal must not.
    const control = [
      [0, 0],
      [300, 0],
      [300.5, 0.4],
      [300.8, 300],
    ];
    const centripetal = catmullRom(control, { spacing: 0.25, alpha: 0.5 }).samples;
    expect(selfIntersects(centripetal)).toBe(false);
    const uniform = catmullRom(control, { spacing: 0.25, alpha: 0 }).samples;
    // The control: uniform does misbehave, so the test is not vacuous.
    const overshoot = (s: number[][]) => Math.max(...s.map((p) => p[0])) - 300.8;
    expect(overshoot(uniform)).toBeGreaterThan(overshoot(centripetal));
  });

  test('extra channels ride the same curve', () => {
    const { samples } = catmullRom(
      [
        [0, 0, 10],
        [100, 0, 20],
      ],
      { spacing: 10 },
    );
    // Monotonic between two control values: no overshoot on a channel either.
    for (let i = 1; i < samples.length; i++)
      expect(samples[i][2]).toBeGreaterThanOrEqual(samples[i - 1][2]);
  });
});

describe('simplify / dedupe / resample', () => {
  test('simplify keeps the corners and drops the collinear', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 50, y: 0.2 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 100, y: 100 },
    ];
    expect(simplify(points, 1)).toEqual([points[0], points[2], points[4]]);
  });

  test('dedupe drops repeated vertices', () => {
    expect(
      dedupe([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toHaveLength(2);
  });

  test('resample spaces samples evenly along the length', () => {
    const line = [
      [0, 0],
      [100, 0],
      [100, 50],
    ];
    const { samples, lengths } = resample(line, 10);
    expect(lengths[lengths.length - 1]).toBeCloseTo(150, 9);
    expect(samples).toHaveLength(16);
    expect(sampleAtLength(line, arcLengths(line), 125)).toEqual([100, 25]);
  });
});
