/**
 * The detailed city material (`engine/city3d/materials.ts`, its shader
 * `tsl/detailedMaterial.ts`): what the shader is built from, the per-building
 * seed, the window hash, and the lighting model's promises — no black sides by
 * day, buildings a step lighter than the ground at night — computed by the JS
 * mirror of the shader.
 *
 * The shader itself is compiled and drawn in a browser (the visibility gate,
 * and the side-by-sides in `docs/MAP_3D_CITY.md` → Art direction).
 */
import { describe, expect, test } from 'bun:test';

import {
  MATERIAL_FLOAT_STEMS,
  MATERIAL_VEC3_STEMS,
  materialRamp,
  materialUniformValues,
  pcgHash,
  skyMaterialResponse,
  windowGlowAt,
  windowIsLit,
} from '@/components/map/engine/city3d/materials';
import { computeSkyState } from '@/components/map/engine/city3d/atmosphere';
import { buildingSeed, meshOsmBuildings } from '@/components/map/engine/city3d/osmMesher';
import type { OsmBuilding } from '@/components/map/engine/city3d/osmTiles';
import { TAG_TEMPER } from '@/components/map/engine/city3d/tsl/buildingSurface';
import { createBuildingUniforms } from '@/components/map/engine/city3d/tsl/buildingMaterial';
import {
  buildingSeedOf,
  createDetailedMaterial,
} from '@/components/map/engine/city3d/tsl/detailedMaterial';
import { createSkyBuildingMaterials } from '@/components/map/engine/city3d/tsl/skyBuildingMaterial';
import { createSkyNodes } from '@/components/map/engine/city3d/tsl/skyNodes';
import { float, vec3, vec4 } from 'three/tsl';
import { FrontSide, Vector3 } from 'three/webgpu';
import { CITY_GROUND_PALETTES, CITY_MATERIALS, type Rgb } from '@/lib/map/style/palette3d';

import { constantsOf, nodesOf, skyRefs } from './tslGraph';

const luma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const hexRgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const ROOF = [0, 0, 1] as const;

/**
 * The material's values (`materialUniformValues`), every number made unique
 * so a test can tell which one a node holds.
 */
function uniqueValues(values: Record<string, number | number[]>) {
  const out: Record<string, number | number[]> = {};
  let unique = 1000;
  for (const [name, value] of Object.entries(values)) {
    out[name] = Array.isArray(value) ? value.map(() => unique++) : unique++;
  }
  return out;
}

const lower = (stem: string) => stem[0].toLowerCase() + stem.slice(1);

