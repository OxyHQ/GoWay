/**
 * The detailed city material (`engine/city3d/materials.ts`): the GLSL's
 * structure, the per-building seed, the window hash, and the lighting model's
 * promises — no black sides by day, buildings a step lighter than the ground
 * at night — computed by the JS mirror of the shader.
 *
 * The GLSL itself is compiled and drawn in a browser (the side-by-sides in
 * `docs/MAP_3D_CITY.md` → Art direction); here it is checked as TEXT.
 */
import { describe, expect, test } from 'bun:test';

import {
  DETAILED_DEFINE,
  DETAILED_SKY_MATERIAL_GLSL,
  MATERIAL_GLSL,
  materialLight,
  materialRamp,
  materialUniformValues,
  pcgHash,
  windowGlowAt,
  windowIsLit,
} from '@/components/map/engine/city3d/materials';
import { buildingSeed, meshOsmBuildings } from '@/components/map/engine/city3d/osmMesher';
import type { OsmBuilding } from '@/components/map/engine/city3d/osmTiles';
import { OSM_FRAGMENT_SHADER, TAG_TEMPER } from '@/components/map/engine/city3d/osmShaders';
import { CITY_FRAGMENT_SHADER } from '@/components/map/engine/city3d/shaders';
import { CITY_GROUND_PALETTES, CITY_MATERIALS, type Rgb } from '@/lib/map/style/palette3d';

const luma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const hexRgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// GoWay's shaped sun light at a mid-morning sun: polar 40°, from the south-east.
const polar = (40 * Math.PI) / 180;
const azimuth = (135 * Math.PI) / 180;
const SUN: [number, number, number] = [
  1.15 * Math.sin(azimuth) * Math.sin(polar),
  1.15 * Math.cos(azimuth) * Math.sin(polar),
  1.15 * Math.cos(polar),
];
const ROOF = [0, 0, 1] as const;
const LIT_WALL = [Math.sin(azimuth), Math.cos(azimuth), 0] as const;
const SHADED_WALL = [-Math.sin(azimuth), -Math.cos(azimuth), 0] as const;

function shade(material: typeof CITY_MATERIALS.day, n: readonly [number, number, number], h = 20) {
  const light = materialLight(material, n, h, 30, 1, SUN);
  return light.map((k, i) => material.low[i] * k);
}

