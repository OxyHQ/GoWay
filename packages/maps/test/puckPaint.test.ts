import { describe, expect, test } from 'bun:test';

import { metresPerPixel } from '../src/scale';
import { puckPaint, samePaint, usableHeading } from '../src/puckPaint';

const camera = { zoom: 16, bearing: 0 };

describe('usableHeading', () => {
  test('is only a course the device actually reported', () => {
    expect(usableHeading(90)).toBe(90);
    expect(usableHeading(360)).toBe(0);
    expect(usableHeading(-1)).toBeNull();
    expect(usableHeading(Number.NaN)).toBeNull();
    expect(usableHeading(null)).toBeNull();
    expect(usableHeading(undefined)).toBeNull();
  });
});

describe('puckPaint', () => {
  test('draws the halo as the device’s own ± in pixels at this zoom', () => {
    const fix = { latitude: 35.7, accuracy: 50, heading: null };
    const paint = puckPaint(fix, camera);
    expect(paint.accuracyRadius).toBe(Math.round(50 / metresPerPixel(35.7, 16)));
    const closer = puckPaint(fix, { ...camera, zoom: 17 });
    expect(closer.accuracyRadius).toBe(Math.round(50 / metresPerPixel(35.7, 17)));
  });

  test('draws no halo when the device reported no accuracy, or one smaller than the dot', () => {
    expect(
      puckPaint({ latitude: 0, accuracy: null, heading: null }, camera).accuracyRadius,
    ).toBeUndefined();
    expect(
      puckPaint({ latitude: 0, accuracy: 0, heading: null }, camera).accuracyRadius,
    ).toBeUndefined();
    expect(
      puckPaint({ latitude: 0, accuracy: 3, heading: null }, { ...camera, zoom: 10 })
        .accuracyRadius,
    ).toBeUndefined();
  });

  test('has no cone at all without a heading', () => {
    const paint = puckPaint({ latitude: 0, accuracy: 10, heading: null }, camera);
    expect(paint.headingUnknown).toBe(true);
    expect(paint.heading).toBeUndefined();
  });

  test('turns the cone against the map’s rotation', () => {
    const fix = { latitude: 0, accuracy: null, heading: 90 };
    expect(puckPaint(fix, { zoom: 16, bearing: 0 }).heading).toBe(90);
    expect(puckPaint(fix, { zoom: 16, bearing: 90 }).heading).toBe(0);
    expect(puckPaint(fix, { zoom: 16, bearing: 180 }).heading).toBe(270);
  });
});

describe('samePaint', () => {
  test('compares by value', () => {
    const a = puckPaint({ latitude: 0, accuracy: 30, heading: 10 }, camera);
    expect(samePaint(a, { ...a })).toBe(true);
    expect(samePaint(a, { ...a, heading: 11 })).toBe(false);
  });
});
