/**
 * Camera Studio tours: the camera passes THROUGH every keyframe at the time
 * the timeline says, holds where asked, faces what it was told to face, and
 * moves continuously in between.
 */
import { describe, expect, test } from 'bun:test';

import { bearingDelta, bearingOf, createPlane, metresPerPixel } from '@/lib/map/camera/plane';
import { compileTour, type Tour, type TourKeyframe } from '@/lib/map/camera/tour';
import { distanceMeters } from '@/lib/map/geo';

const ORIGIN = { latitude: 41.4036, longitude: 2.1744 };
const plane = createPlane(ORIGIN);
const at = (x: number, y: number) => plane.toGeo({ x, y });

function keyframe(
  partial: Partial<TourKeyframe> & { center: TourKeyframe['center'] },
): TourKeyframe {
  return {
    id: Math.random().toString(36),
    zoom: 16,
    pitch: 50,
    bearing: 0,
    aim: 'path',
    holdMs: 0,
    ...partial,
  };
}

const TOUR: Tour = {
  speed: 1,
  keyframes: [
    keyframe({ center: at(-400, -300), zoom: 15 }),
    keyframe({ center: at(0, -350), zoom: 16, holdMs: 1500 }),
    keyframe({ center: at(350, 0), zoom: 16.5, aim: 'lookAt', lookAt: ORIGIN }),
    keyframe({ center: at(0, 350), zoom: 17, aim: 'fixed', bearing: 200 }),
  ],
};

describe('compileTour', () => {
  const compiled = compileTour(TOUR);
  if (!compiled) throw new Error('expected a tour');

  test('passes through each keyframe at its time', () => {
    compiled.keyframeTimes.forEach((time, k) => {
      const camera = compiled.cameraAt(time);
      expect(distanceMeters(camera, TOUR.keyframes[k].center)).toBeLessThan(0.5);
      expect(camera.zoom).toBeCloseTo(TOUR.keyframes[k].zoom, 6);
    });
    expect(compiled.keyframeTimes[0]).toBe(0);
  });

  test('holds where asked', () => {
    const arrive = compiled.keyframeTimes[1];
    expect(compiled.cameraAt(arrive + 700)).toEqual(compiled.cameraAt(arrive));
    expect(compiled.keyframeTimes[2]).toBeGreaterThan(arrive + 1500);
  });

  test('a lookAt keyframe faces its point; a fixed one keeps its bearing', () => {
    const k2 = compiled.cameraAt(compiled.keyframeTimes[2]);
    const p = plane.toPlane(k2);
    expect(Math.abs(bearingDelta(k2.bearing, bearingOf(-p.x, -p.y)))).toBeLessThan(0.5);
    expect(compiled.cameraAt(compiled.durationMs).bearing).toBeCloseTo(200, 6);
  });

  test('continuous between keyframes', () => {
    let previous = compiled.cameraAt(0);
    for (let t = 16; t <= compiled.durationMs; t += 16) {
      const c = compiled.cameraAt(t);
      expect(distanceMeters(previous, c) / metresPerPixel(c.latitude, c.zoom)).toBeLessThan(20);
      expect(Math.abs(bearingDelta(previous.bearing, c.bearing))).toBeLessThan(4);
      previous = c;
    }
  });

  test('speed scales time, not the path', () => {
    const fast = compileTour({ ...TOUR, speed: 2 });
    expect(fast?.durationMs).toBeCloseTo(compiled.durationMs / 2, 3);
    expect(fast?.cameraAt(fast.durationMs)).toEqual(compiled.cameraAt(compiled.durationMs));
  });

  test('a pivot (two keyframes at one place) still turns, and takes time to', () => {
    const pivot = compileTour({
      speed: 1,
      keyframes: [
        keyframe({ center: ORIGIN, aim: 'fixed', bearing: 0 }),
        keyframe({ center: ORIGIN, aim: 'fixed', bearing: 120 }),
      ],
    });
    expect(pivot?.durationMs).toBeGreaterThanOrEqual(1200);
    expect(pivot?.cameraAt((pivot?.durationMs ?? 0) / 2).bearing).toBeGreaterThan(10);
  });

  test('fewer than two keyframes is not a tour', () => {
    expect(compileTour({ speed: 1, keyframes: [keyframe({ center: ORIGIN })] })).toBeNull();
  });
});
