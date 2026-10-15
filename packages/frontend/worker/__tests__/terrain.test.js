/**
 * GoWay's own terrain at the edge (`worker/terrain.js`, through `index.js` →
 * `serveTerrain`): a published set answers its tiles, every other tile is the
 * fallback's (Mapterhorn) exactly as before, and nothing reads storage for
 * sets until a manifest is configured.
 *
 * Built from the real pieces: archives by the compiler's PMTiles writer, the
 * manifest by `build-satellite-manifest.ts` with the terrain family.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  MANIFEST_FAMILIES,
  mergeEntries,
  mergeManifest,
} from '../../scripts/build-satellite-manifest';
import { writePmtiles } from '../../scripts/citygen/pmtilesWriter';
import worker from '../index.js';
import { COMPRESSION, TILE_TYPE } from '../pmtiles.js';
import { forgetTerrainManifest, parseTerrainManifest, terrainCandidatesFor } from '../terrain.js';

const MANIFEST_KEY = 'terrain/manifest.json';
const STAMP = '20261015-proof';
const UPSTREAM = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const encoder = new TextEncoder();

function archive(tiles) {
  return writePmtiles(
    tiles.map(([z, x, y, body]) => ({ z, x, y, bytes: encoder.encode(body) })),
    {
      minZoom: Math.min(...tiles.map((t) => t[0])),
      maxZoom: Math.max(...tiles.map((t) => t[0])),
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 0],
      metadata: {},
      tileType: TILE_TYPE.WEBP,
      tileCompression: COMPRESSION.NONE,
    },
  );
}

/** Catalonia's z7 cell 64/47 published by ICGC's set: two of its tiles in the archive. */
function fixture() {
  const { manifest } = mergeManifest(
    null,
    mergeEntries([
      {
        id: 'icgc-met-2021',
        stamp: STAMP,
        name: 'ICGC',
        tiers: ['terrain'],
        minZoom: 7,
        maxZoom: 12,
        cellZoom: 7,
        sources: ['icgc-met'],
        vintage: '2021–2023',
        format: 'webp',
        bbox: [0.15, 40.52, 3.33, 42.87],
        cellKeys: ['7/64/47'],
        tiles: 2,
        bytes: 2,
        builtAt: '2026-10-15T00:00:00.000Z',
      },
    ]),
    '2026-10-15T00:00:00.000Z',
    MANIFEST_FAMILIES.terrain,
  );
  const objects = new Map([
    [MANIFEST_KEY, encoder.encode(JSON.stringify(manifest))],
    [
      `terrain/icgc-met-2021/${STAMP}/7/64/47.pmtiles`,
      archive([
        [12, 2072, 1529, 'icgc 12/2072/1529'],
        [7, 64, 47, 'icgc 7/64/47'],
      ]),
    ],
    [
      `terrain/icgc-met-2021/${STAMP}/7/64/47.pmtiles.receipt.json`,
      encoder.encode('{"receipt":1}'),
    ],
  ]);
  return { manifest, objects };
}

