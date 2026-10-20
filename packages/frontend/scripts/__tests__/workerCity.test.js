/**
 * The city tiles at the edge (`map-service/src/city.js`): which region's archive
 * answers a tile, and what the client is told when none does.
 *
 * Built from the real pieces, not copies of them: the archives are written by
 * the compiler's own PMTiles writer, the ownerships by `citygen/ownership.ts`,
 * and the manifest by `build-city-manifest.ts`'s `mergeManifest` — so a
 * change to any of them that the Worker cannot read fails here.
 *
 * Two regions side by side on a z15 grid, the way two countries meet:
 *
 *     x:   100 … 102 103 104 … 107 108
 *          [ alpha ──────]
 *                    [ beta ─────────]      (x = 103 owned by both)
 *     y:   200 … 203 for both
 *
 * `alpha` has buildings at (100,200) and (101,200) and a road archive;
 * `beta` has buildings at (103,200) — which alpha also owns, and answers —
 * and (105,201), and no road archive.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { mergeManifest } from '../build-city-manifest';
import { rectOwnership } from '../citygen/ownership';
import { writePmtiles } from '../citygen/pmtilesWriter';
import {
  forgetCityManifest,
  ownerOf,
  parseCityManifest,
  serveCity,
} from '@goway/map-service/city.js';
import {
  coverageAt,
  countCoverageTiles,
  decodeCoverageTree,
  EMPTY,
  encodeCoverageTree,
  FULL,
} from '@goway/map-service/coverageTree.js';
import * as workerModule from '@goway/map-service/index.js';
import { forgetDirectories } from '@goway/map-service/tiles.js';

const STAMP = '20261011-test';
const MANIFEST_KEY = 'city/manifest.json';
const encoder = new TextEncoder();

function archive(tiles) {
  return writePmtiles(
    [...tiles].map(([key, body]) => {
      const [x, y] = key.split('/').map(Number);
      return { z: 15, x, y, bytes: Bun.gzipSync(encoder.encode(body)) };
    }),
    { minZoom: 15, maxZoom: 15, bounds: [-180, -85, 180, 85], center: [0, 0, 15], metadata: {} },
  );
}

const sha = (bytes) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

function entry(id, rect, archives) {
  const tree = rectOwnership({ zoom: 15, ...rect });
  const encoded = encodeCoverageTree(tree, 15);
  const ref = (kind, bytes) =>
    bytes
      ? {
          key: `${kind}/${STAMP}/${id}.pmtiles`,
          receipt: `${kind}/${STAMP}/${id}.pmtiles.receipt.json`,
          bytes: bytes.length,
          sha256: sha(bytes),
          tiles: 1,
          seconds: 1,
          peakRssMb: 1,
        }
      : null;
  return {
    id,
    name: id,
    region: id,
    part: null,
    stamp: STAMP,
    bbox: boundsOf(rect),
    ownership: { maxZoom: 15, nodes: encoded.nodes, bits: encoded.bits },
    ownedTiles: countCoverageTiles(tree, 15),
    source: { extract: `https://example.test/${id}.osm.pbf`, polygon: { url: '', sha256: '' } },
    official: [],
    city: ref('city', archives.city),
    roads: ref('city-roads', archives.roads),
    builtAt: '2026-10-11T00:00:00.000Z',
  };
}

function boundsOf({ x0, y0, x1, y1 }) {
  const n = 2 ** 15;
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [(x0 / n) * 360 - 180, lat(y1), (x1 / n) * 360 - 180, lat(y0)];
}

const ALPHA = {
  city: archive(
    new Map([
      ['100/200', 'alpha building 100/200'],
      ['101/200', 'alpha building 101/200'],
    ]),
  ),
  roads: archive(new Map([['100/200', 'alpha road 100/200']])),
};
const BETA = {
  city: archive(
    new Map([
      ['103/200', 'beta building 103/200 — alpha owns this tile too and answers it'],
      ['105/201', 'beta building 105/201'],
    ]),
  ),
};

function fixture() {
  const alpha = entry('test/alpha', { x0: 100, y0: 200, x1: 104, y1: 204 }, ALPHA);
  const beta = entry('test/beta', { x0: 103, y0: 200, x1: 108, y1: 204 }, BETA);
  const { manifest } = mergeManifest(null, [beta, alpha], '2026-10-11T00:00:00.000Z');
  const objects = new Map([
    [MANIFEST_KEY, encoder.encode(JSON.stringify(manifest))],
    [alpha.city.key, ALPHA.city],
    [alpha.city.receipt, encoder.encode('{"receipt":"alpha"}')],
    [alpha.roads.key, ALPHA.roads],
    [alpha.roads.receipt, encoder.encode('{"receipt":"alpha roads"}')],
    [beta.city.key, BETA.city],
    [beta.city.receipt, encoder.encode('{"receipt":"beta"}')],
    ['planet/20260921.pmtiles', encoder.encode('the basemap: not offered by /map/city/data')],
  ]);
  return { manifest, alpha, beta, objects };
}

/** An R2 bucket over a map of objects, counting reads per key. */
function bucket(objects) {
  const reads = [];
  // As R2: `size` is the whole object's, whatever range was read.
  const object = (key, bytes, range, size = bytes.length) => ({
    size,
    httpEtag: `"${key.length}"`,
    range,
    body: new Blob([bytes]).stream(),
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
  });
  return {
    reads,
    async get(key, options = {}) {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      let range = options.range;
      if (range instanceof Headers) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range.get('range') ?? '');
        range = match
          ? {
              offset: Number(match[1]),
              length: (match[2] ? Number(match[2]) + 1 : bytes.length) - Number(match[1]),
            }
          : undefined;
      }
      if (!range) return object(key, bytes);
      const slice = bytes.subarray(
        range.offset,
        Math.min(bytes.length, range.offset + range.length),
      );
      return object(key, slice, range, bytes.length);
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, httpEtag: '"h"' } : null;
    },
  };
}