describe('the GLSL', () => {
  const values = materialUniformValues(CITY_MATERIALS);

  test('declares every uniform the engine uploads, as a day/night pair', () => {
    for (const name of Object.keys(values)) {
      expect(MATERIAL_GLSL).toMatch(new RegExp(`uniform (vec3|float) ${name};`));
    }
    for (const name of Object.keys(values).filter((n) => !n.endsWith('Night'))) {
      expect(values).toHaveProperty(`${name}Night`);
      // Blended by the engine's one night seam, never a factor of its own.
      expect(MATERIAL_GLSL).toContain(`mix(${name}, ${name}Night, t)`);
    }
    expect(MATERIAL_GLSL).toContain('clamp(uNightFactor, 0.0, 1.0)');
  });

  test('night darkens the shared day ramp by night.low / day.low', () => {
    const scale = values.uMatAlbedoScaleNight as number[];
    for (let i = 0; i < 3; i++) {
      expect(scale[i] * CITY_MATERIALS.day.low[i]).toBeCloseTo(CITY_MATERIALS.night.low[i], 12);
    }
    expect(values.uMatAlbedoScale).toEqual([1, 1, 1]);
  });

  test('is behind the define and include-guarded; both classic shaders branch cleanly', () => {
    expect(MATERIAL_GLSL.trim().startsWith(`#ifdef ${DETAILED_DEFINE}`)).toBe(true);
    expect(MATERIAL_GLSL).toContain('#ifndef GOWAY_MATERIAL_DECLS');
    for (const shader of [CITY_FRAGMENT_SHADER, OSM_FRAGMENT_SHADER]) {
      expect(shader).toContain(MATERIAL_GLSL);
      expect(shader).not.toContain('${');
      const opens = shader.match(/#if(n)?def /g)?.length ?? 0;
      const ends = shader.match(/#endif/g)?.length ?? 0;
      expect(opens).toBe(ends);
      expect(shader).toContain('uniform float uNightFactor;');
      expect(shader).toContain('vec3 detailed = gowayClassic(');
      // The classic lighting is still there, in the #else.
      expect(shader).toContain('(base + 0.03) * directional * uLightColor');
    }
  });

  test('the sky material is the contract’s cityMaterial, over the same declarations', () => {
    expect(DETAILED_SKY_MATERIAL_GLSL).toContain('vec3 cityMaterial(CitySurface s, CityLight l)');
    expect(DETAILED_SKY_MATERIAL_GLSL.startsWith(MATERIAL_GLSL)).toBe(true);
    expect(DETAILED_SKY_MATERIAL_GLSL).not.toContain('${');
    // It uses the sky's light inputs, not the palette's stand-ins.
    for (const input of [
      'l.sun',
      'l.sunDir',
      'l.sunVisibility',
      'l.skyUp',
      'l.skyDown',
      'l.emitted',
    ]) {
      expect(DETAILED_SKY_MATERIAL_GLSL).toContain(input);
    }
    const body = DETAILED_SKY_MATERIAL_GLSL.slice(
      DETAILED_SKY_MATERIAL_GLSL.indexOf('vec3 cityMaterial('),
    );
    expect(body).not.toMatch(/m\.sky\b|m\.ground\b|m\.sun\b/);
  });

  test('the engine ramp is the day one', () => {
    expect(materialRamp(CITY_MATERIALS.day).low).toEqual(CITY_MATERIALS.day.low);
  });
});

describe('the lighting model (JS mirror)', () => {
  test('day: the shaded wall is softer, never black — 75–95% of the lit wall', () => {
    const lit = luma(shade(CITY_MATERIALS.day, LIT_WALL));
    const shaded = luma(shade(CITY_MATERIALS.day, SHADED_WALL));
    expect(shaded / lit).toBeGreaterThan(0.75);
    expect(shaded / lit).toBeLessThan(0.95);
  });

  test('day: the shaded wall is a shade cooler than the lit one (blue sky, warm sun)', () => {
    const lit = shade(CITY_MATERIALS.day, LIT_WALL);
    const shaded = shade(CITY_MATERIALS.day, SHADED_WALL);
    expect(shaded[2] / shaded[0]).toBeGreaterThan(lit[2] / lit[0]);
  });

  test('day: roofs sit below pure white and a step under the near-white ground', () => {
    const roof = luma(shade(CITY_MATERIALS.day, ROOF, 30));
    expect(roof).toBeLessThan(luma(hexRgb(CITY_GROUND_PALETTES.light.land)));
    expect(roof).toBeGreaterThan(0.75);
  });

  test('night: every face is lighter than the ground it stands on', () => {
    const ground = luma(hexRgb(CITY_GROUND_PALETTES.dark.land));
    for (const n of [ROOF, LIT_WALL, SHADED_WALL]) {
      expect(luma(shade(CITY_MATERIALS.night, n))).toBeGreaterThan(ground);
    }
  });

  test('contact occlusion darkens the foot of a wall, never a low roof', () => {
    const m = CITY_MATERIALS.day;
    const foot = luma(materialLight(m, SHADED_WALL, 0, 30, 1, SUN));
    const high = luma(materialLight(m, SHADED_WALL, 25, 30, 1, SUN));
    expect(foot).toBeLessThan(high * (1 - m.aoGround * 0.9));
    const lowRoof = materialLight(m, ROOF, 3, 3, 1, SUN);
    const highRoof = materialLight(m, ROOF, 60, 60, 1, SUN);
    expect(lowRoof).toEqual(highRoof);
  });

  test('a baked inside corner darkens by its occlusion times aoCorner', () => {
    const m = CITY_MATERIALS.day;
    const open = luma(materialLight(m, LIT_WALL, 20, 30, 1, SUN));
    const corner = luma(materialLight(m, LIT_WALL, 20, 30, 0.62, SUN));
    expect(corner / open).toBeCloseTo(1 - 0.38 * m.aoCorner, 6);
  });
});

describe('windows', () => {
  test('the hash is deterministic and in [0, 1]', () => {
    expect(pcgHash(3, 7, 12345)).toBe(pcgHash(3, 7, 12345));
    for (let i = 0; i < 1000; i++) {
      const h = pcgHash(i, i * 7, i * 31);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
  });

  test('about windowLitShare of the windows are lit, building by building', () => {
    const night = CITY_MATERIALS.night;
    let lit = 0;
    let total = 0;
    for (let seed = 0; seed < 50; seed++) {
      for (let bay = 0; bay < 20; bay++) {
        for (let storey = 0; storey < 20; storey++) {
          total++;
          if (windowIsLit(night, seed * 257, bay, storey)) lit++;
        }
      }
    }
    expect(Math.abs(lit / total - night.windowLitShare)).toBeLessThan(0.02);
  });

  test('lit windows vary: mostly warm, some cooler, in brightness too — never blue', () => {
    const night = CITY_MATERIALS.night;
    const lit: [number, number, number][] = [];
    for (let bay = 0; bay < 60; bay++) {
      for (let storey = 0; storey < 30; storey++) {
        const glow = windowGlowAt(night, 999, bay, storey);
        if (glow[0] > 0) lit.push(glow);
        expect(glow[0] > 0).toBe(windowIsLit(night, 999, bay, storey));
      }
    }
    const warmth = lit.map(([r, , b]) => r / b);
    const brightness = lit.map(luma);
    expect(Math.max(...warmth) - Math.min(...warmth)).toBeGreaterThan(0.5);
    expect(Math.max(...brightness) / Math.min(...brightness)).toBeGreaterThan(1.2);
    expect(lit.every(([r, g, b]) => r >= g && g >= b)).toBe(true);
    const median = [...warmth].sort((a, b) => a - b)[Math.floor(warmth.length / 2)];
    expect(median).toBeGreaterThan(1.6); // most stay warm
  });

  test('none are lit by day', () => {
    let lit = 0;
    for (let i = 0; i < 2000; i++) if (windowIsLit(CITY_MATERIALS.day, i, i % 13, i % 7)) lit++;
    expect(lit).toBe(0);
  });
});

describe('the per-building seed', () => {
  test('deterministic, two bytes, and different for different buildings', () => {
    expect(buildingSeed(1234567892)).toEqual(buildingSeed(1234567892));
    const seen = new Set<string>();
    for (let id = 0; id < 500; id++) {
      const [a, b] = buildingSeed(id * 10 + 2);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(256);
      expect(b).toBeLessThan(256);
      seen.add(`${a},${b}`);
    }
    expect(seen.size).toBeGreaterThan(450);
    // OSM ids × 10 exceed 2^32; the high half still matters.
    expect(buildingSeed(2 ** 33 + 2)).not.toEqual(buildingSeed(2));
  });

  test('an untagged surface carries it at weight 0; a tagged one keeps its colour', () => {
    const box = [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ] as [number, number][];
    const one = (extra: Partial<OsmBuilding>) => {
      const m = meshOsmBuildings([{ id: 4242, rings: [box], top: 12, base: 0, ...extra }], {
        extent: 4096,
        tileSizeMetres: 4096,
      });
      if (!m) throw new Error('nothing meshed');
      return m.colors;
    };
    const plain = one({});
    const [a, b] = buildingSeed(4242);
    for (let v = 0; v < plain.length / 4; v++) {
      expect([plain[v * 4], plain[v * 4 + 1], plain[v * 4 + 2], plain[v * 4 + 3]]).toEqual([
        a,
        b,
        0,
        0,
      ]);
    }
    const tagged = one({ colour: 0x00ff00 });
    expect([...tagged.subarray(0, 4)].slice(0, 3)).toEqual([0, 255, 0]);
  });
});

/**
 * The OSM shader's tag path (`osmBase`, detailed), line for line: the classic
 * temper, then the chroma clamp and blend. Per-building tint left out.
 */
function taggedAlbedo(m: typeof CITY_MATERIALS.day, rgb: Rgb, weight = 1): number[] {
  const ramp = m.low;
  const x = Math.min(1, Math.max(0, (luma(ramp) - 0.25) / 0.3));
  const dark = 1 - x * x * (3 - 2 * x);
  const sat = TAG_TEMPER.saturation * (1 - 0.4 * dark);
  let tagged = rgb.map((c) => luma(rgb) + (c - luma(rgb)) * sat);
  const keep = TAG_TEMPER.lightness * (1 - 0.5 * dark);
  const target = luma(ramp) + (luma(tagged) - luma(ramp)) * keep;
  tagged = tagged.map((c) => Math.min(1, Math.max(0, c + target - luma(tagged))));
  const grey = luma(tagged);
  const clamped = tagged.map((c) => grey + (c - grey) * m.tagSaturation);
  const k = weight * TAG_TEMPER.blend * m.tagBlend;
  return ramp.map((c, i) => c + (clamped[i] - c) * k);
}

const chroma = (c: number[]) => Math.max(...c) - Math.min(...c);

describe('tagged colours in the detailed look', () => {
  // The tags that drew Lower Manhattan's pink and green towers, and worse.
  const LOUD: Rgb[] = [hexRgb('#ff8080'), hexRgb('#40c040'), hexRgb('#ff0000'), hexRgb('#ffff00')];

  test('add almost no hue: under 1.5% channel spread beyond the ramp’s own', () => {
    for (const m of [CITY_MATERIALS.day, CITY_MATERIALS.night]) {
      for (const tag of LOUD) {
        expect(chroma(taggedAlbedo(m, tag)) - chroma([...m.low])).toBeLessThan(0.015);
      }
    }
  });

  test('keep a lightness hint: a tagged black building is visibly darker than the ramp', () => {
    const m = CITY_MATERIALS.day;
    const black = luma(taggedAlbedo(m, [0, 0, 0]));
    expect(black).toBeLessThan(luma(m.low) - 0.03);
    expect(black).toBeGreaterThan(luma(m.low) * 0.8);
  });

  test('osmBase applies the clamp only in the detailed look', () => {
    expect(OSM_FRAGMENT_SHADER).toContain('gm.tagSaturation');
  });
});
