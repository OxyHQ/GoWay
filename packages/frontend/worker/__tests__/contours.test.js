/**
 * Contours at the edge (`worker/contours.js`), without a Workers runtime: the
 * DEM and the WebP decoder are the two seams, so a synthetic mountain stands
 * in for both and the tracer, the levels and the route run for real.
 *
 * What this cannot prove: that workerd instantiates the WebAssembly decoder
 * (`webpDecode.js`); `scripts/serve-map-build.ts` runs the same module with
 * the same decoder in Node, and the PR's contact sheet is drawn through it.
 */
import { describe, expect, test } from 'bun:test';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { MEMORY_BUDGET } from '../budget.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  CONTOUR_CACHE_ENTRIES,
  CONTOUR_ENTRY_BYTES,
  CONTOUR_LEVELS,
  CONTOUR_PARAMETERS,
  CONTOUR_TRACER,
  CONTOUR_VERSION,
  contourCacheKey,
  contourDemSource,
  contourTileOf,
  createContourService,
  serveContours,
} from '../contours.js';
import worker from '../index.js';
import { gowayMapEndpoints } from '../../lib/map/provider';

/**
 * What {@link CONTOUR_VERSION} stands for: the fingerprint of every parameter
 * a tile's bytes depend on. Change a level, an option or the tracer and this
 * fails — bump `contourVersion.js` and record the new fingerprint here.
 */
const FINGERPRINTS = {
  v1: '0fa3ff749be050b1',
};

/** A worker env with GoWay's elevation archive in R2. */
const ARCHIVE_ENV = { MAP_TILES: {}, MAP_TERRAIN_ARCHIVE: 'terrain/mapterhorn-20260901.pmtiles' };

const SIZE = 512;

/**
 * A cone 2,000 m high centred on DEM tile (z, cx, cy), as Terrarium RGBA:
 * elevation = r·256 + g + b/256 − 32768.
 */
function cone(z, cx, cy) {
  return async (zoom, x, y) => {
    const scale = 2 ** (z - zoom);
    const data = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let py = 0; py < SIZE; py += 1) {
      for (let px = 0; px < SIZE; px += 1) {
        // Position in units of the cone's tile.
        const gx = (x + px / SIZE) * scale - cx - 0.5;
        const gy = (y + py / SIZE) * scale - cy - 0.5;
        const ele = Math.max(0, 2000 - 2600 * Math.hypot(gx, gy));
        const v = ele + 32768;
        const i = (py * SIZE + px) * 4;
        data[i] = Math.floor(v / 256);
        data[i + 1] = Math.floor(v) % 256;
        data[i + 2] = Math.floor((v % 1) * 256);
        data[i + 3] = 255;
      }
    }
    return { width: SIZE, height: SIZE, data };
  };
}

/** A service over the cone: the "WebP" bytes are the tile address, decoded by the cone. */
function serviceOver(z, cx, cy) {
  const surface = cone(z, cx, cy);
  return createContourService({
    fetchDem: async (zoom, x, y) => new TextEncoder().encode(`${zoom}/${x}/${y}`),
    decode: async (bytes) => {
      const [zoom, x, y] = new TextDecoder().decode(bytes).split('/').map(Number);
      return surface(zoom, x, y);
    },
  });
}

function contoursOf(bytes) {
  const tile = new VectorTile(new PbfReader(bytes));
  const layer = tile.layers.contours;
  const features = [];
  for (let i = 0; i < (layer?.length ?? 0); i += 1) features.push(layer.feature(i).properties);
  return features;
}

describe('the contour tracer', () => {
  test('traces a mountain at its zoom’s interval, index lines marked', async () => {
    const service = serviceOver(12, 2100, 1460);
    const features = contoursOf(await service.tile(12, 2100, 1460));
    expect(features.length).toBeGreaterThan(10);
    const [every, index] = CONTOUR_LEVELS[12];
    for (const { ele, level } of features) {
      expect(ele % every).toBe(0);
      expect(level).toBe(ele % index === 0 ? 1 : 0);
      expect(ele).toBeGreaterThan(0);
      expect(ele).toBeLessThanOrEqual(2000);
    }
    expect(features.some((f) => f.level === 1)).toBe(true);
  });

  test('flat ground and open sea have no contours', async () => {
    const sea = createContourService({ fetchDem: async () => null, decode: async () => null });
    expect(contoursOf(await sea.tile(12, 2100, 1460))).toEqual([]);
  });

  test('outside the zooms it makes, nothing', async () => {
    const service = serviceOver(12, 2100, 1460);
    expect((await service.tile(8, 10, 10)).length).toBe(0);
  });

  test('missing DEM is sea level: a flat sea with no DEM anywhere has no contours, whatever its neighbours', async () => {
    // The middle tile is at 0 m and every neighbour is missing. Were a
    // missing tile anything but sea level, the seam between them would cross
    // every level between and draw a ring of contours around the tile.
    const flat = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; i += 1) {
      flat[i * 4] = 128; // 128·256 − 32768 = 0 m
      flat[i * 4 + 3] = 255;
    }
    const service = createContourService({
      fetchDem: async (zoom, x, y) =>
        zoom === 11 && x === 1050 && y === 730 ? new TextEncoder().encode('flat') : null,
      decode: async () => ({ width: SIZE, height: SIZE, data: flat }),
    });
    expect(contoursOf(await service.tile(12, 2100, 1460))).toEqual([]);
  });

  test('a reader panning far holds no more than the isolate budget allows', async () => {
    // One tile's 3×3 DEM neighbourhood fits, and the caches fit their line.
    expect(CONTOUR_CACHE_ENTRIES).toBeGreaterThanOrEqual(9);
    expect(CONTOUR_CACHE_ENTRIES * CONTOUR_ENTRY_BYTES).toBeLessThanOrEqual(MEMORY_BUDGET.contours);
    // Thirty tiles apart from each other: ~270 distinct DEM tiles asked for.
    const service = serviceOver(12, 2100, 1460);
    for (let i = 0; i < 30; i += 1) await service.tile(12, 2000 + i * 4, 1400 + (i % 5) * 4);
    for (const held of service.held()) expect(held).toBeLessThanOrEqual(CONTOUR_CACHE_ENTRIES);
  });
});