function cacheStore() {
  const store = new Map();
  return {
    store,
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        store.set(request.url, response);
      },
    },
  };
}

const ctx = { waitUntil: (promise) => promise };
const realCaches = globalThis.caches;
let caches;
beforeEach(() => {
  caches = cacheStore();
  globalThis.caches = caches;
  forgetCityManifest();
  forgetDirectories();
});
afterEach(() => {
  globalThis.caches = realCaches;
});

function env(objects) {
  const MAP_TILES = bucket(objects);
  return { MAP_TILES, MAP_CITY_MANIFEST: MANIFEST_KEY };
}

async function get(path, e, init = {}) {
  const request = new Request(`https://goway.to${path}`, init);
  return serveCity(new URL(request.url), request, e, ctx);
}

const tile = (x, y, kind = 'city') => `/map/${kind}/15/${x}/${y}.pbf`;

describe('a tile, from the region that owns it', () => {
  test('owned and built: the decoded tile, public and CORS-open', async () => {
    const e = env(fixture().objects);
    const response = await get(tile(100, 200), e);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(await response.text()).toBe('alpha building 100/200');
  });

  test('the next region over answers from its own archive', async () => {
    const e = env(fixture().objects);
    const response = await get(tile(105, 201), e);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('beta building 105/201');
  });

  test('owned but empty (sea, fields): 204, cached, and empty to the client', async () => {
    const e = env(fixture().objects);
    const first = await get(tile(102, 203), e);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe('');
    const reads = e.MAP_TILES.reads.length;
    const second = await get(tile(102, 203), e);
    expect(second.status).toBe(204);
    expect(e.MAP_TILES.reads.length).toBe(reads);
  });

  test('owned by no region: 404, cached only as long as a manifest', async () => {
    const e = env(fixture().objects);
    const response = await get(tile(108, 200), e);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    // No archive was opened for it — only the manifest was read.
    expect(e.MAP_TILES.reads).toEqual([MANIFEST_KEY]);
  });

  test('a tile owned twice is answered by the first region in the manifest', async () => {
    // The manifest sorts by id whatever order the entries came in, so the
    // tie-break is stable: alpha, which has nothing at (103,200) — 204, not
    // beta's building.
    const { objects, manifest } = fixture();
    expect(manifest.regions.map((r) => r.id)).toEqual(['test/alpha', 'test/beta']);
    const e = env(objects);
    expect((await get(tile(103, 200), e)).status).toBe(204);
  });

  test('region boundaries are exact, on both axes', async () => {
    const { manifest } = parseFixture();
    expect(ownerOf(manifest, 99, 200)).toBeNull();
    expect(ownerOf(manifest, 100, 200)?.id).toBe('test/alpha');
    expect(ownerOf(manifest, 102, 203)?.id).toBe('test/alpha');
    expect(ownerOf(manifest, 102, 204)).toBeNull();
    expect(ownerOf(manifest, 102, 199)).toBeNull();
    expect(ownerOf(manifest, 104, 200)?.id).toBe('test/beta');
    expect(ownerOf(manifest, 107, 203)?.id).toBe('test/beta');
    expect(ownerOf(manifest, 108, 203)).toBeNull();
  });

  test('roads come from the road archive; a region without one is not covered for roads', async () => {
    const e = env(fixture().objects);
    const road = await get(tile(100, 200, 'city-roads'), e);
    expect(road.status).toBe(200);
    expect(await road.text()).toBe('alpha road 100/200');
    expect((await get(tile(101, 200, 'city-roads'), e)).status).toBe(204);
    expect((await get(tile(105, 201, 'city-roads'), e)).status).toBe(404);
  });

  test('refuses what cannot be a city tile without touching storage', async () => {
    const e = env(fixture().objects);
    for (const path of [
      '/map/city/14/50/100.pbf',
      '/map/city/16/200/400.pbf',
      '/map/city/15/32768/0.pbf',
      '/map/city/15/0/32768.pbf',
      '/map/city/15/1/2.png',
      '/map/city/15/-1/2.pbf',
      '/map/city-roads/15/1/2/3.pbf',
    ]) {
      expect({ path, status: (await get(path, e)).status }).toEqual({ path, status: 404 });
    }
    expect(e.MAP_TILES.reads).toEqual([]);
  });

  test('HEAD keeps the status: 200, 204 and 404 alike, with no body', async () => {
    const e = env(fixture().objects);
    for (const [x, y, status] of [
      [100, 200, 200],
      [102, 203, 204],
      [108, 200, 404],
    ]) {
      // Twice: the second answer comes from the edge cache where there is one.
      for (let i = 0; i < 2; i++) {
        const response = await get(tile(x, y), e, { method: 'HEAD' });
        expect({ x, status: response.status }).toEqual({ x, status });
        expect(await response.text()).toBe('');
      }
    }
  });

  test('the manifest is read once, not once per tile', async () => {
    const e = env(fixture().objects);
    await get(tile(100, 200), e);
    await get(tile(101, 200), e);
    await get(tile(105, 201), e);
    expect(e.MAP_TILES.reads.filter((key) => key === MANIFEST_KEY)).toHaveLength(1);
    // A cold isolate in the same colo reads it from the edge, not from R2.
    forgetCityManifest();
    await get(tile(100, 200), e);
    expect(e.MAP_TILES.reads.filter((key) => key === MANIFEST_KEY)).toHaveLength(1);
  });

  test('the edge cache key names the archive, so a rebuilt region is never mixed with the old', async () => {
    const e = env(fixture().objects);
    await get(tile(100, 200), e);
    const keys = [...caches.store.keys()].filter((key) => key.includes('/map/city/'));
    expect(keys).toEqual([
      `https://goway.internal/tiles/v2/map/city/${encodeURIComponent(`city/${STAMP}/test/alpha.pmtiles`)}/15/100/200.pbf`,
    ]);
  });
});

