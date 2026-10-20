import { describe, expect, test } from 'bun:test';

import {
  formatScale,
  metresPerPixel,
  niceNumber,
  SCALE_MAX_WIDTH,
  scaleFor,
  scaleSystemFor,
} from '../src/scale';

describe('niceNumber', () => {
  test('is the largest 1, 2 or 5 times a power of ten that fits', () => {
    expect(niceNumber(0.9)).toBe(0.5);
    expect(niceNumber(1)).toBe(1);
    expect(niceNumber(1.9)).toBe(1);
    expect(niceNumber(2)).toBe(2);
    expect(niceNumber(7)).toBe(5);
    expect(niceNumber(99)).toBe(50);
    expect(niceNumber(1000)).toBe(1000);
  });
});

describe('scaleFor', () => {
  test('is never wider than the room and never absurdly narrow', () => {
    for (let zoom = 0; zoom <= 20; zoom += 0.5) {
      for (const latitude of [0, 35.7, 60, 80]) {
        for (const system of ['metric', 'imperial'] as const) {
          const reading = scaleFor(latitude, zoom, system);
          expect(reading).not.toBeNull();
          expect(reading?.width).toBeLessThanOrEqual(SCALE_MAX_WIDTH + 1e-9);
          expect(reading?.width).toBeGreaterThan(SCALE_MAX_WIDTH * 0.19);
        }
      }
    }
  });

  test('shrinks the distance a pixel stands for with latitude and zoom', () => {
    expect(metresPerPixel(60, 10)).toBeCloseTo(metresPerPixel(0, 10) / 2, 6);
    expect(metresPerPixel(0, 11)).toBeCloseTo(metresPerPixel(0, 10) / 2, 6);
  });

  test('reads kilometres once a round number reaches 1000 m', () => {
    expect(scaleFor(0, 8, 'metric')?.unit).toBe('km');
    expect(scaleFor(0, 16, 'metric')?.unit).toBe('m');
  });

  test('reads feet up close and miles far out', () => {
    expect(scaleFor(40, 18, 'imperial')?.unit).toBe('ft');
    expect(scaleFor(40, 6, 'imperial')?.unit).toBe('mi');
  });

  test('has no scale where the projection has none', () => {
    expect(scaleFor(90, 5, 'metric')).toBeNull();
    expect(scaleFor(Number.NaN, 5, 'metric')).toBeNull();
  });
});

describe('scaleSystemFor', () => {
  test('is imperial for the regions that read miles, metric otherwise', () => {
    expect(scaleSystemFor('en-US')).toBe('imperial');
    expect(scaleSystemFor('en-GB')).toBe('metric');
    expect(scaleSystemFor('es')).toBe('metric');
    expect(scaleSystemFor('es_ES')).toBe('metric');
  });
});

describe('formatScale', () => {
  test('writes the unit in the reader’s locale', () => {
    expect(formatScale({ width: 80, value: 500, unit: 'm' }, 'en')).toBe('500 m');
    expect(formatScale({ width: 80, value: 2, unit: 'km' }, 'en')).toBe('2 km');
  });
});
