/**
 * Which tiles the city-3D layer meshes: the basemap's OpenMapTiles `building`
 * layer always, and GoWay's per-building city tiles instead wherever their
 * archives declare coverage — fetched from the page's own origin, and none at
 * all when that fails (so the basemap's buildings draw, never a flat map).
 */
import { describe, expect, test } from 'bun:test';

import { citySourceFor, fetchCityCoverage } from '@/components/map/city3dLayer.web';
import {
  CITY_COVERAGE_PATH,
  CITY_TILE_LAYER,
  CITY_TILE_PATH,
  CITY_TILE_ZOOM,
  CITY_TREE_LAYER,
} from '@/lib/map/cityTiles';
import { OPENMAPTILES_SOURCE_LAYERS } from '@/lib/map/style/schema';

const basemap = { template: 'https://tiles.example/{z}/{x}/{y}.pbf', maxzoom: 14 };
const BARCELONA: [number, number, number, number] = [2.052, 41.317, 2.228, 41.468];

describe('citySourceFor', () => {
  test('without the city tiles: the basemap, and no city source', () => {
    expect(citySourceFor(basemap, false, 'https://goway.to')).toEqual({
      tileUrlTemplate: basemap.template,
      tileZoom: 14,
      sourceLayer: OPENMAPTILES_SOURCE_LAYERS.building,
      city: null,
    });
  });

  test('with them: the basemap stays the base; city tiles come with their coverage', () => {
    const source = citySourceFor(basemap, true, 'http://localhost:8105', [BARCELONA]);
    expect(source.tileUrlTemplate).toBe(basemap.template);
    expect(source.sourceLayer).toBe(OPENMAPTILES_SOURCE_LAYERS.building);
    expect(source.city).toEqual({
      tileUrlTemplate: `http://localhost:8105${CITY_TILE_PATH}`,
      tileZoom: CITY_TILE_ZOOM,
      sourceLayer: CITY_TILE_LAYER,
      treeLayer: CITY_TREE_LAYER,
      coverage: [BARCELONA],
    });
  });
});

describe('fetchCityCoverage', () => {
  const answer = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status });

  test('reads the archives’ coverage from the page’s origin', async () => {
    const seen: string[] = [];
    const coverage = await fetchCityCoverage('http://localhost:8103', async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ archives: [{ coverage: BARCELONA }] }));
    });
    expect(seen).toEqual([`http://localhost:8103${CITY_COVERAGE_PATH}`]);
    expect(coverage).toEqual([BARCELONA]);
  });

  test('unreachable, failing, malformed or slow: no coverage (the basemap draws)', async () => {
    expect(
      await fetchCityCoverage('x', async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toEqual([]);
    expect(await fetchCityCoverage('x', answer(404, {}))).toEqual([]);
    expect(await fetchCityCoverage('x', answer(200, { archives: [{ coverage: [1, 2] }] }))).toEqual(
      [],
    );
    const never = (_: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    expect(await fetchCityCoverage('x', never, 10)).toEqual([]);
  });

  test('production’s owned-tile set is passed on encoded, and only when it is one', async () => {
    const tiles = { maxZoom: 14, bits: 'Ag==' };
    expect(await fetchCityCoverage('x', answer(200, { schema: 2, tiles }))).toEqual([tiles]);
    // The Worker with no manifest configured: covers nothing.
    expect(
      await fetchCityCoverage('x', answer(200, { schema: 2, regions: [], tiles: null })),
    ).toEqual([]);
    for (const bad of [
      { maxZoom: 14 },
      { maxZoom: '14', bits: 'Ag==' },
      { maxZoom: 14, bits: 'not base64!' },
      { maxZoom: 99, bits: 'Ag==' },
    ]) {
      expect(await fetchCityCoverage('x', answer(200, { schema: 2, tiles: bad }))).toEqual([]);
    }
  });
});