function parseFixture() {
  const { manifest } = fixture();
  return { manifest: parseCityManifest(manifest) };
}

describe('off until configured', () => {
  test('no manifest key: every tile 404 and a coverage that covers nothing, storage untouched', async () => {
    const e = { MAP_TILES: bucket(fixture().objects) };
    expect((await get(tile(100, 200), e)).status).toBe(404);
    const coverage = await get('/map/city/coverage.json', e);
    expect(coverage.status).toBe(200);
    expect(await coverage.json()).toEqual({ schema: 2, regions: [], tiles: null });
    expect((await get('/map/city/manifest.json', e)).status).toBe(404);
    expect((await get(`/map/city/data/city/${STAMP}/test/alpha.pmtiles`, e)).status).toBe(404);
    expect(e.MAP_TILES.reads).toEqual([]);
  });

  test('a broken manifest: tiles 502, coverage not-ok (the client then draws the basemap)', async () => {
    const objects = fixture().objects;
    objects.set(
      MANIFEST_KEY,
      encoder.encode('{"schema":1,"tileZoom":15,"regions":[{"id":"../x"}]}'),
    );
    const e = env(objects);
    expect((await get(tile(100, 200), e)).status).toBe(502);
    expect((await get('/map/city/coverage.json', e)).status).toBe(503);
  });

  test('a manifest of another schema is refused, not half-read', () => {
    const { manifest } = fixture();
    expect(() => parseCityManifest({ ...manifest, schema: 2 })).toThrow(/schema-1/);
    expect(() => parseCityManifest({ ...manifest, tileZoom: 14 })).toThrow(/tileZoom/);
    const bad = structuredClone(manifest);
    bad.regions[0].city.key = 'planet/20260921.pmtiles';
    expect(() => parseCityManifest(bad)).toThrow(/city key/);
  });
});

