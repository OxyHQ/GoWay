/**
 * The detailed 3D city's palette (`lib/map/style/palette3d.ts`) and the ground
 * overrides generated from it (`city3dGround.ts`).
 *
 * What a number can be pinned for is pinned here: the day/night blend, the
 * night factor helpers, label contrast on the new ground, and that the ground
 * overrides are cross-fades that change only colours. Whether it LOOKS like
 * the reference is a rendering question, answered by the side-by-sides
 * recorded in `docs/MAP_3D_CITY.md` → Art direction.
 */
import { describe, expect, test } from 'bun:test';

import { buildLayers } from '@/lib/map/style/layers';
import { CARTOGRAPHY_PALETTES } from '@/lib/map/style/palette';
import {
  CITY_GROUND_FADE,
  CITY_GROUND_PALETTES,
  CITY_MATERIALS,
  CITY_ROAD_TIERS,
  cityMaterialAt,
  clampNightFactor,
} from '@/lib/map/style/palette3d';
import {
  applyGroundOverrides,
  buildCity3dGroundOverrides,
  crossFadeByZoom,
} from '@/lib/map/style/city3dGround';

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the material blend', () => {
  test('0 is day and 1 is night, exactly', () => {
    expect(cityMaterialAt(0)).toEqual(CITY_MATERIALS.day);
    expect(cityMaterialAt(1)).toEqual(CITY_MATERIALS.night);
  });

  test('halfway is the midpoint of every field', () => {
    const mid = cityMaterialAt(0.5);
    expect(mid.wrap).toBeCloseTo((CITY_MATERIALS.day.wrap + CITY_MATERIALS.night.wrap) / 2, 12);
    for (let i = 0; i < 3; i++) {
      expect(mid.low[i]).toBeCloseTo(
        (CITY_MATERIALS.day.low[i] + CITY_MATERIALS.night.low[i]) / 2,
        12,
      );
      expect(mid.windowGlow[i]).toBeCloseTo(CITY_MATERIALS.night.windowGlow[i] / 2, 12);
    }
  });

  test('out-of-range and non-finite factors clamp', () => {
    expect(cityMaterialAt(-3)).toEqual(CITY_MATERIALS.day);
    expect(cityMaterialAt(7)).toEqual(CITY_MATERIALS.night);
    expect(clampNightFactor(Number.NaN)).toBe(0);
  });

  test('day has no emissive light; night has warm windows', () => {
    const { day, night } = CITY_MATERIALS;
    expect(day.windowGlow).toEqual([0, 0, 0]);
    expect(day.windowLitShare).toBe(0);
    expect(night.windowLitShare).toBeGreaterThan(0.2);
    expect(night.windowLitShare).toBeLessThan(0.5);
    // Warm: red over green over blue.
    expect(night.windowGlow[0]).toBeGreaterThan(night.windowGlow[1]);
    expect(night.windowGlow[1]).toBeGreaterThan(night.windowGlow[2]);
  });

  test('Apple shows clean massing by day: window openings stay faint', () => {
    expect(CITY_MATERIALS.day.windowStrength).toBeLessThanOrEqual(0.15);
  });
});

