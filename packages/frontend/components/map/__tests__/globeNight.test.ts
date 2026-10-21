/**
 * Day and night on the globe (`lib/map/style/globeNight.ts`): that the light
 * is the city sky's at every sun altitude, so the two hand over without a
 * pop at z12–13; that a map following the sun is continuous where one of its
 * documents hands over to the next (`sunLadder.ts`); and that the night
 * follows the real sun.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeSkyState, type SkyGround } from '@/components/map/engine/city3d/atmosphere';
import { EFFECT_ZOOM } from '@/components/map/engine/city3d/sky';
import { invert4 } from '@/components/map/globeNightLayer.web';
import { hexToRgb } from '@/lib/map/colour';
import {
  MAP_STYLE_IDS,
  type MapLightPreset,
  type MapStyleId,
  mapStyleDefinition,
  presetDocumentLight,
  SUN_HORIZON_DEG,
  SUN_LIGHT_BAND,
  TWILIGHT_DOCUMENT_DEG,
} from '@/lib/map/style/catalogue';
import {
  GLOBE_NIGHT_FADE_ZOOM,
  globeLight,
  globeNightFor,
  globeNightOpacity,
  globeVector,
} from '@/lib/map/style/globeNight';
import { CITY_NIGHT_SKY, type CityNightSky, styleNightSky } from '@/lib/map/style/nightSky';
import {
  landLuma,
  type SunLadder,
  type SunLadderLands,
  sunLandsOf,
} from '@/lib/map/style/sunLadder';
import { styleTheme } from '@/lib/map/style/themes';
import { subsolarPoint, sunPosition } from '@/lib/map/sun';

/** The city sky's ground pass at a sun altitude: `pow(sun·sin(alt) + sky, 1/2.2)`, no haze. */
function cityGroundLight(
  altitudeDeg: number,
  appearance: 'light' | 'twilight' | 'dark',
  night: CityNightSky = CITY_NIGHT_SKY,
  ground?: SkyGround,
): number[] {
  const s = computeSkyState(altitudeDeg, appearance, night, ground);
  const up = Math.max(0, Math.sin((altitudeDeg * Math.PI) / 180));
  return [0, 1, 2].map((c) =>
    Math.min(1, ((s.sunColor as number[])[c] * up + (s.skyAmbient as number[])[c]) ** (1 / 2.2)),
  );
}

const mean = (v: readonly number[]) => (v[0] + v[1] + v[2]) / 3;

/** A document on its own: no lands, its base curve. */
const alone = (preset: MapLightPreset): SunLadder => ({ preset, followsSun: false, lands: null });

/** A style's lands, as its themes paint them. */
function landsOf(style: MapStyleId): SunLadderLands {
  return Object.fromEntries(
    mapStyleDefinition(style).presets.map((preset) => [
      preset,
      hexToRgb(styleTheme({ style, preset }).palette.land),
    ]),
  ) as unknown as SunLadderLands;
}

const FOLLOWING = MAP_STYLE_IDS.filter((id) => mapStyleDefinition(id).light === 'follows');

