/**
 * Which tiles the city-3D layer meshes: the basemap's OpenMapTiles
 * `building` layer (the fallback, and the default), or GoWay's per-building
 * city tiles from the page's own origin.
 */
import { describe, expect, test } from 'bun:test';

import { citySourceFor } from '@/components/map/city3dLayer.web';
import { CITY_TILE_LAYER, CITY_TILE_PATH, CITY_TILE_ZOOM } from '@/lib/map/cityTiles';
import { OPENMAPTILES_SOURCE_LAYERS } from '@/lib/map/style/schema';

const basemap = { template: 'https://tiles.example/{z}/{x}/{y}.pbf', maxzoom: 14 };

describe('citySourceFor', () => {
  test('without the city tiles: the basemap, unchanged', () => {
    expect(citySourceFor(basemap, false, 'https://goway.to')).toEqual({
      tileUrlTemplate: basemap.template,
      tileZoom: 14,
      sourceLayer: OPENMAPTILES_SOURCE_LAYERS.building,
      tileFormat: 'openmaptiles',
    });
  });

  test('with them: same-origin city tiles at their own zoom and format', () => {
    const source = citySourceFor(basemap, true, 'http://localhost:8105');
    expect(source).toMatchObject({
      tileUrlTemplate: `http://localhost:8105${CITY_TILE_PATH}`,
      tileZoom: CITY_TILE_ZOOM,
      sourceLayer: CITY_TILE_LAYER,
      tileFormat: 'goway',
    });
    expect(source.maxTiles).toBeGreaterThan(0);
  });
});
