/** Landmarks are off unless a build or a DEVELOPMENT tab asks; their night follows `nightFactor`. */
import { describe, expect, test } from 'bun:test';

import { NIGHT_FADE_DEG, nightFactor } from '@/lib/map/landmarks/night';
import { isLandmarksRequested } from '@/lib/map/landmarksFlag';

describe('isLandmarksRequested', () => {
  test('off by default, in development and production alike', () => {
    expect(isLandmarksRequested({ enabled: false, development: false, search: '' })).toBe(false);
    expect(isLandmarksRequested({ enabled: false, development: true, search: '' })).toBe(false);
  });

  test('the build flag turns it on everywhere', () => {
    expect(isLandmarksRequested({ enabled: true, development: false, search: '' })).toBe(true);
  });

  test('the query parameter works in development only', () => {
    expect(
      isLandmarksRequested({ enabled: false, development: true, search: '?landmarks=1' }),
    ).toBe(true);
    expect(
      isLandmarksRequested({
        enabled: false,
        development: true,
        search: '?city3d=1&landmarks=true',
      }),
    ).toBe(true);
    expect(
      isLandmarksRequested({ enabled: false, development: false, search: '?landmarks=1' }),
    ).toBe(false);
    expect(
      isLandmarksRequested({ enabled: false, development: true, search: '?landmarks=0' }),
    ).toBe(false);
  });
});

describe('nightFactor', () => {
  test('without a sun, the dark map is the night map', () => {
    expect(nightFactor({ appearance: 'dark' })).toBe(1);
    expect(nightFactor({ appearance: 'light' })).toBe(0);
  });

  test("with a sun, a light map darkens through the night sky's own fade", () => {
    expect(nightFactor({ appearance: 'light', sunAltitudeDeg: 30 })).toBe(0);
    expect(nightFactor({ appearance: 'light', sunAltitudeDeg: NIGHT_FADE_DEG[0] })).toBe(0);
    expect(nightFactor({ appearance: 'light', sunAltitudeDeg: NIGHT_FADE_DEG[1] })).toBe(1);
    const dusk = nightFactor({ appearance: 'light', sunAltitudeDeg: -5 });
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
    expect(nightFactor({ appearance: 'dark', sunAltitudeDeg: 40 })).toBe(1);
    expect(nightFactor({ appearance: 'light', sunAltitudeDeg: Number.NaN })).toBe(0);
  });
});