describe('the route', () => {
  const headersFor = (seconds) => ({ 'cache-control': `public, max-age=${seconds}` });
  const ctx = { waitUntil() {} };

  test('takes this version’s z9–14 tile paths inside the world, and nothing else', () => {
    const v = CONTOUR_VERSION;
    expect(contourTileOf(`/map/contours/${v}/12/2100/1460.pbf`)).toEqual({ z: 12, x: 2100, y: 1460 });
    expect(contourTileOf('/map/contours/12/2100/1460.pbf')).toBeNull();
    expect(contourTileOf('/map/contours/v0/12/2100/1460.pbf')).toBeNull();
    expect(contourTileOf(`/map/contours/${v}/8/1/1.pbf`)).toBeNull();
    expect(contourTileOf(`/map/contours/${v}/15/1/1.pbf`)).toBeNull();
    expect(contourTileOf(`/map/contours/${v}/9/512/1.pbf`)).toBeNull();
    expect(contourTileOf(`/map/contours/${v}/12/../1.pbf`)).toBeNull();
  });

  test('the version stands for the parameters: a change to them without a new version fails here', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(CONTOUR_PARAMETERS))
      .digest('hex')
      .slice(0, 16);
    expect(FINGERPRINTS[CONTOUR_VERSION]).toBe(fingerprint);
    // The tracer named is the tracer installed.
    const installed = JSON.parse(
      readFileSync(new URL('../../../../node_modules/maplibre-contour/package.json', import.meta.url), 'utf8'),
    ).version;
    expect(CONTOUR_TRACER).toBe(`maplibre-contour@${installed}`);
  });

  test('the style documents name the versioned URL', () => {
    expect(gowayMapEndpoints('https://goway.to').contours).toBe(
      `https://goway.to/map/contours/${CONTOUR_VERSION}/{z}/{x}/{y}.pbf`,
    );
  });

  test('the edge cache key holds the version and the DEM archive the tile was traced from', () => {
    const tile = { z: 12, x: 2100, y: 1460 };
    const a = contourCacheKey(tile, contourDemSource(ARCHIVE_ENV));
    const b = contourCacheKey(tile, contourDemSource({ ...ARCHIVE_ENV, MAP_TERRAIN_ARCHIVE: 'terrain/bare-earth-20261101.pmtiles' }));
    expect(a).not.toBe(b);
    expect(a).toContain(CONTOUR_VERSION);
    expect(a).toContain(encodeURIComponent('r2/terrain/mapterhorn-20260901.pmtiles'));
  });

  test('without GoWay’s own elevation archive nothing is traced: 503, no DEM fetched', async () => {
    let fetched = 0;
    const service = createContourService({
      fetchDem: async () => {
        fetched += 1;
        return null;
      },
      decode: async () => null,
    });
    const url = new URL(`https://goway.to/map/contours/${CONTOUR_VERSION}/12/2100/1460.pbf`);
    for (const env of [{}, { MAP_TERRAIN_UPSTREAM: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp' }]) {
      const response = await serveContours(url, new Request(url), env, ctx, service, headersFor);
      expect(response.status).toBe(503);
    }
    expect(fetched).toBe(0);
  });

  test('answers a tile as a cacheable vector tile, and a bad path as a 404', async () => {
    const service = serviceOver(12, 2100, 1460);
    const url = new URL(`https://goway.to/map/contours/${CONTOUR_VERSION}/12/2100/1460.pbf`);
    const response = await serveContours(url, new Request(url), ARCHIVE_ENV, ctx, service, headersFor);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-protobuf');
    expect(response.headers.get('cache-control')).toContain('max-age=31536000');
    expect(contoursOf(new Uint8Array(await response.arrayBuffer())).length).toBeGreaterThan(0);

    const bad = new URL(`https://goway.to/map/contours/${CONTOUR_VERSION}/20/1/1.pbf`);
    expect((await serveContours(bad, new Request(bad), ARCHIVE_ENV, ctx, service, headersFor)).status).toBe(
      404,
    );
  });

  test('a DEM that fails is a 502, not an empty tile cached for a year', async () => {
    const broken = createContourService({
      fetchDem: async () => {
        throw new Error('archive unreachable');
      },
      decode: async () => null,
    });
    const url = new URL(`https://goway.to/map/contours/${CONTOUR_VERSION}/12/2100/1460.pbf`);
    const response = await serveContours(url, new Request(url), ARCHIVE_ENV, ctx, broken, headersFor);
    expect(response.status).toBe(502);
  });

  test('the Worker routes /map/contours/ to it', async () => {
    const url = new URL('https://goway.to/map/contours/3/1/1.pbf');
    const response = await worker.fetch(new Request(url), {}, ctx);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('contour');
  });
});
