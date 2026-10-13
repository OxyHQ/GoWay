/**
 * Satellite imagery on the client (`docs/MAP_SATELLITE.md`): the mode a page
 * draws, the satellite and hybrid documents, and which sources the credit
 * names for a view.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

import { encodeCoverageTree } from '@/worker/coverageTree.js';
import { cellsTree } from '@/scripts/imagery/cells';

import { CREDIT_SECTIONS } from '../credits';
import { IMAGERY_TIER_IDS, IMAGERY_TIERS, resolveImageryMode } from '../imagery';
import { imagerySourcesInView, parseImageryCoverage, tierZoom } from '../imageryCoverage';
import { IMAGERY_SOURCES } from '../imagerySources';
import {
  GOWAY_LABEL_ANCHOR_LAYER_ID,
  IMAGERY_ATTRIBUTION_HREF,
  resolveMapStyleUrl,
} from '../provider';
import { buildImageryStyle, IMAGERY_METADATA_KEY, imageryLayerId } from '../style/imagery';

const PUBLIC_MAP = join(import.meta.dir, '..', '..', '..', 'public', 'map');
const read = (name: string) =>
  JSON.parse(readFileSync(join(PUBLIC_MAP, name), 'utf8')) as StyleSpecification;
const dark = read('goway-dark.json');

describe('the mode a page draws', () => {
  const production = { development: false, search: '?imagery=satellite' };
  const development = { development: true, search: '?imagery=hybrid' };
  test("the screen's choice wins; null is no imagery", () => {
    expect(resolveImageryMode('satellite', development)).toBe('satellite');
    expect(resolveImageryMode(null, development)).toBeNull();
  });
  test('the address is read in a development build only', () => {
    expect(resolveImageryMode(undefined, development)).toBe('hybrid');
    expect(resolveImageryMode(undefined, production)).toBeNull();
    expect(
      resolveImageryMode(undefined, { development: true, search: '?imagery=bing' }),
    ).toBeNull();
  });
  test('each mode has its own document on GoWay’s origin', () => {
    expect(resolveMapStyleUrl('light', 'satellite')).toEndWith('/map/goway-satellite.json');
    expect(resolveMapStyleUrl('dark', 'hybrid')).toEndWith('/map/goway-hybrid.json');
    expect(resolveMapStyleUrl('light', null)).toEndWith('/map/goway-light.json');
  });
});

describe('the imagery documents', () => {
  for (const mode of ['satellite', 'hybrid'] as const) {
    const style = buildImageryStyle(dark, mode, 'https://goway.to');
    test(`${mode}: valid, committed, imagery directly over the background`, () => {
      expect(validateStyleMin(style)).toEqual([]);
      expect(read(`goway-${mode}.json`)).toEqual(JSON.parse(JSON.stringify(style)));
      expect(style.layers.slice(0, 4).map((layer) => layer.id)).toEqual([
        'background',
        ...IMAGERY_TIER_IDS.map(imageryLayerId),
      ]);
      expect((style.metadata as Record<string, unknown>)[IMAGERY_METADATA_KEY]).toBe(mode);
      // Overlays are inserted against the anchor on every GoWay document.
      expect(style.layers.some((layer) => layer.id === GOWAY_LABEL_ANCHOR_LAYER_ID)).toBe(true);
    });
    test(`${mode}: no fills and no 3D buildings over the photograph`, () => {
      const types = new Set(style.layers.map((layer) => layer.type));
      expect(types.has('fill')).toBe(false);
      expect(types.has('fill-extrusion')).toBe(false);
    });
    test(`${mode}: each tier's source has the tier's zooms, on GoWay's origin`, () => {
      for (const tier of IMAGERY_TIER_IDS) {
        const source = style.sources[`goway:imagery:${tier}`];
        expect(source).toMatchObject({
          type: 'raster',
          tileSize: 512,
          minzoom: IMAGERY_TIERS[tier].minZoom,
          maxzoom: IMAGERY_TIERS[tier].maxZoom,
          tiles: [`https://goway.to/map/satellite/${tier}/{z}/{x}/{y}.webp`],
        });
      }
    });
  }

  test('satellite is the imagery alone', () => {
    const style = buildImageryStyle(dark, 'satellite', 'https://goway.to');
    expect(
      style.layers.filter((layer) => layer.type === 'symbol' || layer.type === 'line'),
    ).toEqual([]);
  });

  test('hybrid keeps the roads (no casings) and the labels, legible over a photo', () => {
    const style = buildImageryStyle(dark, 'hybrid', 'https://goway.to');
    const ids = style.layers.map((layer) => layer.id);
    expect(ids).toContain('road-motorway');
    expect(ids).toContain('label-place-city');
    expect(ids.some((id) => id.includes('casing'))).toBe(false);
    const city = style.layers.find((layer) => layer.id === 'label-place-city');
    const paint = (city?.paint ?? {}) as Record<string, unknown>;
    expect(paint['text-halo-color']).toBe('rgba(0,0,0,0.78)');
  });
});

describe('the credit', () => {
  const coverage = parseImageryCoverage({
    sets: [
      {
        id: 'icgc-ortofoto-2025',
        tiers: ['detail'],
        minZoom: 13,
        maxZoom: 18,
        sources: ['icgc-ortofoto'],
        bbox: [2.1, 41.3, 2.3, 41.5],
        cells: encodeCoverageTree(cellsTree([{ z: 13, x: 4144, y: 3058 }], 13), 13),
      },
      {
        id: 'worldcover-2021',
        tiers: ['base'],
        minZoom: 8,
        maxZoom: 13,
        sources: ['esa-worldcover-2021'],
        bbox: [0, 40, 4, 43],
        cells: encodeCoverageTree(cellsTree([{ z: 8, x: 129, y: 95 }], 8), 8),
      },
      {
        id: 'blue-marble-2004',
        tiers: ['base'],
        minZoom: 0,
        maxZoom: 7,
        sources: ['nasa-blue-marble'],
        bbox: [-180, -85, 180, 85],
        cells: encodeCoverageTree(cellsTree([{ z: 0, x: 0, y: 0 }], 0), 0),
      },
      // A source this build has no licence record for is never credited by name: dropped.
      {
        id: 'mystery',
        tiers: ['base'],
        minZoom: 0,
        maxZoom: 13,
        sources: ['somebody-else'],
        bbox: [-180, -85, 180, 85],
        cells: encodeCoverageTree(cellsTree([{ z: 0, x: 0, y: 0 }], 0), 0),
      },
    ],
  });
  // Sant Gervasi, inside 13/4144/3058 (2.109–2.153°E, 41.410–41.443°N).
  const santGervasi = { west: 2.12, south: 41.415, east: 2.14, north: 41.43 };

  test('only sets this build knows are kept', () => {
    expect(coverage.sets.map((set) => set.id)).toEqual([
      'icgc-ortofoto-2025',
      'worldcover-2021',
      'blue-marble-2004',
    ]);
  });

  test('a tier is drawn from its first zoom, and requests at most its last', () => {
    expect(tierZoom('detail', 11.4)).toBeNull();
    expect(tierZoom('detail', 16.2)).toBe(16);
    expect(tierZoom('base', 17)).toBe(13);
    expect(tierZoom('fine', 18.6)).toBe(19);
  });

  test('the sources on screen follow the zoom', () => {
    expect(imagerySourcesInView(coverage, { zoom: 4, ...santGervasi })).toEqual([
      'nasa-blue-marble',
    ]);
    expect(imagerySourcesInView(coverage, { zoom: 10, ...santGervasi })).toEqual([
      'esa-worldcover-2021',
    ]);
    // Over-zoomed base under the orthophoto: both are on screen.
    expect(imagerySourcesInView(coverage, { zoom: 16, ...santGervasi })).toEqual([
      'icgc-ortofoto',
      'esa-worldcover-2021',
    ]);
  });

  test('a pitched view with unusable bounds over-credits rather than under-credits', () => {
    const horizon = { west: 1.2, south: 41.5, east: 2.6, north: Number.NaN };
    // Counted as the whole world: every set drawn at z13 is credited.
    expect(imagerySourcesInView(coverage, { zoom: 13, ...horizon })).toEqual([
      'icgc-ortofoto',
      'esa-worldcover-2021',
    ]);
    const inverted = { west: 2.6, south: 41.5, east: 1.2, north: 42.5 };
    expect(imagerySourcesInView(coverage, { zoom: 16, ...inverted })).toEqual([
      'icgc-ortofoto',
      'esa-worldcover-2021',
    ]);
  });

  test('a source is not credited where it has no cell', () => {
    const lisbon = { west: -9.2, south: 38.7, east: -9.1, north: 38.75 };
    expect(imagerySourcesInView(coverage, { zoom: 16, ...lisbon })).toEqual([]);
    expect(imagerySourcesInView(coverage, { zoom: 3, ...lisbon })).toEqual(['nasa-blue-marble']);
  });

  test('every source is on the attribution page, with its notice', () => {
    const section = CREDIT_SECTIONS.find((candidate) => candidate.id === 'imagery');
    for (const source of Object.values(IMAGERY_SOURCES)) {
      expect(section?.notices).toContain(source.notice);
      expect(section?.links.map((link) => link.label)).toContain(source.credit);
    }
    expect(IMAGERY_ATTRIBUTION_HREF).toBe('https://goway.to/attribution#imagery');
  });

  test('no excluded provider is ever a source', () => {
    const text = JSON.stringify(IMAGERY_SOURCES).toLowerCase();
    for (const name of [
      'google',
      'apple',
      'bing',
      'esri',
      'arcgis',
      'mapbox',
      'maxar',
      'planet',
      'eox',
    ]) {
      expect(text).not.toContain(name);
    }
  });
});
