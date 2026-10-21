/**
 * Both renderer forks draw the same document for the same ask: the style and
 * light the screen passes (else the device's, following the sun when asked),
 * at the quality profile's density — through the same functions.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { withQualityOverrides } from '@/components/map/qualityOverrides';
import { mapStyleLoading } from '@/lib/map/reliefFlag';
import { mapStyleFor } from '@/lib/map/style/catalogue';

const NIGHT_SUN = { altitudeDeg: -20, azimuthDeg: 300 };
const DUSK_SUN = { altitudeDeg: -2, azimuthDeg: 280 };

describe('mapStyleFor (useMapStyle’s decision)', () => {
  test('a device on Sun follows the sun over the map', () => {
    const device = { style: 'standard' as const, light: 'sun' as const };
    expect(mapStyleFor({}, device, false, NIGHT_SUN)).toEqual({
      selection: { style: 'standard', preset: 'night' },
      followsSun: true,
    });
    expect(mapStyleFor({}, device, false, DUSK_SUN).selection).toEqual({
      style: 'standard',
      preset: 'dusk',
    });
  });

  test('the app theme, a fixed light, or the screen’s own light ignore the sun', () => {
    expect(
      mapStyleFor({}, { style: 'standard', light: 'app' }, false, NIGHT_SUN),
    ).toEqual({ selection: { style: 'standard', preset: 'day' }, followsSun: false });
    expect(
      mapStyleFor({ lightPreset: 'day' }, { style: 'standard', light: 'sun' }, true, NIGHT_SUN),
    ).toEqual({ selection: { style: 'standard', preset: 'day' }, followsSun: false });
    expect(
      mapStyleFor({ style: 'streets' }, { style: 'standard', light: 'night' }, false, null)
        .selection,
    ).toEqual({ style: 'streets', preset: 'night' });
  });
});

describe('the low tier’s density reaches the first frame', () => {
  test('folded into the document as it loads, with or without the globe', () => {
    const document = {
      version: 8 as const,
      metadata: { 'goway:quality-low': [{ layer: 'poi', minzoom: 17 }] },
      layers: [{ id: 'poi', minzoom: 14 }],
    };
    for (const globe of [false, true]) {
      const loading = mapStyleLoading<typeof document>('/s.json', globe, withQualityOverrides);
      expect(loading.construct).toEqual({});
      const loaded = loading.deferred?.transformStyle(undefined, document);
      expect(loaded?.layers[0]).toEqual({ id: 'poi', minzoom: 17 });
      expect('projection' in (loaded ?? {})).toBe(globe);
    }
  });
});

describe('both forks', () => {
  const forks = ['MapCanvas.web.tsx', 'MapCanvas.native.tsx'].map((file) => ({
    file,
    source: readFileSync(join(import.meta.dir, '..', file), 'utf8'),
  }));

  test('ask useMapStyle for the screen’s style and light', () => {
    for (const { file, source } of forks) {
      expect(source, file).toMatch(/useMapStyle\(\s*\{ style: mapStyle, lightPreset, appearance \}/);
    }
  });

  test('fold the quality profile’s density through withQualityOverrides', () => {
    for (const { file, source } of forks) {
      expect(source, file).toContain("basemap.density === 'standard'");
    }
    const [web, native] = forks.map((fork) => fork.source);
    expect(web).toContain('standardDensity ? withQualityOverrides');
    expect(native).toContain('useStyleDocument(styleUrl, standardDensity)');
    expect(native).toContain('mapStyle={styleDocument}');
    const hook = readFileSync(join(import.meta.dir, '../useStyleDocument.ts'), 'utf8');
    expect(hook).toContain('withQualityOverrides(style)');
  });
});
