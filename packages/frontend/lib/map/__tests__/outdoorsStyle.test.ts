/**
 * The Outdoors style (`docs/MAP_STYLES.md` → Outdoors): its own relief from
 * GoWay's elevation tiles, the terrain ink, and nothing of it in any other
 * style.
 */
import { describe, expect, test } from 'bun:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import { contrastRatio, flattenColour } from '@/lib/map/colour';
import { gowayMapEndpoints } from '@/lib/map/provider';
import { buildGowayMapStyle } from '@/lib/map/style';
import { MAP_STYLES, mapStyleDefinition } from '@/lib/map/style/catalogue';
import {
  CONTOUR_SOURCE_ID,
  CONTOUR_SOURCE_LAYER,
  STYLE_HILLSHADE_LAYER_ID,
  TERRAIN_SOURCE_ID,
} from '@/lib/map/style/layers';
import { styleTheme } from '@/lib/map/style/themes';

const origin = gowayMapEndpoints('https://goway.to');
const ENDPOINTS = {
  sourceId: 'openmaptiles',
  tileJsonUrl: origin.tileJson,
  glyphs: origin.glyphs,
  sprite: origin.sprite,
  attribution: '© OpenMapTiles © OpenStreetMap contributors',
  terrain: { tiles: origin.terrain, contours: origin.contours, attribution: '© Mapterhorn' },
};

const OUTDOOR_LAYERS = [
  STYLE_HILLSHADE_LAYER_ID,
  'contour',
  'contour-index',
  'label-contour',
  'label-peak',
  'landcover-rock',
  'landcover-ice-outline',
  'road-aerialway',
];

describe('Outdoors', () => {
  for (const preset of ['day', 'night'] as const) {
    test(`${preset}: carries its own hillshade and contours from GoWay's tiles, and is valid`, () => {
      const style = buildGowayMapStyle({ style: 'outdoors', preset }, ENDPOINTS);
      expect(validateStyleMin(style)).toEqual([]);
      const ids = new Set(style.layers.map((layer) => layer.id));
      for (const id of OUTDOOR_LAYERS) expect(ids.has(id)).toBe(true);
      const terrain = style.sources[TERRAIN_SOURCE_ID] as { type: string; tiles: string[] };
      const contours = style.sources[CONTOUR_SOURCE_ID] as { type: string; tiles: string[] };
      expect(terrain.type).toBe('raster-dem');
      expect(terrain.tiles).toEqual(['https://goway.to/map/terrain/{z}/{x}/{y}.webp']);
      expect(contours.tiles).toEqual(['https://goway.to/map/contours/{z}/{x}/{y}.pbf']);
      for (const layer of style.layers) {
        if ('source' in layer && layer.source === CONTOUR_SOURCE_ID) {
          expect(layer['source-layer']).toBe(CONTOUR_SOURCE_LAYER);
        }
      }
      // The relief sits on the land and under the water: a lake stays flat.
      const at = (id: string) => style.layers.findIndex((layer) => layer.id === id);
      expect(at(STYLE_HILLSHADE_LAYER_ID)).toBeGreaterThan(at('landuse-park'));
      expect(at('contour-index')).toBeLessThan(at('water'));
    });
  }

  test('no other style draws any of it, or declares its sources', () => {
    for (const entry of MAP_STYLES) {
      if (entry.id === 'outdoors') continue;
      for (const preset of entry.presets) {
        const style = buildGowayMapStyle({ style: entry.id, preset }, ENDPOINTS);
        const ids = new Set(style.layers.map((layer) => layer.id));
        for (const id of OUTDOOR_LAYERS) expect(ids.has(id)).toBe(false);
        expect(style.sources[TERRAIN_SOURCE_ID]).toBeUndefined();
        expect(style.sources[CONTOUR_SOURCE_ID]).toBeUndefined();
      }
    }
  });

  test('the catalogue says it draws relief, so the credit and the adapters know', () => {
    expect(mapStyleDefinition('outdoors').relief).toBe(true);
    expect(mapStyleDefinition('standard').relief).toBeUndefined();
  });

  test('peaks and contour heights read at 4.5:1; trails rank by difficulty', () => {
    for (const preset of ['day', 'night'] as const) {
      const p = styleTheme({ style: 'outdoors', preset }).palette;
      const ink = p.outdoors;
      expect(ink).toBeDefined();
      if (!ink) continue;
      const halo = flattenColour(p.halo, p.land);
      for (const label of [ink.labelPeak, ink.labelContour]) {
        expect(contrastRatio(label, p.land)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(label, halo)).toBeGreaterThanOrEqual(4.5);
      }
      // Each harder grade stands further from the ground than the last.
      const ground = p.land;
      expect(contrastRatio(ink.trailHard, ground)).not.toBe(contrastRatio(ink.trail, ground));
      expect(contrastRatio(ink.trailExpert, ground)).toBeGreaterThan(
        contrastRatio(ink.trail, ground),
      );
    }
  });
});
