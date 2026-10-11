/**
 * The city sky's model (`engine/city3d/atmosphere.ts`): the questions a
 * reviewer asks of a sky — is noon blue, is sunset orange, is the night dark
 * but legible, does haze grow with distance — answered as numbers, so a
 * constant tuned on a screenshot cannot quietly break one of them.
 */
import { describe, expect, test } from 'bun:test';

import {
  adaptedBrightness,
  computeSkyState,
  HAZE,
  hazeTransmittance,
  hostSkyColours,
  luminance,
  quantizeAltitude,
  type Rgb,
  SHADOW_OPACITY,
  SKY_LUT_HEIGHT,
  SKY_LUT_WIDTH,
  skyStateFor,
  sunDirection,
  tonemapSky,
} from '@/components/map/engine/city3d/atmosphere';
import { glslFloat } from '@/components/map/engine/city3d/shaders';
import {
  skyCityFragmentShader,
  skyPassFragmentShader,
} from '@/components/map/engine/city3d/skyShaders';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/** A LUT texel as 0–1 sRGB. */
function texel(lut: Uint8Array, x: number, y: number): Rgb {
  const o = (y * SKY_LUT_WIDTH + x) * 4;
  return [lut[o] / 255, lut[o + 1] / 255, lut[o + 2] / 255];
}

describe('sunDirection', () => {
  test('compass azimuth and altitude to ENU', () => {
    const east = sunDirection({ azimuthDeg: 90, altitudeDeg: 0 });
    expect(close(east[0], 1) && close(east[1], 0) && close(east[2], 0)).toBe(true);
    const south = sunDirection({ azimuthDeg: 180, altitudeDeg: 45 });
    expect(close(south[0], 0)).toBe(true);
    expect(close(south[1], -Math.SQRT1_2)).toBe(true);
    expect(close(south[2], Math.SQRT1_2)).toBe(true);
  });
});

describe('aerial perspective', () => {
  test('nothing over no distance; less and less with distance; blue goes first', () => {
    expect(hazeTransmittance(500, -0.5, 0)).toEqual([1, 1, 1]);
    let previous: Rgb = [1, 1, 1];
    // A ray falling 1 in 100 from 500 m: it meets the ground at 50 km.
    for (const d of [100, 500, 2000, 10_000, 50_000]) {
      const t = hazeTransmittance(500, -0.01, d);
      for (let c = 0; c < 3; c++) expect(t[c]).toBeLessThan(previous[c]);
      expect(t[2]).toBeLessThan(t[0]);
      previous = t;
    }
  });

  test('the closed form is the integral of the exponential atmosphere', () => {
    // Riemann sum of the same densities along the same ray.
    const h0 = 300;
    const dz = -0.2;
    const d = 1500;
    const steps = 20_000;
    let rayleigh = 0;
    let mie = 0;
    for (let i = 0; i < steps; i++) {
      const h = h0 + ((i + 0.5) / steps) * d * dz;
      rayleigh += Math.exp(-h / HAZE.rayleighScaleHeightM) * (d / steps);
      mie += Math.exp(-h / HAZE.mieScaleHeightM) * (d / steps);
    }
    const t = hazeTransmittance(h0, dz, d);
    for (let c = 0; c < 3; c++) {
      const expected = Math.exp(-(HAZE.rayleigh[c] * rayleigh + HAZE.mie * mie));
      expect(Math.abs(t[c] - expected)).toBeLessThan(1e-6);
    }
  });

  test('stable for a horizontal ray', () => {
    const level = hazeTransmittance(200, 0, 5000);
    const almost = hazeTransmittance(200, 1e-9, 5000);
    for (let c = 0; c < 3; c++) expect(Math.abs(level[c] - almost[c])).toBeLessThan(1e-9);
  });

  test('the shaders are generated from the same constants', () => {
    for (const shader of [
      skyCityFragmentShader('openmaptiles'),
      skyCityFragmentShader('goway'),
      skyPassFragmentShader('multiply'),
    ]) {
      expect(shader).toContain(`const float HAZE_MIE = ${glslFloat(HAZE.mie)};`);
      expect(shader).toContain(glslFloat(HAZE.rayleigh[2]));
    }
  });
});

