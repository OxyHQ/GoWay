/** The landmark tour's camera arithmetic (`lib/map/landmarks/tour.ts`). */
import { describe, expect, test } from 'bun:test';

import { distanceMeters } from '@/lib/map/geo';
import {
  MAX_TOUR_PITCH,
  offsetBy,
  orbitAngle,
  orbitViewport,
  shortestTurn,
  stepIndex,
  type TourStop,
  tourOrder,
  transitionMs,
  transitionViewport,
} from '@/lib/map/landmarks/tour';

const tour = { zoom: 17, pitch: 55, orbitSeconds: 40, lookAtMeters: 50 };
const stop = (id: string, latitude: number, longitude: number, heading = 0): TourStop => ({
  id,
  position: { latitude, longitude },
  heading,
  tour,
});

const A = stop('a', 41.4036, 2.1744);
const B = stop('b', 41.3916, 2.1649);
const C = stop('c', 41.395, 2.162);
const FAR = stop('far', 40.7484, -73.9857);

describe('tourOrder', () => {
  test('starts at the chosen landmark and always moves on to the nearest unvisited', () => {
    expect(tourOrder([B, FAR, C, A], 'a').map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(tourOrder([A, B, C], 'b').map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  test('stays in one city, and an unknown start is an empty tour', () => {
    expect(tourOrder([A, FAR], 'far').map((s) => s.id)).toEqual(['far']);
    expect(tourOrder([A, B], 'nope')).toEqual([]);
  });
});

describe('orbitViewport', () => {
  test('starts facing the main facade: the camera looks along heading + 180°', () => {
    expect(orbitViewport(stop('x', 0, 0, 0), 0).bearing).toBe(180);
    expect(orbitViewport(stop('x', 0, 0, 119), 0).bearing).toBe(299);
    expect(orbitViewport(stop('x', 0, 0, 119), 90).bearing).toBe(29);
  });

  test("pushes the ground centre on by lookAt × tan(pitch), so the landmark's middle is centred", () => {
    const view = orbitViewport(A, 0);
    const pushed = distanceMeters(A.position, view);
    expect(pushed).toBeCloseTo(50 * Math.tan((55 * Math.PI) / 180), 0);
    // On, away from the camera: along the camera's bearing.
    const ahead = offsetBy(A.position, view.bearing ?? 0, pushed);
    expect(distanceMeters(ahead, view)).toBeLessThan(0.01);
  });

  test("never pitches past the canvas's limit", () => {
    expect(orbitViewport({ ...A, tour: { ...tour, pitch: 80 } }, 0).pitch).toBe(MAX_TOUR_PITCH);
  });

  test('one orbit takes orbitSeconds', () => {
    expect(orbitAngle(A, 40_000)).toBeCloseTo(360);
    expect(orbitAngle(A, 10_000)).toBeCloseTo(90);
  });
});

describe('transitions', () => {
  const from = orbitViewport(A, 0);
  const to = orbitViewport(B, 0);

  test('end exactly where they say', () => {
    const start = transitionViewport(from, to, 0);
    const end = transitionViewport(from, to, 1);
    expect(distanceMeters(start, from)).toBeLessThan(0.01);
    expect(distanceMeters(end, to)).toBeLessThan(0.01);
    expect(end.zoom).toBeCloseTo(to.zoom);
  });

  test('lift in the middle of a long hop, not of a short one', () => {
    expect(transitionViewport(from, to, 0.5).zoom).toBeLessThan(Math.min(from.zoom, to.zoom) - 1);
    const nudge = { ...from, latitude: from.latitude + 0.0001 };
    expect(transitionViewport(from, nudge, 0.5).zoom).toBeCloseTo(from.zoom, 1);
  });

  test('turn the short way round', () => {
    expect(shortestTurn(350, 10)).toBe(20);
    expect(shortestTurn(10, 350)).toBe(-20);
    const v = transitionViewport({ ...from, bearing: 350 }, { ...to, bearing: 10 }, 0.5);
    expect(v.bearing === 0 || v.bearing === 360 || Math.abs((v.bearing ?? 0) - 0) < 1e-9).toBe(
      true,
    );
  });

  test('take longer for farther, within bounds', () => {
    expect(transitionMs(from, from)).toBe(1_600);
    expect(transitionMs(from, to)).toBeGreaterThan(1_600);
    expect(transitionMs(from, orbitViewport(FAR, 0))).toBe(5_000);
  });
});

describe('stepIndex', () => {
  test('wraps both ways', () => {
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(1, 3, 1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});

describe('startAngle', () => {
  test('turns where the orbit opens', () => {
    const turned = { ...stop('x', 0, 0, 299), tour: { ...tour, startAngle: -149 } };
    expect(orbitViewport(turned, 0).bearing).toBe(330);
  });
});
