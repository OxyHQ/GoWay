/**
 * The metric plane camera paths are planned in, and the top-down projection
 * Camera Studio draws through. Pinned against MapLibre's own mercator, so the
 * plane cannot drift from the map it steers.
 */
import { describe, expect, test } from 'bun:test';
import { MercatorCoordinate } from 'maplibre-gl';

import {
  bearingDelta,
  createPlane,
  fitZoom,
  lerpBearing,
  mercatorX,
  mercatorY,
  metresPerPixel,
  projectTopDown,
  trapezoidEase,
  unprojectTopDown,
} from '@/lib/map/camera/plane';

const BARCELONA = { latitude: 41.3874, longitude: 2.1686 };

describe('mercator', () => {
  test('agrees with MapLibre', () => {
    for (const c of [
      BARCELONA,
      { latitude: -33.86, longitude: 151.2 },
      { latitude: 64.1, longitude: -21.9 },
    ]) {
      const ml = MercatorCoordinate.fromLngLat([c.longitude, c.latitude]);
      expect(mercatorX(c.longitude)).toBeCloseTo(ml.x, 12);
      expect(mercatorY(c.latitude)).toBeCloseTo(ml.y, 12);
    }
  });

  test('a plane round-trips, in metres, north up', () => {
    const plane = createPlane(BARCELONA);
    const east = plane.toPlane({
      latitude: BARCELONA.latitude,
      longitude: BARCELONA.longitude + 0.01,
    });
    const north = plane.toPlane({
      latitude: BARCELONA.latitude + 0.01,
      longitude: BARCELONA.longitude,
    });
    // 0.01° of longitude at 41.39° is ~834 m; of latitude ~1,112 m (± mercator scale).
    expect(east.x).toBeGreaterThan(820);
    expect(east.x).toBeLessThan(850);
    expect(Math.abs(east.y)).toBeLessThan(1e-6);
    expect(north.y).toBeGreaterThan(1100);
    const back = plane.toGeo({ x: 1234.5, y: -987.6 });
    const again = plane.toPlane(back);
    expect(again.x).toBeCloseTo(1234.5, 6);
    expect(again.y).toBeCloseTo(-987.6, 6);
  });

  test('a plane across the antimeridian stays continuous', () => {
    const plane = createPlane({ latitude: -17, longitude: 179.99 });
    const p = plane.toPlane({ latitude: -17, longitude: -179.99 });
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(3000);
  });
});

describe('top-down projection', () => {
  const size = { width: 800, height: 600 };

  test('the centre pixel is the camera centre', () => {
    const viewport = { ...BARCELONA, zoom: 15, bearing: 37 };
    const c = unprojectTopDown(viewport, size, { x: 400, y: 300 });
    expect(c.latitude).toBeCloseTo(BARCELONA.latitude, 10);
    expect(c.longitude).toBeCloseTo(BARCELONA.longitude, 10);
  });

  test('screen-up is the bearing', () => {
    // Facing east: the pixel straight above the centre is east of it.
    const viewport = { ...BARCELONA, zoom: 15, bearing: 90 };
    const c = unprojectTopDown(viewport, size, { x: 400, y: 100 });
    expect(c.longitude).toBeGreaterThan(BARCELONA.longitude);
    expect(c.latitude).toBeCloseTo(BARCELONA.latitude, 5);
    // And 200 px is 200 × metresPerPixel on the ground.
    const metres = createPlane(BARCELONA).toPlane(c).x;
    expect(metres).toBeCloseTo(200 * metresPerPixel(BARCELONA.latitude, 15), 0);
  });

  test('project ∘ unproject is the identity at any bearing', () => {
    for (const bearing of [0, 33, 180, 271]) {
      const viewport = { ...BARCELONA, zoom: 16.4, bearing };
      for (const point of [
        { x: 0, y: 0 },
        { x: 800, y: 600 },
        { x: 123, y: 456 },
      ]) {
        const geo = unprojectTopDown(viewport, size, point);
        const back = projectTopDown(viewport, size, geo);
        expect(back.x).toBeCloseTo(point.x, 6);
        expect(back.y).toBeCloseTo(point.y, 6);
      }
    }
  });

  test('fitZoom frames a box the way fitBounds would', () => {
    const plane = createPlane(BARCELONA);
    // 1 km square, 600 px of free height: 1000 m / 600 px ≈ 1.67 m/px.
    const points = [
      { x: -500, y: -500 },
      { x: 500, y: 500 },
    ];
    const zoom = fitZoom(points, plane, { width: 800, height: 700 }, 50);
    expect(metresPerPixel(BARCELONA.latitude, zoom)).toBeCloseTo(1000 / 600, 2);
  });
});

describe('angles and easing', () => {
  test('the shortest turn', () => {
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(10, 350)).toBe(-20);
    expect(lerpBearing(350, 10, 0.5)).toBeCloseTo(0, 9);
  });

  test('a trapezoid ease starts and ends at rest and is monotonic', () => {
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const v = trapezoidEase(i / 100, 0.15);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
    expect(trapezoidEase(0, 0.15)).toBe(0);
    expect(trapezoidEase(1, 0.15)).toBeCloseTo(1, 12);
    // Slope at the ends ~0, in the middle constant.
    expect(trapezoidEase(0.001, 0.15)).toBeLessThan(0.0001);
    const mid = (trapezoidEase(0.55, 0.15) - trapezoidEase(0.45, 0.15)) / 0.1;
    expect(mid).toBeCloseTo(1 / 0.85, 6);
  });
});
