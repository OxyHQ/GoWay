import { describe, expect, test } from 'bun:test';

import type { Vec3 } from '../types';
import {
  createWalkableRegion,
  gabrielLinks,
  LINK_MAX_METERS,
  NARROW_REACH_METERS,
  PANORAMIC_REACH_METERS,
  reachOf,
  type WalkableRegion,
} from '../walkableRegion';

/** ENU scene: z up, cameras at eye height. */
const UP: Vec3 = [0, 0, 1];
const at = (x: number, y: number, z = 1.7) => ({ position: [x, y, z] as Vec3 });
/** A walk north along x = `x`, a viewpoint every `step` metres. */
const walk = (length: number, step = 1.5, x = 0, z = (_y: number) => 1.7) =>
  Array.from({ length: Math.floor(length / step) + 1 }, (_, i) => at(x, i * step, z(i * step)));

function region(viewpoints: { position: Vec3 }[], reach: number, up: Vec3 = UP): WalkableRegion {
  const built = createWalkableRegion(viewpoints, up, reach);
  if (!built) throw new Error('no region');
  return built;
}

describe('reachOf', () => {
  test('a published reach wins', () => {
    expect(reachOf({ reachMeters: 3.5 })).toBe(3.5);
    expect(
      reachOf({ reachMeters: 0.8, fieldOfView: { horizontalDegrees: 179, verticalDegrees: 120 } }),
    ).toBe(0.8);
  });

  test('otherwise a panorama reaches farther than a phone', () => {
    expect(reachOf({ fieldOfView: { horizontalDegrees: 179, verticalDegrees: 120 } })).toBe(
      PANORAMIC_REACH_METERS,
    );
    expect(reachOf({ fieldOfView: { horizontalDegrees: 66, verticalDegrees: 50 } })).toBe(
      NARROW_REACH_METERS,
    );
    expect(reachOf({})).toBe(NARROW_REACH_METERS);
  });
});

describe('links', () => {
  const links = (points: [number, number][]) => {
    const pairs = gabrielLinks(
      Float64Array.from(points.map((p) => p[0])),
      Float64Array.from(points.map((p) => p[1])),
      LINK_MAX_METERS,
    );
    const result: string[] = [];
    for (let i = 0; i < pairs.length; i += 2) result.push(`${pairs[i]}-${pairs[i + 1]}`);
    return result.sort();
  };

  test('a walked line links each step, never over a viewpoint', () => {
    expect(
      links([
        [0, 0],
        [0, 2],
        [0, 4],
      ]),
    ).toEqual(['0-1', '1-2']);
  });

  test('a gap wider than the link limit was not walked', () => {
    expect(
      links([
        [0, 0],
        [0, LINK_MAX_METERS + 0.5],
      ]),
    ).toEqual([]);
    expect(
      links([
        [0, 0],
        [0, LINK_MAX_METERS - 0.5],
      ]),
    ).toEqual(['0-1']);
  });

  test('two walks a street apart are linked across it', () => {
    const left = [0, 1.5, 3, 4.5].map((y) => [0, y] as [number, number]);
    const right = [0, 1.5, 3, 4.5].map((y) => [5, y] as [number, number]);
    const all = links([...left, ...right]);
    expect(all).toContain('0-4');
    expect(all).toContain('3-7');
  });

  test('stays linear in density: a dense plaza has O(n) links', () => {
    const plaza: [number, number][] = [];
    for (let x = 0; x < 30; x++) for (let y = 0; y < 30; y++) plaza.push([x * 1.5, y * 1.5]);
    // A square grid is the degenerate case (both diagonals of every cell are
    // on its circle): edges and diagonals, still under four per point.
    expect(links(plaza).length).toBeLessThan(4 * plaza.length);
  });
});