describe('the 3D city ground', () => {
  test('changes only ground fields and the two label inks it re-checks', () => {
    const changed = (appearance: 'light' | 'dark') =>
      Object.keys(CITY_GROUND_PALETTES[appearance]).filter(
        (key) =>
          JSON.stringify(CITY_GROUND_PALETTES[appearance][key as 'land']) !==
          JSON.stringify(CARTOGRAPHY_PALETTES[appearance][key as 'land']),
      );
    for (const appearance of ['light', 'dark'] as const) {
      for (const key of changed(appearance)) {
        expect(key).not.toMatch(
          /^(poi|poiLabel|halo|haloStrong|labelPlace|labelPlaceMinor|labelRegion|labelWater)$/,
        );
      }
    }
  });

  test('street labels clear 4.5:1 on every street fill (light: asphalt; dark: brighter than before)', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const palette = CITY_GROUND_PALETTES[appearance];
      for (const tier of CITY_ROAD_TIERS) {
        if (
          ['motorway', 'motorwayLink', 'trunk', 'trunkLink', 'track', 'path', 'tunnel'].includes(
            tier,
          )
        )
          continue; // the 2D map's own exemptions: the halo carries those
        expect(contrast(palette.labelRoad, palette.roads[tier].fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('park and water labels clear 4.5:1 on the new park and water', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const palette = CITY_GROUND_PALETTES[appearance];
      expect(contrast(palette.labelPark, palette.park)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.labelWater, palette.water)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('streets are asphalt: darker than the ground by day, with lighter kerbs', () => {
    const light = CITY_GROUND_PALETTES.light;
    for (const tier of ['primary', 'secondary', 'tertiary', 'local'] as const) {
      expect(luminance(light.roads[tier].fill)).toBeLessThan(luminance(light.land));
      expect(luminance(light.roads[tier].casing ?? '#000000')).toBeGreaterThan(
        luminance(light.land),
      );
      const dark = CITY_GROUND_PALETTES.dark;
      expect(luminance(dark.roads[tier].fill)).toBeLessThan(luminance(dark.land));
      expect(luminance(dark.roads[tier].casing ?? '#000000')).toBeGreaterThan(luminance(dark.land));
    }
  });
});

describe('the ground overrides', () => {
  for (const appearance of ['light', 'dark'] as const) {
    test(`${appearance}: every override is a colour cross-fade from the 2D value to the city value`, () => {
      const overrides = buildCity3dGroundOverrides(appearance);
      expect(overrides.length).toBeGreaterThan(20);
      const base = buildLayers(CARTOGRAPHY_PALETTES[appearance], 'openmaptiles');
      const city = buildLayers(CITY_GROUND_PALETTES[appearance], 'openmaptiles');
      const paintOf = (layers: typeof base, id: string, property: string) =>
        (layers.find((l) => l.id === id) as { paint?: Record<string, unknown> }).paint?.[property];
      for (const o of overrides) {
        expect(o.property).toMatch(/-color$/);
        const value = o.value as unknown[];
        expect(value.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
        const at = (z: number) => value[value.indexOf(z) + 1];
        const baseValue = paintOf(base, o.layer, o.property);
        const cityValue = paintOf(city, o.layer, o.property);
        if (typeof baseValue === 'string') expect(at(CITY_GROUND_FADE.start)).toBe(baseValue);
        if (typeof cityValue === 'string') expect(at(CITY_GROUND_FADE.end)).toBe(cityValue);
      }
    });

    test(`${appearance}: the hidden extrusion is never overridden, and applying keeps the layer list`, () => {
      const overrides = buildCity3dGroundOverrides(appearance);
      expect(overrides.some((o) => o.layer === 'building-3d')).toBe(false);
      const base = buildLayers(CARTOGRAPHY_PALETTES[appearance], 'openmaptiles');
      const applied = applyGroundOverrides(base, overrides);
      expect(applied.map((l) => l.id)).toEqual(base.map((l) => l.id));
      expect(applied.map((l) => l.type)).toEqual(base.map((l) => l.type));
    });
  }

  test('a ramp keeps its low-zoom stops and is evaluated at the fade', () => {
    const base = ['interpolate', ['linear'], ['zoom'], 9, '#000000', 13, '#ffffff'];
    expect(crossFadeByZoom(base, '#808080', 14.5, 15.5)).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      9,
      '#000000',
      13,
      '#ffffff',
      14.5,
      '#ffffff',
      15.5,
      '#808080',
    ]);
  });

  test('a ramp straddling the fade is interpolated as MapLibre would', () => {
    const city = ['interpolate', ['linear'], ['zoom'], 15, '#000000', 16, '#ffffff'];
    expect(crossFadeByZoom('#101010', city, 14.5, 15.5)).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      14.5,
      '#101010',
      15.5,
      '#808080',
      16,
      '#ffffff',
    ]);
  });

  test('anything it cannot evaluate is refused, not guessed', () => {
    const dataDriven = ['match', ['get', 'class'], 'a', '#000000', '#ffffff'];
    expect(crossFadeByZoom(dataDriven, '#ffffff', 14.5, 15.5)).toBeNull();
    const named = ['interpolate', ['linear'], ['zoom'], 14, 'red', 16, 'blue'];
    expect(crossFadeByZoom(named, '#ffffff', 14.5, 15.5)).toBeNull();
  });
});
