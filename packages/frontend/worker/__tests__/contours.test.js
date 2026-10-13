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

import { CONTOUR_LEVELS, contourTileOf, createContourService, serveContours } from '../contours.js';
import worker from '../index.js';

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
});

describe('the route', () => {
  const headersFor = (seconds) => ({ 'cache-control': `public, max-age=${seconds}` });
  const ctx = { waitUntil() {} };

  test('takes z9–14 tile paths inside the world, and nothing else', () => {
    expect(contourTileOf('/map/contours/12/2100/1460.pbf')).toEqual({ z: 12, x: 2100, y: 1460 });
    expect(contourTileOf('/map/contours/8/1/1.pbf')).toBeNull();
    expect(contourTileOf('/map/contours/15/1/1.pbf')).toBeNull();
    expect(contourTileOf('/map/contours/9/512/1.pbf')).toBeNull();
    expect(contourTileOf('/map/contours/12/../1.pbf')).toBeNull();
  });

  test('answers a tile as a cacheable vector tile, and a bad path as a 404', async () => {
    const service = serviceOver(12, 2100, 1460);
    const url = new URL('https://goway.to/map/contours/12/2100/1460.pbf');
    const response = await serveContours(url, new Request(url), {}, ctx, service, headersFor);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-protobuf');
    expect(response.headers.get('cache-control')).toContain('max-age=31536000');
    expect(contoursOf(new Uint8Array(await response.arrayBuffer())).length).toBeGreaterThan(0);

    const bad = new URL('https://goway.to/map/contours/20/1/1.pbf');
    expect((await serveContours(bad, new Request(bad), {}, ctx, service, headersFor)).status).toBe(
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
    const url = new URL('https://goway.to/map/contours/12/2100/1460.pbf');
    const response = await serveContours(url, new Request(url), {}, ctx, broken, headersFor);
    expect(response.status).toBe(502);
  });

  test('the Worker routes /map/contours/ to it', async () => {
    const url = new URL('https://goway.to/map/contours/3/1/1.pbf');
    const response = await worker.fetch(new Request(url), {}, ctx);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('contour');
  });
});