describe('the sky', () => {
  test('noon: blue overhead, paler at the horizon, and the table is complete', () => {
    const state = computeSkyState(60, 'light');
    expect(state.lut.length).toBe(SKY_LUT_WIDTH * SKY_LUT_HEIGHT * 4);
    const zenith = texel(state.lut, SKY_LUT_WIDTH - 1, SKY_LUT_HEIGHT - 1);
    const horizon = texel(state.lut, SKY_LUT_WIDTH - 1, 0);
    expect(zenith[2]).toBeGreaterThan(zenith[0] * 1.3);
    expect(luminance(horizon)).toBeGreaterThan(luminance(zenith));
    // Pale BLUE, not grey-green: the defect the sky-tinted multiple scattering
    // and the hue-keeping tone map exist to prevent.
    expect(horizon[2]).toBeGreaterThan(horizon[1]);
    expect(horizon[1]).toBeGreaterThan(horizon[0]);
  });

  test('sunset: the sun is orange, and redder the lower it is', () => {
    const noon = computeSkyState(60, 'light').sunColor;
    const low = computeSkyState(2, 'light').sunColor;
    expect(low[0]).toBeGreaterThan(low[1]);
    expect(low[1]).toBeGreaterThan(low[2]);
    expect(low[2] / low[0]).toBeLessThan(noon[2] / noon[0] / 3);
  });

  test('night: no sun, no shadows, a deep blue-violet sky, a blue ambient that is never black', () => {
    const night = computeSkyState(-20, 'light');
    expect(night.sunColor).toEqual([0, 0, 0]);
    expect(night.shadowStrength).toBe(0);
    expect(night.sunDisc).toEqual([0, 0, 0]);
    const zenith = texel(night.lut, 0, SKY_LUT_HEIGHT - 1);
    const horizon = texel(night.lut, 0, 0);
    expect(luminance(zenith)).toBeLessThan(0.2);
    // Blue-violet: blue dominant, red above green.
    expect(zenith[2]).toBeGreaterThan(zenith[0] * 2.5);
    expect(zenith[0]).toBeGreaterThan(zenith[1] * 0.8);
    expect(luminance(horizon)).toBeGreaterThan(luminance(zenith));
    expect(night.skyAmbient[2]).toBeGreaterThan(night.skyAmbient[0]);
    expect(luminance(night.skyAmbient)).toBeGreaterThan(0.1);
  });

  test('the warm street glow is a night thing only', () => {
    expect(computeSkyState(30, 'light').streetGlow).toEqual([0, 0, 0]);
    const glow = computeSkyState(-20, 'light').streetGlow;
    expect(glow[0]).toBeGreaterThan(glow[2]);
    expect(glow[0]).toBeGreaterThan(0);
  });

  test('the light is a multiplier on the map: a horizontal surface gets the adapted brightness', () => {
    for (const altitude of [70, 30, 8, 2, -3, -9, -30]) {
      for (const appearance of ['light', 'dark'] as const) {
        const s = computeSkyState(altitude, appearance);
        const up = Math.max(0, Math.sin((altitude * Math.PI) / 180));
        const horizontal: Rgb = [0, 1, 2].map((c) => s.sunColor[c] * up + s.skyAmbient[c]) as Rgb;
        // Within the share the direct sun cap (MAX_SUN) may take away.
        expect(luminance(horizontal)).toBeLessThanOrEqual(s.brightness + 1e-9);
        expect(luminance(horizontal)).toBeGreaterThan(s.brightness * 0.75);
      }
    }
  });

  test('shadows fade out as the sun sets, not at once', () => {
    // Never a black slot: a full shadow keeps part of the light.
    expect(SHADOW_OPACITY).toBeLessThan(1);
    expect(computeSkyState(10, 'light').shadowStrength).toBe(SHADOW_OPACITY);
    const dusk = computeSkyState(1.6, 'light').shadowStrength;
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(SHADOW_OPACITY);
    expect(computeSkyState(0, 'light').shadowStrength).toBe(0);
  });
});

describe('adaptedBrightness', () => {
  test('1 by day, never darker than the night floor, monotonic in altitude', () => {
    for (const appearance of ['light', 'dark'] as const) {
      expect(adaptedBrightness(45, appearance)).toBe(1);
      let previous = 0;
      for (let altitude = -40; altitude <= 40; altitude += 0.5) {
        const b = adaptedBrightness(altitude, appearance);
        expect(b).toBeGreaterThanOrEqual(previous);
        expect(b).toBeGreaterThanOrEqual(adaptedBrightness(-90, appearance));
        previous = b;
      }
    }
    // The dark map is already dark: it is dimmed far less at night.
    expect(adaptedBrightness(-20, 'dark')).toBeGreaterThan(adaptedBrightness(-20, 'light'));
  });
});

describe('tonemapSky', () => {
  test('keeps a colour’s hue below white, and goes to white above it', () => {
    const blue = tonemapSky([0.1, 0.2, 0.4]);
    expect(blue[2] / blue[0]).toBeCloseTo(4, 6);
    const blown = tonemapSky([30, 25, 20]);
    for (const c of blown) expect(c).toBeGreaterThan(0.9);
    expect(tonemapSky([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('skyStateFor', () => {
  test('cached per rounded altitude, so panning and small scrubs cost nothing', () => {
    expect(quantizeAltitude(12.34)).toBe(12.4);
    expect(quantizeAltitude(-0.04)).toBe(0);
    const a = skyStateFor(20.01, 'light');
    const b = skyStateFor(19.99, 'light');
    expect(b).toBe(a);
    expect(skyStateFor(20.01, 'dark')).not.toBe(a);
  });
});

describe('hostSkyColours', () => {
  test('MapLibre’s sky follows the city sky: blue by day, the night’s own blue-violet at night', () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const day = hostSkyColours(computeSkyState(50, 'light').lut);
    const night = hostSkyColours(computeSkyState(-20, 'light').lut);
    for (const colours of [day, night]) {
      for (const hex of Object.values(colours)) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(rgb(day.sky)[2]).toBeGreaterThan(rgb(day.sky)[0]);
    // The fog that tints distant terrain is the night's horizon, not a pale
    // band: dark, and blue-dominant.
    const fog = rgb(night.fog);
    expect(fog[2]).toBeGreaterThan(fog[0]);
    expect((fog[0] + fog[1] + fog[2]) / 3).toBeLessThan(110);
  });
});