describe('globe night', () => {
  test('full night is the city sky’s night, per style and appearance', () => {
    for (const style of MAP_STYLE_IDS) {
      const night = styleNightSky(style);
      for (const appearance of ['light', 'dark'] as const) {
        const city = cityGroundLight(-20, appearance, night);
        const preset = appearance === 'light' ? 'day' : 'night';
        globeNightFor(night.ambient, alone(preset)).night.forEach((v, c) => {
          expect(Math.abs(v - city[c]), `${style} ${appearance}`).toBeLessThan(0.01);
        });
      }
    }
  });

  test('dawn and dusk documents are twilight, not day: their own low sun is not drawn twice', () => {
    expect(presetDocumentLight('dawn')).toBe('twilight');
    expect(presetDocumentLight('dusk')).toBe('twilight');
    expect(presetDocumentLight('day')).toBe('light');
    expect(presetDocumentLight('night')).toBe('dark');
    const dusk = globeNightFor(CITY_NIGHT_SKY.ambient, alone('dusk'));
    const day = globeNightFor(CITY_NIGHT_SKY.ambient, alone('day'));
    // At −1° the day map is already darkened; the dusk map, drawn for −1°, is not.
    expect(mean(globeLight(TWILIGHT_DOCUMENT_DEG, day))).toBeLessThan(0.95);
    expect(globeLight(TWILIGHT_DOCUMENT_DEG, dusk)).toEqual([1, 1, 1]);
  });

  test('over a dawn or dusk map it darkens only past the twilight the map already draws', () => {
    const lands = landsOf('standard');
    for (const preset of ['dawn', 'dusk'] as const) {
      const twilight = globeNightFor(CITY_NIGHT_SKY.ambient, {
        preset,
        followsSun: true,
        lands,
      });
      // At (and above) the altitude the document stands for: nothing more.
      expect(globeLight(TWILIGHT_DOCUMENT_DEG, twilight)).toEqual([1, 1, 1]);
      expect(globeLight(TWILIGHT_DOCUMENT_DEG + 2, twilight)).toEqual([1, 1, 1]);
      // Below it, darker as the sun goes down.
      let previous = 1;
      for (let alt = TWILIGHT_DOCUMENT_DEG; alt >= -20; alt -= 0.5) {
        const light = mean(globeLight(alt, twilight));
        expect(light, `${preset} ${alt}°`).toBeLessThanOrEqual(previous + 1e-6);
        previous = light;
      }
      // ...and it follows the city sky's ground light over the same map, on
      // the same ladder, within 0.15.
      const ground: SkyGround = { ladder: { preset, followsSun: true, lands }, morning: false };
      for (const alt of [-1, -3, -6, -10, -15]) {
        const city = cityGroundLight(alt, 'twilight', CITY_NIGHT_SKY, ground);
        const globe = globeLight(alt, twilight);
        expect(Math.abs(mean(globe) - mean(city)), `${preset} ${alt}°`).toBeLessThan(0.15);
      }
    }
  });

  test('through the twilight it stays close to the city sky’s light', () => {
    for (const alt of [30, 10, 4, 2, 0, -2, -4, -6, -8, -10, -15]) {
      const city = cityGroundLight(alt, 'light');
      const globe = globeLight(alt, globeNightFor(CITY_NIGHT_SKY.ambient, alone('day')));
      // The day side is left as drawn (a multiply cannot brighten the city's
      // 1.02 noon red), so compare the mean, within 0.12.
      expect(Math.abs(mean(globe) - mean(city))).toBeLessThan(0.12);
    }
    expect(globeLight(60, globeNightFor(CITY_NIGHT_SKY.ambient, alone('day')))).toEqual([1, 1, 1]);
  });

  test('the published documents carry their style’s lands', () => {
    for (const style of FOLLOWING) {
      for (const preset of mapStyleDefinition(style).presets) {
        const document = JSON.parse(
          readFileSync(join(import.meta.dir, `../../../public/map/styles/${style}/${preset}.json`), 'utf8'),
        );
        const lands = sunLandsOf(document.metadata);
        const expected = landsOf(style);
        expect(lands, `${style}/${preset}`).not.toBeNull();
        for (const key of Object.keys(expected) as (keyof SunLadderLands)[]) {
          (lands?.[key] ?? []).forEach((v, c) => {
            expect(v).toBeCloseTo((expected[key] as readonly number[])[c], 6);
          });
        }
      }
    }
  });
});

/**
 * Where the sun hands the map from one document to the next, what is drawn
 * on either side of that altitude — the document's land times the light laid
 * over it — is the same colour: the night does not jump when the light does.
 */
