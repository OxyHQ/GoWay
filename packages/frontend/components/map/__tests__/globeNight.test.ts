/**
 * Day and night on the globe (`lib/map/style/globeNight.ts`): that the light
 * is the city sky's at every sun altitude, so the two hand over without a
 * pop at z12–13, and that the night follows the real sun.
 */
import { describe, expect, test } from 'bun:test';

import { computeSkyState } from '@/components/map/engine/city3d/atmosphere';
import { EFFECT_ZOOM } from '@/components/map/engine/city3d/sky';
import { invert4 } from '@/components/map/globeNightLayer.web';
import { MAP_STYLE_IDS, TWILIGHT_DOCUMENT_DEG } from '@/lib/map/style/catalogue';
import {
  GLOBE_NIGHT_FADE_ZOOM,
  globeLight,
  globeNightFor,
  globeNightOpacity,
  globeVector,
} from '@/lib/map/style/globeNight';
import { CITY_NIGHT_SKY, type CityNightSky, styleNightSky } from '@/lib/map/style/nightSky';
import { subsolarPoint, sunPosition } from '@/lib/map/sun';

/** The city sky's ground pass at a sun altitude: `pow(sun·sin(alt) + sky, 1/2.2)`, no haze. */
function cityGroundLight(
  altitudeDeg: number,
  appearance: 'light' | 'twilight' | 'dark',
  night: CityNightSky = CITY_NIGHT_SKY,
): number[] {
  const s = computeSkyState(altitudeDeg, appearance, night);
  const up = Math.max(0, Math.sin((altitudeDeg * Math.PI) / 180));
  return [0, 1, 2].map((c) =>
    Math.min(1, ((s.sunColor as number[])[c] * up + (s.skyAmbient as number[])[c]) ** (1 / 2.2)),
  );
}

describe('globe night', () => {
  test('full night is the city sky’s night, per style and appearance', () => {
    for (const style of MAP_STYLE_IDS) {
      const night = styleNightSky(style);
      for (const appearance of ['light', 'dark'] as const) {
        const city = cityGroundLight(-20, appearance, night);
        globeNightFor(night.ambient, appearance).night.forEach((v, c) => {
          expect(Math.abs(v - city[c]), `${style} ${appearance}`).toBeLessThan(0.01);
        });
      }
    }
  });

  test('over a dawn or dusk map it darkens only past the twilight the map already draws', () => {
    const twilight = globeNightFor(CITY_NIGHT_SKY.ambient, 'twilight');
    const day = globeNightFor(CITY_NIGHT_SKY.ambient, 'light');
    // At (and above) the altitude the document stands for: nothing more.
    expect(globeLight(TWILIGHT_DOCUMENT_DEG, twilight)).toEqual([1, 1, 1]);
    expect(globeLight(TWILIGHT_DOCUMENT_DEG + 2, twilight)).toEqual([1, 1, 1]);
    // Below it, darker as the sun goes down, and never darker than over a day map.
    let previous = 1;
    for (let alt = TWILIGHT_DOCUMENT_DEG; alt >= -20; alt -= 1) {
      const light = globeLight(alt, twilight);
      const mean = (light[0] + light[1] + light[2]) / 3;
      expect(mean).toBeLessThanOrEqual(previous + 1e-9);
      previous = mean;
      globeLight(alt, day).forEach((v, c) => {
        expect(light[c]).toBeGreaterThanOrEqual(v - 1e-9);
      });
    }
    // ...and it follows the city sky's ground light over the same map: the
    // day's fit (within 0.12), divided by the document's light (about 0.8),
    // within 0.15.
    for (const alt of [-1, -3, -6, -10, -15]) {
      const city = cityGroundLight(alt, 'twilight');
      const globe = globeLight(alt, twilight);
      const mean = (v: number[]) => (v[0] + v[1] + v[2]) / 3;
      expect(Math.abs(mean(globe) - mean(city)), `${alt}°`).toBeLessThan(0.15);
    }
  });

  test('through the twilight it stays close to the city sky’s light', () => {
    for (const alt of [30, 10, 4, 2, 0, -2, -4, -6, -8, -10, -15]) {
      const city = cityGroundLight(alt, 'light');
      const globe = globeLight(alt, globeNightFor(CITY_NIGHT_SKY.ambient, 'light'));
      // The day side is left as drawn (a multiply cannot brighten the city's
      // 1.02 noon red), so compare the mean, within 0.12.
      const mean = (v: number[]) => (v[0] + v[1] + v[2]) / 3;
      expect(Math.abs(mean(globe) - mean(city))).toBeLessThan(0.12);
    }
    expect(globeLight(60, globeNightFor(CITY_NIGHT_SKY.ambient, 'light'))).toEqual([1, 1, 1]);
  });

  test('it fades out exactly as the city sky fades in', () => {
    expect(GLOBE_NIGHT_FADE_ZOOM).toEqual(EFFECT_ZOOM);
    expect(globeNightOpacity(3)).toBe(1);
    expect(globeNightOpacity(EFFECT_ZOOM[0])).toBe(1);
    expect(globeNightOpacity(EFFECT_ZOOM[1])).toBe(0);
    expect(globeNightOpacity(12.5)).toBeCloseTo(0.5, 5);
  });

  test('a point’s sun altitude is 90° minus its angle from the subsolar point', () => {
    // What the shader does per pixel, against sunPosition at the same place.
    const date = new Date('2026-06-21T19:40:00Z');
    const sun = globeVector(...(Object.values(subsolarPoint(date)) as [number, number]));
    for (const [lat, lng] of [
      [41.39, 2.17],
      [40.75, -73.98],
      [-33.86, 151.2],
      [78.2, 15.6],
      [-60, -120],
    ]) {
      const n = globeVector(lat, lng);
      const sine = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
      const altitude = (Math.asin(sine) * 180) / Math.PI;
      expect(altitude).toBeCloseTo(sunPosition(date, lat, lng).altitudeDeg, 1);
    }
  });

  test('invert4 inverts a projection', () => {
    const m = [1.2, 0.1, 0, 0, -0.3, 0.9, 0.2, 0, 0, 0.4, -1.01, -1, 3, -2, 5, 7];
    const inv = invert4(m);
    if (!inv) throw new Error('expected an inverse');
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += m[k * 4 + r] * inv[c * 4 + k];
        expect(v).toBeCloseTo(r === c ? 1 : 0, 5);
      }
    }
    expect(invert4(new Array(16).fill(0))).toBeNull();
  });
});
