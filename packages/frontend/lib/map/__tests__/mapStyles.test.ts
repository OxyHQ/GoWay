/**
 * The style engine (`docs/MAP_STYLES.md`): the catalogue, the light, the
 * themes and the one layer list every style is drawn from.
 *
 * What can be pinned by number is pinned here — every style a valid
 * MapLibre document, one map in every light, the published layer order,
 * Standard unchanged by the engine, every derived ink at 4.5:1, the data
 * basemaps made of Bloom's own greys. Whether a style LOOKS right is the
 * contact sheet's (`scripts/shoot-map-styles.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { getPresetVars } from '@oxy.so/bloom/preset-vars';
import type { AppColorName } from '@oxy.so/bloom/color-presets';

import { contrastRatio, flattenColour, mixColours, parseCssColour } from '@/lib/map/colour';
import { MAP_LIGHT_MODE_LABELS, MAP_STYLE_COPY, MAP_STYLE_LABELS } from '@/lib/map/mapStyleLabels';
import { MAP_STYLE_TRIGGER_LABEL } from '@/lib/map/mapStyleTriggerLabel';
import { buildGowayMapStyle } from '@/lib/map/style';
import {
  lightPresetFromSun,
  MAP_LIGHT_MODES,
  MAP_STYLE_IDS,
  MAP_STYLES,
  mapStylePath,
  type MapStyleSelection,
  presetAppearance,
  resolveMapStyle,
  resolveMapStyleRequest,
  SUN_LIGHT_BAND,
  selectMapStyle,
} from '@/lib/map/style/catalogue';
import { applyGroundOverrides, buildCity3dGroundOverrides } from '@/lib/map/style/city3dGround';
import { GOWAY_STYLE_LAYER_ID_LIST, LABEL_ANCHOR_LAYER_ID } from '@/lib/map/style/layers';
import { DARK_PALETTE, LIGHT_PALETTE } from '@/lib/map/style/palette';
import { CITY_GROUND_PALETTES, CITY_MATERIALS } from '@/lib/map/style/palette3d';
import { styleTheme } from '@/lib/map/style/themes';
import { LABEL_LANGUAGES, parseMapStyleIndex } from '@goway.to/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SELECTIONS: MapStyleSelection[] = MAP_STYLES.flatMap((entry) =>
  entry.presets.map((preset) => ({ style: entry.id, preset })),
);

const ENDPOINTS = {
  sourceId: 'openmaptiles',
  tileJsonUrl: 'https://goway.to/map/tiles.json',
  glyphs: 'https://goway.to/map/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://goway.to/map/sprites/goway',
  attribution: '© OpenMapTiles © OpenStreetMap contributors',
  terrain: {
    tiles: 'https://goway.to/map/terrain/{z}/{x}/{y}.webp',
    contours: 'https://goway.to/map/contours/{z}/{x}/{y}.pbf',
    attribution: '© Mapterhorn',
  },
};

const label = (s: MapStyleSelection) => `${s.style}/${s.preset}`;

describe('the catalogue', () => {
  test('every style is listed once, follows the light in day and night or keeps one light', () => {
    expect(new Set(MAP_STYLE_IDS).size).toBe(MAP_STYLE_IDS.length);
    expect(MAP_STYLES.map((entry) => entry.id)).toEqual([...MAP_STYLE_IDS]);
    for (const entry of MAP_STYLES) {
      if (entry.light === 'fixed') expect(entry.presets).toHaveLength(1);
      else expect(entry.presets).toEqual(expect.arrayContaining(['day', 'night']));
    }
    expect(MAP_STYLES[0].id).toBe('standard');
  });

  test('a light the style is not published in falls to the nearest one it is', () => {
    expect(resolveMapStyle('standard', 'dusk')).toEqual({ style: 'standard', preset: 'dusk' });
    // Streets has no twilight: the sun still up is day, set is night.
    expect(resolveMapStyle('streets', 'dawn', true)).toEqual({ style: 'streets', preset: 'day' });
    expect(resolveMapStyle('streets', 'dusk', false)).toEqual({
      style: 'streets',
      preset: 'night',
    });
    // A fixed style keeps its one light whatever is asked.
    expect(resolveMapStyle('light', 'night')).toEqual({ style: 'light', preset: 'day' });
    expect(resolveMapStyle('dark', 'day')).toEqual({ style: 'dark', preset: 'night' });
  });

  test('documents are served at one stable path per style and light', () => {
    expect(mapStylePath({ style: 'streets', preset: 'night' })).toBe(
      '/map/styles/streets/night.json',
    );
  });

  test('the sun: day above the band, night below civil twilight, dawn or dusk between', () => {
    expect(lightPresetFromSun({ altitudeDeg: 30, azimuthDeg: 180 }).preset).toBe('day');
    expect(
      lightPresetFromSun({ altitudeDeg: SUN_LIGHT_BAND.night - 1, azimuthDeg: 0 }).preset,
    ).toBe('night');
    expect(lightPresetFromSun({ altitudeDeg: 1, azimuthDeg: 95 })).toEqual({
      preset: 'dawn',
      sunUp: true,
    });
    expect(lightPresetFromSun({ altitudeDeg: -3, azimuthDeg: 265 })).toEqual({
      preset: 'dusk',
      sunUp: false,
    });
    expect(lightPresetFromSun({ altitudeDeg: Number.NaN, azimuthDeg: 0 }).preset).toBe('day');
  });

  test('the light modes: the app theme by default, the sun, or always one light', () => {
    const dusk = { altitudeDeg: -2, azimuthDeg: 270 };
    expect(selectMapStyle({ style: 'standard', mode: 'app', themeDark: true })).toEqual({
      style: 'standard',
      preset: 'night',
    });
    expect(
      selectMapStyle({ style: 'standard', mode: 'sun', themeDark: false, sun: dusk }).preset,
    ).toBe('dusk');
    // Without a sun reading, `sun` is the app theme rather than a guess.
    expect(selectMapStyle({ style: 'standard', mode: 'sun', themeDark: true }).preset).toBe(
      'night',
    );
    expect(selectMapStyle({ style: 'standard', mode: 'night', themeDark: false }).preset).toBe(
      'night',
    );
    expect(selectMapStyle({ style: 'dark', mode: 'day', themeDark: false }).preset).toBe('night');
    expect(presetAppearance('dusk')).toBe('light');
  });

  test('a screen that decides (the embed) is never overruled by the device', () => {
    const device = { style: 'streets' as const, light: 'night' as const };
    expect(
      resolveMapStyleRequest({ style: 'standard', lightPreset: 'day' }, device, true, null),
    ).toEqual({ style: 'standard', preset: 'day' });
    expect(resolveMapStyleRequest({ appearance: 'dark' }, device, false, null)).toEqual({
      style: 'streets',
      preset: 'night',
    });
    expect(resolveMapStyleRequest({}, device, false, null)).toEqual({
      style: 'streets',
      preset: 'night',
    });
  });
});

describe('every document', () => {
  for (const selection of SELECTIONS) {
    test(`${label(selection)}: a valid MapLibre style, in the published order, anchored`, () => {
      const style = buildGowayMapStyle(selection, ENDPOINTS);
      expect(validateStyleMin(style)).toEqual([]);
      const order = new Map(GOWAY_STYLE_LAYER_ID_LIST.map((id, index) => [id, index]));
      const indices = style.layers.map((layer) => order.get(layer.id));
      expect(indices.every((index) => index !== undefined)).toBe(true);
      expect([...indices].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(indices);
      expect(style.layers.some((layer) => layer.id === LABEL_ANCHOR_LAYER_ID)).toBe(true);
      const metadata = style.metadata as Record<string, unknown>;
      expect(metadata['goway:style']).toBe(selection.style);
      expect(metadata['goway:light']).toBe(selection.preset);
    });
  }

  test('a style draws the same layers in every light; only colour moves', () => {
    for (const entry of MAP_STYLES) {
      const ids = entry.presets.map((preset) =>
        buildGowayMapStyle({ style: entry.id, preset }, ENDPOINTS)
          .layers.map((layer) => layer.id)
          .join(),
      );
      expect(new Set(ids).size).toBe(1);
    }
  });

  test('no two documents draw the same thing', () => {
    const bodies = SELECTIONS.map((s) => JSON.stringify(buildGowayMapStyle(s, ENDPOINTS).layers));
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  test('the 3D ground overrides are colour cross-fades that keep the layer list', () => {
    for (const selection of SELECTIONS) {
      const theme = styleTheme(selection);
      const overrides = buildCity3dGroundOverrides(theme);
      const style = buildGowayMapStyle(selection, ENDPOINTS);
      for (const o of overrides) expect(o.property).toMatch(/-color$/);
      const applied = applyGroundOverrides(style.layers, overrides);
      expect(applied.map((l) => l.id)).toEqual(style.layers.map((l) => l.id));
      expect(validateStyleMin({ ...style, layers: applied })).toEqual([]);
    }
  });
});

describe('the styles', () => {
  test('Standard by day and by night IS the measured cartography and the detailed ground', () => {
    expect(styleTheme({ style: 'standard', preset: 'day' }).palette).toBe(LIGHT_PALETTE);
    expect(styleTheme({ style: 'standard', preset: 'night' }).palette).toBe(DARK_PALETTE);
    expect(styleTheme({ style: 'standard', preset: 'day' }).cityGround).toBe(
      CITY_GROUND_PALETTES.light,
    );
    expect(styleTheme({ style: 'standard', preset: 'night' }).materials).toBe(CITY_MATERIALS);
  });

  test('Streets names more, earlier, as written; the data basemaps name no POI', () => {
    const ids = (s: MapStyleSelection) =>
      new Set(buildGowayMapStyle(s, ENDPOINTS).layers.map((layer) => layer.id));
    const layer = (s: MapStyleSelection, id: string) =>
      buildGowayMapStyle(s, ENDPOINTS).layers.find((l) => l.id === id) as {
        minzoom?: number;
        layout?: Record<string, unknown>;
      };
    const streets = { style: 'streets', preset: 'day' } as const;
    const standard = { style: 'standard', preset: 'day' } as const;
    expect(layer(streets, 'label-housenumber').minzoom).toBe(17);
    expect(layer(standard, 'label-housenumber').minzoom).toBe(18);
    expect(layer(streets, 'label-poi-minor').minzoom).toBeLessThan(
      layer(standard, 'label-poi-minor').minzoom ?? 99,
    );
    expect(layer(streets, 'label-road-arterial').layout?.['text-transform']).toBeUndefined();
    expect(layer(standard, 'label-road-arterial').layout?.['text-transform']).toBe('uppercase');
    for (const data of [
      { style: 'light', preset: 'day' },
      { style: 'dark', preset: 'night' },
    ] as const) {
      const drawn = ids(data);
      for (const id of [
        'poi-dot',
        'label-poi',
        'label-housenumber',
        'road-oneway',
        'label-road-local',
      ]) {
        expect(drawn.has(id)).toBe(false);
      }
      expect(drawn.has('label-place-city')).toBe(true);
    }
  });

  test('Streets ranks its roads by colour: the faster, the warmer and the deeper', () => {
    const roads = styleTheme({ style: 'streets', preset: 'day' }).palette.roads;
    const chroma = (hex: string) => {
      const c = parseCssColour(hex);
      if (!c) return 0;
      const [r, g, b] = c.rgb;
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    expect(chroma(roads.motorway.fill)).toBeGreaterThan(chroma(roads.trunk.fill));
    expect(chroma(roads.trunk.fill)).toBeGreaterThan(chroma(roads.primary.fill));
    expect(chroma(roads.primary.fill)).toBeGreaterThan(chroma(roads.local.fill));
  });

  test('Light and Dark are Bloom’s own neutrals, read from the tokens rather than restated', () => {
    const hex = (mode: 'light' | 'dark', name: string) => {
      const vars = getPresetVars('mono' as AppColorName, mode) as unknown as Record<string, string>;
      const c = parseCssColour(vars[name]);
      return c ? `#${c.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}` : '';
    };
    const light = styleTheme({ style: 'light', preset: 'day' }).palette;
    const dark = styleTheme({ style: 'dark', preset: 'night' }).palette;
    expect(light.land).toBe(hex('light', '--background'));
    expect(light.roads.local.fill).toBe(hex('light', '--card'));
    expect(light.labelPlace).toBe(hex('light', '--muted-foreground'));
    expect(dark.land).toBe(hex('dark', '--surface'));
    expect(dark.roads.local.fill).toBe(hex('dark', '--muted'));
  });

  test('dawn and dusk stay the day map, lit low: lighter than night, and not grey', () => {
    for (const preset of ['dawn', 'dusk'] as const) {
      const palette = styleTheme({ style: 'standard', preset }).palette;
      expect(contrastRatio(palette.land, DARK_PALETTE.land)).toBeGreaterThan(5);
      expect(palette.land).not.toBe(LIGHT_PALETTE.land);
      expect(palette.water).not.toBe(LIGHT_PALETTE.water);
    }
  });
});

describe('type holds 4.5:1 in every derived style', () => {
  for (const selection of SELECTIONS) {
    if (
      selection.style === 'standard' &&
      (selection.preset === 'day' || selection.preset === 'night')
    )
      continue; // measured, and held by its own tests (palette3d.test.ts, the README's table)
    test(label(selection), () => {
      const p = styleTheme(selection).palette;
      const halo = flattenColour(p.halo, p.land);
      for (const ink of [p.labelPlace, p.labelPlaceMinor, p.labelRegion]) {
        expect(contrastRatio(ink, p.land)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(ink, halo)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(p.labelWater, p.water)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.labelPark, p.park)).toBeGreaterThanOrEqual(4.5);
      for (const tier of ['primary', 'secondary', 'tertiary', 'local'] as const) {
        expect(contrastRatio(p.labelRoad, p.roads[tier].fill)).toBeGreaterThanOrEqual(4.5);
      }
      for (const ink of Object.values(p.poiLabel)) {
        expect(contrastRatio(ink, halo)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe('the words', () => {
  test('every style, light and line of the picker is in every label language', () => {
    const sets = [
      MAP_STYLE_TRIGGER_LABEL,
      ...MAP_STYLE_IDS.flatMap((id) => [
        MAP_STYLE_LABELS[id].name,
        MAP_STYLE_LABELS[id].description,
      ]),
      ...MAP_LIGHT_MODES.map((mode) => MAP_LIGHT_MODE_LABELS[mode]),
      ...Object.values(MAP_STYLE_COPY),
    ];
    for (const labels of sets) {
      for (const language of LABEL_LANGUAGES) {
        expect((labels as Record<string, string>)[language]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

test('mixColours is the identity at its ends', () => {
  expect(mixColours('#f6f4eb', '#34445b', 0)).toBe('#f6f4eb');
  expect(mixColours('#f6f4eb', '#34445b', 1)).toBe('#34445b');
});

test('the published catalogue document is what the SDK reads, and lists every document', () => {
  const raw = readFileSync(join(import.meta.dir, '../../../public/map/styles/index.json'), 'utf8');
  const index = parseMapStyleIndex(JSON.parse(raw));
  expect(index.styles.map((s) => s.id)).toEqual([...MAP_STYLE_IDS]);
  for (const entry of index.styles) {
    for (const preset of entry.presets) {
      expect(entry.urls[preset]).toBe(
        `https://goway.to${mapStylePath({ style: entry.id as never, preset: preset as never })}`,
      );
    }
  }
});