describe('sun ladder: no jump where the documents hand over', () => {
  const composite = (land: readonly number[], light: readonly number[]) =>
    [0, 1, 2].map((c) => land[c] * light[c]);
  const nightOf = (style: MapStyleId, preset: MapLightPreset) =>
    globeNightFor(styleNightSky(style).ambient, {
      preset,
      followsSun: true,
      lands: landsOf(style),
    });

  /** The globe's composite of `preset`'s document at `alt`, and the next one's. */
  function across(
    style: MapStyleId,
    above: MapLightPreset,
    below: MapLightPreset,
    alt: number,
    morning: boolean,
  ) {
    const lands = landsOf(style) as unknown as Record<string, readonly number[]>;
    return {
      upper: composite(lands[above], globeLight(alt, nightOf(style, above), morning)),
      lower: composite(lands[below], globeLight(alt, nightOf(style, below), morning)),
    };
  }

  test('globe: dusk → night at −6°, dawn → night at −6° in the morning', () => {
    for (const [preset, morning] of [
      ['dusk', false],
      ['dawn', true],
    ] as const) {
      const { upper, lower } = across('standard', preset, 'night', SUN_LIGHT_BAND.night, morning);
      upper.forEach((v, c) => expect(Math.abs(v - lower[c]), `${preset} ${c}`).toBeLessThan(0.002));
    }
  });

  test('globe: day → dusk at 4° in the evening, day → dawn at 4° in the morning', () => {
    for (const [preset, morning] of [
      ['dusk', false],
      ['dawn', true],
    ] as const) {
      const { upper, lower } = across('standard', 'day', preset, SUN_LIGHT_BAND.day, morning);
      upper.forEach((v, c) => expect(Math.abs(v - lower[c]), `${preset} ${c}`).toBeLessThan(0.002));
    }
  });

  test('globe: a style without dawn or dusk, day → night at the horizon', () => {
    for (const style of FOLLOWING.filter((id) => !mapStyleDefinition(id).presets.includes('dusk'))) {
      for (const morning of [false, true]) {
        const { upper, lower } = across(style, 'day', 'night', SUN_HORIZON_DEG, morning);
        upper.forEach((v, c) => expect(Math.abs(v - lower[c]), `${style} ${c}`).toBeLessThan(0.01));
      }
    }
  });

  test('a map that does not follow the sun keeps the day curve: it never changes document', () => {
    const fixed = globeNightFor(CITY_NIGHT_SKY.ambient, {
      preset: 'day',
      followsSun: false,
      lands: landsOf('standard'),
    });
    const base = globeNightFor(CITY_NIGHT_SKY.ambient, alone('day'));
    for (let alt = 12; alt >= -20; alt -= 1) {
      expect(globeLight(alt, fixed)).toEqual(globeLight(alt, base));
    }
  });

  /**
   * The luma of what the city sky's ground pass draws over `preset`'s land
   * at `alt` (its light is one colour for every document, so it is matched
   * on luma), and the next document's.
   */
  function cityAcross(
    style: MapStyleId,
    above: MapLightPreset,
    below: MapLightPreset,
    alt: number,
    morning: boolean,
  ) {
    const lands = landsOf(style);
    const drawn = (preset: MapLightPreset) => {
      const light = cityGroundLight(alt, presetDocumentLight(preset), styleNightSky(style), {
        ladder: { preset, followsSun: true, lands },
        morning,
      });
      const land = (lands as unknown as Record<string, readonly number[]>)[preset];
      return landLuma(composite(land, light) as unknown as readonly [number, number, number]);
    };
    return { upper: drawn(above), lower: drawn(below) };
  }

  test('city sky: the ground pass hands over at −6° and at 4° without a jump', () => {
    for (const [above, below, alt, morning] of [
      ['dusk', 'night', SUN_LIGHT_BAND.night, false],
      ['dawn', 'night', SUN_LIGHT_BAND.night, true],
      ['day', 'dusk', SUN_LIGHT_BAND.day, false],
      ['day', 'dawn', SUN_LIGHT_BAND.day, true],
    ] as const) {
      const { upper, lower } = cityAcross('standard', above, below, alt, morning);
      expect(Math.abs(upper - lower), `${above} → ${below}`).toBeLessThan(0.002);
    }
    for (const style of FOLLOWING.filter((id) => !mapStyleDefinition(id).presets.includes('dusk'))) {
      const { upper, lower } = cityAcross(style, 'day', 'night', SUN_HORIZON_DEG, false);
      expect(Math.abs(upper - lower), style).toBeLessThan(0.002);
    }
  });
});

describe('globe night, geometry', () => {
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
