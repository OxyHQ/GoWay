/**
 * EXIF GPS normalization.
 *
 * The assertions that matter here are the REFUSALS. A conversion that gets the
 * happy path right and drops the hemisphere ref still "works": it produces a
 * plausible coordinate, in the wrong hemisphere, that every downstream query
 * answers normally. So the tests below check that a southern photo comes out
 * negative, that a swapped pair is refused rather than reinterpreted, and that
 * corrupt tags produce `null` rather than a clamped guess.
 */

import { describe, expect, it } from 'bun:test';
import { exifGpsToDecimal, normalizeExifGps, normalizeExifOrientation } from '../exif';

describe('exifGpsToDecimal', () => {
  it('converts degrees, minutes and seconds', () => {
    // 41° 23' 6.36" = 41.3851, which is Barcelona.
    expect(exifGpsToDecimal({ degrees: 41, minutes: 23, seconds: 6.36, ref: 'N' })).toBeCloseTo(41.3851, 6);
  });

  it('applies the hemisphere ref, which is the whole point', () => {
    const north = exifGpsToDecimal({ degrees: 41, minutes: 23, seconds: 6.36, ref: 'N' });
    const south = exifGpsToDecimal({ degrees: 41, minutes: 23, seconds: 6.36, ref: 'S' });
    expect(south).toBe(-(north as number));
  });

  it('accepts a lower-case ref, because cameras write both', () => {
    expect(exifGpsToDecimal({ degrees: 2, ref: 'w' })).toBe(-2);
  });

  it('refuses a missing or unrecognised ref rather than assuming north', () => {
    expect(exifGpsToDecimal({ degrees: 41, ref: '' })).toBeNull();
    expect(exifGpsToDecimal({ degrees: 41, ref: 'X' })).toBeNull();
  });

  it('refuses sexagesimal values outside their range', () => {
    // 61 minutes is not 1° 1'. It is a tag this code did not understand, and
    // carrying on would move the photo by a kilometre without complaint.
    expect(exifGpsToDecimal({ degrees: 41, minutes: 61, ref: 'N' })).toBeNull();
    expect(exifGpsToDecimal({ degrees: 41, seconds: 60, ref: 'N' })).toBeNull();
    expect(exifGpsToDecimal({ degrees: -1, ref: 'N' })).toBeNull();
  });
});

describe('normalizeExifGps', () => {
  const barcelona = {
    latitude: { degrees: 41, minutes: 23, seconds: 6.36, ref: 'N' },
    longitude: { degrees: 2, minutes: 10, seconds: 24.24, ref: 'E' },
  };

  it('produces a GoWay coordinate', () => {
    const normalized = normalizeExifGps(barcelona);
    expect(normalized?.coordinate.latitude).toBeCloseTo(41.3851, 5);
    expect(normalized?.coordinate.longitude).toBeCloseTo(2.1734, 5);
  });

  it('refuses a block whose two magnitudes have been swapped', () => {
    // `GPSLatitudeRef = E` is not a latitude with an odd ref — it is the
    // transposed pair, which yields a plausible point in the wrong place rather
    // than an error. This is the cheapest place on earth to catch it.
    expect(
      normalizeExifGps({ latitude: barcelona.longitude, longitude: barcelona.latitude }),
    ).toBeNull();
  });

  it('signs the altitude by its own ref, which is a second hemisphere trap', () => {
    expect(normalizeExifGps({ ...barcelona, altitude: 12, altitudeRef: 0 })?.altitudeMeters).toBe(12);
    expect(normalizeExifGps({ ...barcelona, altitude: 12, altitudeRef: 1 })?.altitudeMeters).toBe(-12);
  });

  it('wraps an image direction into [0, 360), which the column requires', () => {
    expect(normalizeExifGps({ ...barcelona, imageDirection: 360 })?.headingDegrees).toBe(0);
    expect(normalizeExifGps({ ...barcelona, imageDirection: -10 })?.headingDegrees).toBe(350);
  });

  it('refuses a latitude past the pole rather than clamping it', () => {
    // Clamping turns a detectable error into a confident wrong position, which
    // is the one outcome geographic code must never produce.
    expect(
      normalizeExifGps({ ...barcelona, latitude: { degrees: 95, ref: 'N' } }),
    ).toBeNull();
  });
});

describe('normalizeExifOrientation', () => {
  it('keeps the eight real values', () => {
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(normalizeExifOrientation(value)).toBe(value);
    }
  });

  it('drops anything else instead of defaulting to upright', () => {
    // Defaulting to 1 asserts "this image is already the right way up", which is
    // a claim about pixels nobody has looked at.
    expect(normalizeExifOrientation(0)).toBeUndefined();
    expect(normalizeExifOrientation(9)).toBeUndefined();
    expect(normalizeExifOrientation(1.5)).toBeUndefined();
    expect(normalizeExifOrientation(undefined)).toBeUndefined();
  });
});
