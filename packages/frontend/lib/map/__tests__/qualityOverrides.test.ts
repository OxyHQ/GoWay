/**
 * The low tier draws a dense style (Streets) at Standard's density
 * (`lib/map/style/qualityOverrides.ts`, `components/map/qualityOverrides.ts`,
 * `QualityProfile.basemap.density`): the overrides are exactly the layer
 * list at Standard's density, and the runtime undoes them exactly.
 */
import { describe, expect, test } from 'bun:test';

import { applyQualityOverrides, type QualityHost } from '@/components/map/qualityOverrides';
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

  test('the runtime applies them and undoes them exactly', () => {
    const streets = buildGowayMapStyle({ style: 'streets', preset: 'day' }, ENDPOINTS);
    const layers = new Map(
      streets.layers.map((l) => [l.id, JSON.parse(JSON.stringify(l)) as Record<string, unknown>]),
    );
    const before = JSON.stringify([...layers.values()]);
    const part = (id: string, key: 'layout' | 'paint') => {
      const layer = layers.get(id) as Record<string, Record<string, unknown>>;
      layer[key] ??= {};
      return layer[key];
    };
    const set = (id: string, key: 'layout' | 'paint', p: string, v: unknown) => {
      if (v === undefined) delete part(id, key)[p];
      else part(id, key)[p] = v;
    };
    const host: QualityHost = {
      getStyle: () => ({ metadata: streets.metadata }),
      getLayer: (id) => layers.get(id) as { minzoom?: number } | undefined,
      getFilter: (id) => layers.get(id)?.filter,
      setFilter: (id, f) => {
        (layers.get(id) as Record<string, unknown>).filter = f;
      },
      getLayoutProperty: (id, p) => part(id, 'layout')[p],
      setLayoutProperty: (id, p, v) => set(id, 'layout', p, v),
      getPaintProperty: (id, p) => part(id, 'paint')[p],
      setPaintProperty: (id, p, v) => set(id, 'paint', p, v),
      setLayerZoomRange: (id, min) => {
        (layers.get(id) as Record<string, unknown>).minzoom = min;
      },
    };
    const undo = applyQualityOverrides(host);
    expect(undo).not.toBeNull();
    expect(layers.get('label-poi-minor')?.minzoom).toBe(17);
    undo?.();
    expect(JSON.stringify([...layers.values()])).toBe(before);
  });

  test('a style without overrides is left alone', () => {
    const standard = buildGowayMapStyle({ style: 'standard', preset: 'day' }, ENDPOINTS);
    const host = { getStyle: () => ({ metadata: standard.metadata }) } as unknown as QualityHost;
    expect(applyQualityOverrides(host)).toBeNull();
  });
});
