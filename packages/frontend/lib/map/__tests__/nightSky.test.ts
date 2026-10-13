/**
 * The city sky's night as each style draws it (`lib/map/style/nightSky.ts`):
 * one source, every style's derived from Standard's by its own colour
 * function, the brightness kept, and Monochrome's night achromatic.
 */
import { describe, expect, test } from 'bun:test';

import { computeSkyState } from '@/components/map/engine/city3d/atmosphere';
import { rgbToOklch } from '@/lib/map/colour';
import { MAP_STYLE_IDS, mapStyleDefinition } from '@/lib/map/style/catalogue';
import { CITY_NIGHT_SKY, styleNightSky } from '@/lib/map/style/nightSky';
import { styleTheme } from '@/lib/map/style/themes';

type Rgb = readonly [number, number, number];

/** A display colour's (channels 0–1) OKLCh chroma. */
const chroma = (rgb: Rgb) => rgbToOklch(rgb.map((v) => v * 255) as unknown as Rgb)[1];

/** A LIGHT's (linear, any brightness) chroma: its colour at full scale, as shown. */
function lightChroma(light: Rgb): number {
  const peak = Math.max(...light, 1e-12);
  return chroma(light.map((v) => (v / peak) ** (1 / 2.2)) as unknown as Rgb);
}

const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** The night LUT's pixels (display sRGB bytes), as colours. */
function lutColours(lut: Uint8Array): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < lut.length; i += 4)
    out.push([lut[i] / 255, lut[i + 1] / 255, lut[i + 2] / 255]);
  return out;
}

describe('the city sky’s night per style', () => {
  test('one source: the theme’s night is the style’s, and Standard’s is the art direction’s', () => {
    for (const style of MAP_STYLE_IDS) {
      for (const preset of mapStyleDefinition(style).presets) {
        expect(styleTheme({ style, preset }).nightSky).toBe(styleNightSky(style));
      }
    }
    expect(styleNightSky('standard')).toBe(CITY_NIGHT_SKY);
  });

  test('a style changes the night’s colour, never how dark or bright its lights are', () => {
    for (const style of MAP_STYLE_IDS) {
      const night = styleNightSky(style);
      for (const key of ['ambient', 'streetGlow', 'floodlight'] as const) {
        expect(luma(night[key]) / luma(CITY_NIGHT_SKY[key]), `${style} ${key}`).toBeCloseTo(1, 2);
      }
    }
  });

  test('Monochrome’s night is achromatic: the light, the sky, and the buildings it lights', () => {
    const night = styleNightSky('monochrome');
    const state = computeSkyState(-20, 'dark', night);
    // Vacuity: Standard's night is blue-violet.
    const standard = computeSkyState(-20, 'dark', CITY_NIGHT_SKY);
    expect(lightChroma(standard.skyAmbient)).toBeGreaterThan(0.1);

    for (const light of [
      state.skyAmbient,
      state.groundBounce,
      state.streetGlow,
      night.floodlight,
    ]) {
      expect(lightChroma(light)).toBeLessThan(0.02);
    }
    for (const colour of lutColours(state.lut)) expect(chroma(colour)).toBeLessThan(0.02);

    // A building at night: the clay lit by the night's light, and the lit
    // windows — every colour on it.
    const clay = styleTheme({ style: 'monochrome', preset: 'night' }).materials.night;
    for (const albedo of [clay.low, clay.tall, clay.veryTall, clay.glass]) {
      const lit = albedo.map((v, c) => v * state.skyAmbient[c]) as unknown as Rgb;
      expect(lightChroma(lit)).toBeLessThan(0.02);
    }
    for (const glow of [clay.windowGlow, clay.windowGlowCool])
      expect(lightChroma(glow)).toBeLessThan(0.02);
  });

  test('the data basemaps and Navigation keep only a whisper of the blue', () => {
    const standard = lightChroma(CITY_NIGHT_SKY.ambient);
    for (const style of ['light', 'dark', 'navigation'] as const) {
      expect(lightChroma(styleNightSky(style).ambient)).toBeLessThan(standard * 0.35);
    }
  });
});
