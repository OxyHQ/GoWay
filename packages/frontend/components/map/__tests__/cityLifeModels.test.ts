/**
 * The city-life fleet: soft, closed, outward-facing shapes within their
 * triangle budgets, no pointed ends, and taxis only where a city has a taxi
 * livery.
 */
import { describe, expect, test } from 'bun:test';

import {
  bus,
  hatchback,
  type ModelGeometry,
  person,
  sedan,
  taxi,
  van,
} from '../engine/cityLife/agentModels';
import { taxiLiveryAt } from '../engine/cityLife/sim/liveries';

const vehicles = { hatchback, sedan, taxi, van, bus };

/** Signed volume by the divergence theorem: positive when every face winds outward. */
function signedVolume(g: ModelGeometry): number {
  let volume = 0;
  const p = (i: number) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [p(g.indices[t]), p(g.indices[t + 1]), p(g.indices[t + 2])];
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return volume;
}

describe('the fleet', () => {
  for (const [name, build] of Object.entries(vehicles)) {
    test(`${name}: near 300–800 triangles, far ≤ 150, closed and outward`, () => {
      const near = build('near');
      const far = build('far');
      expect(near.indices.length / 3).toBeGreaterThanOrEqual(300);
      expect(near.indices.length / 3).toBeLessThanOrEqual(800);
      expect(far.indices.length / 3).toBeLessThanOrEqual(150);
      for (const g of [near, far]) {
        expect(signedVolume(g)).toBeGreaterThan(0);
        for (let i = 0; i < g.normals.length; i += 3) {
          expect(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2])).toBeCloseTo(1, 3);
        }
      }
    });

    test(`${name}: rounded, blunt ends — no point`, () => {
      const g = build('near');
      // Near each end of the body the cross-section is still most of the width.
      let widest = 0;
      for (let i = 0; i < g.positions.length; i += 3) {
        if (g.positions[i] > g.halfLength * 0.93 && g.parts[i / 3] !== 2) {
          widest = Math.max(widest, Math.abs(g.positions[i + 1]));
        }
      }
      expect(widest).toBeGreaterThan(g.halfWidth * 0.6);
    });
  }

  test('people: capsule body and head, near ≤ 300 triangles, far ≤ 50', () => {
    expect(person('near').indices.length / 3).toBeLessThanOrEqual(300);
    expect(person('far').indices.length / 3).toBeLessThanOrEqual(50);
    expect(signedVolume(person('near'))).toBeGreaterThan(0);
  });

  test('smooth shading: a body vertex shares its normal with no hard crease', () => {
    // Every vertex of a superellipsoid is shared by the faces around it, so
    // there are far fewer vertices than triangle corners.
    const g = sedan('near');
    expect(g.positions.length / 3).toBeLessThan(g.indices.length * 0.75);
  });
});

describe('taxi liveries', () => {
  test('only where a city has one', () => {
    expect(taxiLiveryAt(2.164, 41.392)?.doors).toEqual([238, 200, 70]); // Barcelona: yellow doors
    expect(taxiLiveryAt(-74.006, 40.712)?.body).toEqual([242, 198, 64]); // New York: yellow
    expect(taxiLiveryAt(-0.12, 51.5)).toBeNull();
    expect(taxiLiveryAt(139.77, 35.68)).toBeNull();
  });
});