describe('walkable region', () => {
  const street = region(walk(30), 3);

  test('is nothing without viewpoints', () => {
    expect(createWalkableRegion([], UP, 3)).toBeNull();
  });

  test('is the ground within reach of the walked path, whatever the height asked', () => {
    expect(street.contains([2.9, 10, 1.7])).toBe(true);
    expect(street.contains([-2.9, 10, 50])).toBe(true);
    expect(street.contains([3.1, 10, 1.7])).toBe(false);
    expect(street.contains([0, 32.9, 1.7])).toBe(true);
    expect(street.contains([0, 33.1, 1.7])).toBe(false);
  });

  test('does not bridge an unwalked gap', () => {
    const gap = region([...walk(6), ...walk(6).map((v) => at(0, v.position[1] + 16))], 1.2);
    expect(gap.contains([0, 3, 1.7])).toBe(true);
    expect(gap.contains([0, 11, 1.7])).toBe(false);
  });

  test('an unlinked viewpoint is a disc', () => {
    const lone = region([at(0, 0), at(20, 0)], 1.2);
    expect(lone.contains([20, 1.1, 0])).toBe(true);
    expect(lone.contains([10, 0, 0])).toBe(false);
  });

  test('clamp keeps an inside point where it is, at the captured height', () => {
    const out = street.clamp([1, 10, 9]);
    expect(out[0]).toBeCloseTo(1, 9);
    expect(out[1]).toBeCloseTo(10, 9);
    expect(out[2]).toBeCloseTo(1.7, 9);
  });

  test('clamp slides an outside point onto the edge, not back to the path', () => {
    const out: Vec3 = [0, 0, 0];
    expect(street.clamp([5, 10, 1.7], out)).toBe(out);
    expect(out[0]).toBeCloseTo(3, 6);
    expect(out[1]).toBeCloseTo(10, 6);
    expect(street.contains(out)).toBe(true);
    // Far away: the nearest walkable point, wherever it is.
    street.clamp([0, 200, 1.7], out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(33, 6);
    street.clamp([-100, -100, 0], out);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(3, 6);
    // A clamped point is a fixed point.
    const again = street.clamp(out);
    expect(again[0]).toBeCloseTo(out[0], 9);
    expect(again[1]).toBeCloseTo(out[1], 9);
  });

  test('pushing into the edge, step by step, slides along it', () => {
    const position: Vec3 = [0, 5, 1.7];
    const wish: Vec3 = [0, 0, 0];
    // Walking north-east at 1.4 m/s, 60 frames a second, for 10 s.
    for (let frame = 0; frame < 600; frame++) {
      wish[0] = position[0] + (1.4 / 60) * Math.SQRT1_2;
      wish[1] = position[1] + (1.4 / 60) * Math.SQRT1_2;
      wish[2] = position[2];
      street.clamp(wish, position);
    }
    expect(position[0]).toBeCloseTo(3, 3);
    expect(position[1]).toBeGreaterThan(5 + 9);
  });

  test('height follows the captured heights, continuously', () => {
    const ramp = region(
      walk(30, 1.5, 0, (y) => 1.7 + 0.1 * y),
      3,
    );
    expect(ramp.heightAt([0, 15, 0])).toBeCloseTo(3.2, 1);
    expect(ramp.heightAt([2.5, 15, 99])).toBeCloseTo(3.2, 1);
    let previous = ramp.heightAt([-3, 0, 0]);
    for (let i = 1; i <= 600; i++) {
      const height = ramp.heightAt([-3 + i / 100, i / 20, 0]);
      expect(Math.abs(height - previous)).toBeLessThan(0.02);
      previous = height;
    }
    // An outlier among its neighbours is blended, not stepped onto.
    const bump = region(
      walk(30).map((v, i) => (i === 10 ? at(0, v.position[1], 0) : v)),
      3,
    );
    expect(bump.heightAt([0, 15, 0])).toBeCloseTo(1.7, 6);
  });

  test('works in the scene up, not an assumed axis', () => {
    // Y-up: the walk runs along z at height y = 1.7.
    const yUp = region(
      walk(30).map((v) => ({ position: [v.position[0], 1.7, v.position[1]] as Vec3 })),
      3,
      [0, 1, 0],
    );
    expect(yUp.contains([2.9, -40, 10])).toBe(true);
    expect(yUp.contains([3.1, 1.7, 10])).toBe(false);
    const out = yUp.clamp([5, 0, 10]);
    expect(out[0]).toBeCloseTo(3, 6);
    expect(out[1]).toBeCloseTo(1.7, 6);
    expect(out[2]).toBeCloseTo(10, 6);
  });

  test('answers a frame of queries over 2000 viewpoints quickly', () => {
    // A district: twenty streets of a hundred viewpoints each.
    const viewpoints = [];
    for (let s = 0; s < 20; s++)
      for (let i = 0; i < 100; i++) viewpoints.push(at(s * 12 + Math.sin(i / 7), i * 1.5));
    const built = Date.now();
    const district = region(viewpoints, 3);
    expect(Date.now() - built).toBeLessThan(1000);
    const out: Vec3 = [0, 0, 0];
    const started = performance.now();
    for (let q = 0; q < 10_000; q++) {
      const p: Vec3 = [(q * 7.31) % 240, (q * 3.17) % 150, 1.7];
      district.clamp(p, out);
      district.contains(p);
    }
    // Ten thousand frames' worth; a frame asks once.
    expect(performance.now() - started).toBeLessThan(500);
  });
});
