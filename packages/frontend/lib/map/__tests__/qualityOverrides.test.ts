/**
 * The low tier draws a dense style (Streets) at Standard's density
 * (`lib/map/style/qualityOverrides.ts`, `components/map/qualityOverrides.ts`,
 * `QualityProfile.basemap.density`): the overrides are exactly the layer
 * list at Standard's density, and folded into the document they draw exactly that.
 */
import { describe, expect, test } from 'bun:test';

import { hasQualityOverrides, withQualityOverrides } from '@/components/map/qualityOverrides';
import { QUALITY_PRESETS } from '@/lib/map/quality/profile';
import { buildGowayMapStyle } from '@/lib/map/style';
import { buildLayers } from '@/lib/map/style/layers';
import { buildQualityOverrides, standardDensity } from '@/lib/map/style/qualityOverrides';
import { styleTheme } from '@/lib/map/style/themes';

const ENDPOINTS = {
  sourceId: 'openmaptiles',
  tileJsonUrl: 'https://goway.to/map/tiles.json',
  glyphs: 'https://goway.to/map/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://goway.to/map/sprites/goway',
  attribution: '© OpenMapTiles © OpenStreetMap contributors',
};

describe('the low tier draws a dense style at Standard’s density', () => {
  test('only the low preset asks for it', () => {
    expect(QUALITY_PRESETS.low.basemap.density).toBe('standard');
    expect(QUALITY_PRESETS.medium.basemap.density).toBe('style');
    expect(QUALITY_PRESETS.high.basemap.density).toBe('style');
  });

  test('Streets carries overrides that make its POI layers Standard’s; Standard carries none', () => {
    const streets = styleTheme({ style: 'streets', preset: 'day' });
    const overrides = buildQualityOverrides(streets.palette, streets.options);
    expect(overrides.map((o) => o.layer)).toEqual(
      expect.arrayContaining(['poi-dot', 'label-poi', 'label-poi-minor', 'label-housenumber']),
    );
    const standard = styleTheme({ style: 'standard', preset: 'day' });
    expect(buildQualityOverrides(standard.palette, standard.options)).toEqual([]);
    const lean = buildLayers(streets.palette, 'openmaptiles', standardDensity(streets.options));
    for (const o of overrides) {
      const twin = lean.find((l) => l.id === o.layer) as Record<string, unknown>;
      if (o.filter !== undefined) expect(o.filter).toEqual(twin.filter as object);
      if (o.minzoom !== undefined) expect(o.minzoom).toBe(twin.minzoom as number);
    }
  });

  test('folded into the published document, each layer is exactly its Standard-density twin', () => {
    const streets = styleTheme({ style: 'streets', preset: 'day' });
    // As published: through JSON, as both forks read it.
    const document = JSON.parse(
      JSON.stringify(buildGowayMapStyle({ style: 'streets', preset: 'day' }, ENDPOINTS)),
    );
    const lean = buildLayers(streets.palette, 'openmaptiles', standardDensity(streets.options));
    const folded = withQualityOverrides(document);
    expect(folded).not.toBe(document);
    const twins = new Map(lean.map((l) => [l.id, JSON.parse(JSON.stringify(l))]));
    for (const layer of folded.layers as { id: string }[]) {
      const twin = twins.get(layer.id);
      if (twin) expect(layer, layer.id).toEqual(twin);
    }
    // The input is not touched.
    expect(JSON.stringify(document)).toBe(
      JSON.stringify(buildGowayMapStyle({ style: 'streets', preset: 'day' }, ENDPOINTS)),
    );
  });

  test('a document without overrides comes back as it is', () => {
    const standard = buildGowayMapStyle({ style: 'standard', preset: 'day' }, ENDPOINTS);
    expect(hasQualityOverrides(standard)).toBe(false);
    expect(withQualityOverrides(standard)).toBe(standard);
  });
});
