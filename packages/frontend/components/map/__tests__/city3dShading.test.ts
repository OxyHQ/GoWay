/**
 * The city-3D occlusion and lighting numbers, and the shader generated from
 * them.
 *
 * The shader is checked only for what can go wrong in TEXT: that it carries
 * the tested constants as valid GLSL float literals. Whether it draws what the
 * numbers say is a rendering question, verified in a browser and recorded in
 * `docs/MAP_3D_CITY.md`.
 */
import { describe, expect, test } from 'bun:test';

import {
  AO,
  CITY_SHADING,
  cornerOcclusion,
  DEFAULT_CITY_LIGHT,
  groundOcclusion,
  lightFromSunAngles,
  smoothstep,
  surfaceBrightness,
} from '@/components/map/engine/city3d/occlusion';
import { CITY_FRAGMENT_SHADER, glslFloat } from '@/components/map/engine/city3d/shaders';

describe('ground occlusion', () => {
  test('darkest at the ground, none above the reach, monotonic between', () => {
    expect(groundOcclusion(0)).toBeCloseTo(AO.groundMin, 12);
    expect(groundOcclusion(-5)).toBeCloseTo(AO.groundMin, 12);
    expect(groundOcclusion(AO.groundReachM)).toBe(1);
    expect(groundOcclusion(100)).toBe(1);
    let previous = 0;
    for (let z = 0; z <= AO.groundReachM; z += 0.25) {
      const value = groundOcclusion(z);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  test('smoothstep is GLSL’s', () => {
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });
});

describe('corner occlusion', () => {
  test('full depth at a right-angled inside corner, gone at the reach', () => {
    expect(cornerOcclusion(1, 0)).toBeCloseTo(1 - AO.cornerDepth, 12);
    expect(cornerOcclusion(1, AO.cornerReachM)).toBe(1);
    expect(cornerOcclusion(1, AO.cornerReachM / 2)).toBeCloseTo(1 - AO.cornerDepth / 2, 12);
    expect(cornerOcclusion(0, 0)).toBe(1);
  });
});

describe('light', () => {
  test('azimuth is a compass bearing; altitude lifts it', () => {
    const east = lightFromSunAngles(90, 0).direction;
    expect(east[0]).toBeCloseTo(1, 12);
    expect(east[1]).toBeCloseTo(0, 12);
    expect(east[2]).toBeCloseTo(0, 12);
    const overhead = lightFromSunAngles(123, 90).direction;
    expect(overhead[2]).toBeCloseTo(1, 12);
    const below = lightFromSunAngles(0, -20).direction;
    expect(below[2]).toBe(0);
  });

  test('is a unit vector, and the default sun is in the south-west', () => {
    const [x, y, z] = DEFAULT_CITY_LIGHT.direction;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
    expect(z).toBeGreaterThan(0);
  });

  test('roofs read brightest, lit walls next, shaded walls darkest — in both appearances', () => {
    for (const shading of Object.values(CITY_SHADING)) {
      const roof = surfaceBrightness([0, 0, 1], DEFAULT_CITY_LIGHT, shading);
      const lit = surfaceBrightness([-Math.SQRT1_2, -Math.SQRT1_2, 0], DEFAULT_CITY_LIGHT, shading);
      const shaded = surfaceBrightness(
        [Math.SQRT1_2, Math.SQRT1_2, 0],
        DEFAULT_CITY_LIGHT,
        shading,
      );
      expect(roof).toBeGreaterThan(lit);
      expect(lit).toBeGreaterThan(shaded);
    }
  });
});

describe('shader source', () => {
  test('float literals are GLSL floats', () => {
    expect(glslFloat(1)).toBe('1.0');
    expect(glslFloat(0.62)).toBe('0.62');
    expect(glslFloat(7)).toBe('7.0');
    expect(() => glslFloat(Number.NaN)).toThrow();
  });

  test('the fragment shader carries the tested ground-occlusion constants', () => {
    expect(CITY_FRAGMENT_SHADER).toContain(glslFloat(AO.groundMin));
    expect(CITY_FRAGMENT_SHADER).toContain(`smoothstep(0.0, ${glslFloat(AO.groundReachM)}`);
    expect(CITY_FRAGMENT_SHADER).not.toContain('${');
  });
});