function bucket(objects) {
  const reads = [];
  const object = (bytes) => ({
    size: bytes.length,
    httpEtag: '"e"',
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
      const range = options.range;
      if (!range) return object(bytes);
      return object(
        bytes.subarray(range.offset, Math.min(bytes.length, range.offset + range.length)),
      );
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
const realFetch = globalThis.fetch;
let fetched = [];
beforeEach(() => {
  globalThis.caches = cacheStore();
  forgetTerrainManifest();
  fetched = [];
  globalThis.fetch = mock(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    fetched.push(url);
    return new Response(`mapterhorn ${url.split('.com/')[1]}`, {
      headers: { 'content-type': 'image/webp' },
    });
  });
});
afterEach(() => {
  globalThis.caches = realCaches;
  globalThis.fetch = realFetch;
});

const get = (path, env, method = 'GET') =>
  worker.fetch(new Request(`https://goway.to${path}`, { method }), env, ctx);

describe('the sets in front of the fallback', () => {
  test('a published tile is the set’s; every other tile is the fallback’s, as before', async () => {
    const { objects } = fixture();
    const env = {
      MAP_TILES: bucket(objects),
      MAP_TERRAIN_MANIFEST: MANIFEST_KEY,
      MAP_TERRAIN_UPSTREAM: UPSTREAM,
    };
    const own = await get('/map/terrain/12/2072/1529.webp', env);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('image/webp');
    expect(await own.text()).toBe('icgc 12/2072/1529');
    expect(fetched).toEqual([]);
    // In the published cell, absent from its archive: the fallback's.
    const beside = await get('/map/terrain/12/2073/1529.webp', env);
    expect(await beside.text()).toBe('mapterhorn 12/2073/1529.webp');
    // Outside every published cell: decided from the manifest, no archive read.
    const reads = env.MAP_TILES.reads.length;
    const far = await get('/map/terrain/12/100/100.webp', env);
    expect(await far.text()).toBe('mapterhorn 12/100/100.webp');
    expect(env.MAP_TILES.reads.length).toBe(reads);
    // Below the set's zooms: the fallback's.
    expect(await (await get('/map/terrain/6/32/23.webp', env)).text()).toBe(
      'mapterhorn 6/32/23.webp',
    );
  });

  test('off until configured: no set, no storage, every tile the fallback’s', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_TERRAIN_UPSTREAM: UPSTREAM };
    expect(await (await get('/map/terrain/12/2072/1529.webp', env)).text()).toBe(
      'mapterhorn 12/2072/1529.webp',
    );
    expect(await (await get('/map/terrain/coverage.json', env)).json()).toEqual({
      schema: 1,
      sets: [],
    });
    expect(env.MAP_TILES.reads).toEqual([]);
  });

  test('a manifest that cannot be read is a 502, never the fallback in disguise', async () => {
    const env = {
      MAP_TILES: bucket(new Map()),
      MAP_TERRAIN_MANIFEST: MANIFEST_KEY,
      MAP_TERRAIN_UPSTREAM: UPSTREAM,
    };
    expect((await get('/map/terrain/12/2072/1529.webp', env)).status).toBe(502);
  });
});

describe('the documents', () => {
  test('coverage.json names the sets and sources; a published receipt is served, the archive is not', async () => {
    const { objects } = fixture();
    const env = {
      MAP_TILES: bucket(objects),
      MAP_TERRAIN_MANIFEST: MANIFEST_KEY,
      MAP_TERRAIN_UPSTREAM: UPSTREAM,
    };
    const coverage = await (await get('/map/terrain/coverage.json', env)).json();
    expect(coverage.sets.map((set) => [set.id, set.tiers, set.sources])).toEqual([
      ['icgc-met-2021', ['terrain'], ['icgc-met']],
    ]);
    expect(JSON.stringify(coverage)).not.toContain('.pmtiles');
    const receipt = await get(
      `/map/terrain/data/terrain/icgc-met-2021/${STAMP}/7/64/47.pmtiles.receipt.json`,
      env,
    );
    expect(await receipt.json()).toEqual({ receipt: 1 });
    expect(
      (await get(`/map/terrain/data/terrain/icgc-met-2021/${STAMP}/7/64/47.pmtiles`, env)).status,
    ).toBe(404);
  });

  test('the parser takes only the terrain tier', () => {
    const { manifest } = fixture();
    const parsed = parseTerrainManifest(manifest);
    expect(terrainCandidatesFor(parsed, 12, 2072, 1529).map((c) => c.key)).toEqual([
      `terrain/icgc-met-2021/${STAMP}/7/64/47.pmtiles`,
    ]);
    const wrong = JSON.parse(JSON.stringify(manifest));
    wrong.sets[0].tiers = ['detail'];
    expect(() => parseTerrainManifest(wrong)).toThrow();
  });
});