describe('/map/city/coverage.json', () => {
  test('the union of the regions’ tiles at z14: covered only where all four z15 tiles are owned', async () => {
    const e = env(fixture().objects);
    const response = await get('/map/city/coverage.json', e);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await response.json();
    expect(body.schema).toBe(2);
    // No `archives`: a client that only knows boxes sees no coverage.
    expect(body.archives).toBeUndefined();
    expect(body.regions.map((r) => r.id)).toEqual(['test/alpha', 'test/beta']);
    const tree = decodeCoverageTree(body.tiles);
    // alpha + beta own x 100–107, y 200–203: z14 x 50–53, y 100–101, all full.
    for (let x = 50; x <= 53; x++) {
      for (const y of [100, 101]) expect(coverageAt(tree, 14, 14, x, y)).toBe(FULL);
    }
    expect(coverageAt(tree, 14, 14, 49, 100)).toBe(EMPTY);
    expect(coverageAt(tree, 14, 14, 54, 100)).toBe(EMPTY);
    expect(coverageAt(tree, 14, 14, 50, 102)).toBe(EMPTY);
    // Roads: alpha only (x 100–103 → z14 x 50–51).
    const roads = decodeCoverageTree(body.roads);
    expect(coverageAt(roads, 14, 14, 51, 100)).toBe(FULL);
    expect(coverageAt(roads, 14, 14, 52, 100)).toBe(EMPTY);
  });
});

describe('/map/city/data — the archives and receipts, for the ODbL', () => {
  test('serves an archive the manifest names, whole and by range', async () => {
    const { objects, alpha } = fixture();
    const e = env(objects);
    const whole = await get(`/map/city/data/${alpha.city.key}`, e);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('application/vnd.pmtiles');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(ALPHA.city);

    const part = await get(`/map/city/data/${alpha.city.key}`, e, {
      headers: { range: 'bytes=0-6' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-6/${ALPHA.city.length}`);
    expect(await part.text()).toBe('PMTiles');
  });

  test('serves the receipt as JSON', async () => {
    const { objects, alpha } = fixture();
    const response = await get(`/map/city/data/${alpha.city.receipt}`, env(objects));
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ receipt: 'alpha' });
  });

  test('serves nothing else from the bucket', async () => {
    const { objects } = fixture();
    const e = env(objects);
    for (const path of [
      '/map/city/data/planet/20260921.pmtiles',
      `/map/city/data/city/${STAMP}/test/gamma.pmtiles`,
      '/map/city/data/city/manifest.json',
      `/map/city/data/city/${STAMP}/../planet.pmtiles`,
    ]) {
      expect({ path, status: (await get(path, e)).status }).toEqual({ path, status: 404 });
    }
    expect(e.MAP_TILES.reads.filter((key) => key !== MANIFEST_KEY)).toEqual([]);
  });

  test('/map/city/manifest.json is the manifest as published', async () => {
    const { objects, manifest } = fixture();
    const response = await get('/map/city/manifest.json', env(objects));
    expect(await response.json()).toEqual(manifest);
  });
});

describe('the entry module', () => {
  test('routes /map/city and /map/city-roads to the city handler', async () => {
    const e = env(fixture().objects);
    for (const [path, status] of [
      [tile(100, 200), 200],
      [tile(100, 200, 'city-roads'), 200],
      ['/map/city/coverage.json', 200],
    ]) {
      const request = new Request(`https://goway.to${path}`);
      const response = await workerModule.default.fetch(request, e, ctx);
      expect({ path, status: response.status }).toEqual({ path, status });
    }
  });
});