describe('the shader', () => {
  const values = materialUniformValues(CITY_MATERIALS);

  test('holds every value, as a day/night pair blended by the night seam', () => {
    const unique = uniqueValues(values);
    const night = float(0.5);
    const { mat } = createDetailedMaterial(unique, night);
    const fields = mat as unknown as Record<string, unknown>;
    for (const stem of [...MATERIAL_VEC3_STEMS, ...MATERIAL_FLOAT_STEMS]) {
      const field = fields[lower(stem)];
      const held = constantsOf(field);
      for (const name of [`uMat${stem}`, `uMat${stem}Night`]) {
        const value = unique[name];
        for (const v of Array.isArray(value) ? value : [value]) expect(held).toContain(v);
      }
      // Blended by the engine's one night seam, never a factor of its own.
      expect(nodesOf(field)).toContain(night as never);
    }
    // And there is no value the shader does not hold.
    expect(Object.keys(values).length).toBe(
      2 * (MATERIAL_VEC3_STEMS.length + MATERIAL_FLOAT_STEMS.length),
    );
  });

  test('night darkens the shared day ramp by night.low / day.low', () => {
    const scale = values.uMatAlbedoScaleNight as number[];
    for (let i = 0; i < 3; i++) {
      expect(scale[i] * CITY_MATERIALS.day.low[i]).toBeCloseTo(CITY_MATERIALS.night.low[i], 12);
    }
    expect(values.uMatAlbedoScale).toEqual([1, 1, 1]);
  });

  test('is the sky path’s response: both formats build with it', () => {
    const sky = createSkyNodes(skyRefs(true), 12);
    const detailed = createDetailedMaterial(values, sky.nightFactor);
    const materials = createSkyBuildingMaterials({
      uniforms: createBuildingUniforms({
        uLow: { value: new Vector3() },
        uTall: { value: new Vector3() },
        uVeryTall: { value: new Vector3() },
        uTallM: { value: 60 },
        uVeryTallM: { value: 180 },
        uLightPosition: { value: new Vector3(0, 0, 1) },
        uLightIntensity: { value: 0.5 },
        uLightColor: { value: new Vector3(1, 1, 1) },
        uGrounded: { value: 0 },
      }),
      sky,
      response: detailed.response,
      detailedSurface: detailed.surface,
      side: FrontSide,
    });
    for (const format of ['openmaptiles', 'goway'] as const) {
      for (const dithered of [false, true]) {
        expect(materials.get(format, dithered).colorNode).toBeDefined();
      }
    }
    // No second path: the map-lit buildings (`tsl/buildingMaterial.ts`) have
    // no detailed lighting; only the sky's material reaches it.
  });

  test('the engine ramp is the day one', () => {
    expect(materialRamp(CITY_MATERIALS.day).low).toEqual(CITY_MATERIALS.day.low);
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

  test('a window’s building seed is ROUNDED from the interpolated colour, never truncated', () => {
    // vColor arrives interpolated: 37/255 can read as 36.9999 on one pixel and
    // 37.0001 on the next. Truncated, one window got two seeds — two draws of
    // lit/unlit — and rendered as speckle (seen at night in Eixample).
    const constants = constantsOf(buildingSeedOf(vec4(0.1, 0.2, 0, 0)));
    expect(constants.filter((c) => c === 0.5)).toHaveLength(2);
    expect(constants).toContain(255);
    expect(constants).toContain(256);
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

  test('the detailed surface applies the clamp, from the material’s own values', () => {
    const unique = uniqueValues(materialUniformValues(CITY_MATERIALS));
    const { surface } = createDetailedMaterial(unique, float(0));
    const tagged = surface(vec3(0.5), vec3(0.4, 0.2, 0.1), vec4(0.4, 0.2, 0.1, 1));
    expect(constantsOf(tagged)).toContain(unique.uMatTagSaturation as number);
    expect(constantsOf(tagged)).toContain(unique.uMatTagBlend as number);
  });
});

describe('the sky path: the approved look under the sky’s physical light', () => {
  // The sky's own light for a sun at `altitude` (atmosphere.ts), as the shader gets it.
  const inputs = (altitude: number, appearance: 'light' | 'dark', azimuthDeg = 135) => {
    const state = computeSkyState(altitude, appearance);
    const alt = (Math.max(altitude, 0) * Math.PI) / 180;
    const az = (azimuthDeg * Math.PI) / 180;
    return {
      sunDir: [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)] as const,
      sun: state.sunColor,
      sunVisibility: 1,
      skyUp: state.skyAmbient,
      skyDown: state.groundBounce,
      emitted: [0, 0, 0] as const,
    };
  };
  const az = (135 * Math.PI) / 180;
  const LIT = [Math.sin(az), Math.cos(az), 0] as const;
  const SHADE = [-Math.sin(az), -Math.cos(az), 0] as const;
  const srgb = (c: number[]) => c.map((x) => Math.min(1, x) ** (1 / 2.2));
  const face = (
    material: typeof CITY_MATERIALS.day,
    n: readonly [number, number, number],
    l: ReturnType<typeof inputs>,
    albedo = material.low,
  ) => srgb(skyMaterialResponse(material, albedo, n, 20, 30, 1, l));

  test('day (sun 50°): a white maquette — lit wall near-white, shade softer and cooler, never black', () => {
    const l = inputs(49.8, 'light');
    const lit = face(CITY_MATERIALS.day, LIT, l);
    const shade = face(CITY_MATERIALS.day, SHADE, l);
    expect(luma(lit)).toBeGreaterThan(0.84);
    expect(luma(shade)).toBeGreaterThan(0.68);
    expect(luma(shade) / luma(lit)).toBeLessThan(0.93);
    expect(shade[2] / shade[0]).toBeGreaterThan(lit[2] / lit[0]);
    // The clay answers the blue sky with only a hint of its hue.
    expect(chroma(shade)).toBeLessThan(0.08);
  });

  test('golden hour (sun 8°): the sunny wall turns warm, the shade stays cool', () => {
    const l = inputs(8, 'light');
    const lit = face(CITY_MATERIALS.day, LIT, l);
    const shade = face(CITY_MATERIALS.day, SHADE, l);
    expect(lit[0] - lit[2]).toBeGreaterThan(0.05);
    expect(shade[2]).toBeGreaterThanOrEqual(shade[0]);
  });

  test('night: blue-grey massing a step above the ground, not the sky’s saturated blue', () => {
    const l = inputs(-30, 'dark');
    const night = CITY_MATERIALS.night;
    const ground = luma(hexRgb(CITY_GROUND_PALETTES.dark.land));
    for (const n of [ROOF, LIT, SHADE]) {
      const c = face(night, n, l, night.low);
      expect(luma(c)).toBeGreaterThan(ground);
      expect(c[2]).toBeGreaterThan(c[0]); // blue
      expect(chroma(c)).toBeLessThan(0.35); // not the raw sky
    }
  });

  test('contact occlusion darkens the foot of a wall, never a low roof', () => {
    const l = inputs(49.8, 'light');
    const m = CITY_MATERIALS.day;
    const at = (n: readonly [number, number, number], h: number, H: number) =>
      luma(skyMaterialResponse(m, m.low, n, h, H, 1, l));
    expect(at(SHADE, 0, 30)).toBeLessThan(at(SHADE, 25, 30) * (1 - m.aoGround * 0.9));
    expect(at(ROOF, 3, 3)).toBeCloseTo(at(ROOF, 60, 60), 12);
  });

  test('a baked inside corner darkens by its occlusion times aoCorner', () => {
    const l = { ...inputs(49.8, 'light'), sunVisibility: 0 }; // fill only: linear in occlusion
    const m = CITY_MATERIALS.day;
    const open = luma(skyMaterialResponse(m, m.low, LIT, 20, 30, 1, l));
    const corner = luma(skyMaterialResponse(m, m.low, LIT, 20, 30, 0.62, l));
    expect(corner / open).toBeCloseTo(1 - 0.38 * m.aoCorner, 2);
  });
});
