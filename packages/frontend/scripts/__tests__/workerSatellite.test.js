/**
 * Satellite imagery at the edge (`map-service/src/satellite.js`): which set's archive
 * answers a tile, the fall-through to the next set where the first has no
 * tile, and what the client is told.
 *
 * Built from the real pieces: archives by the compiler's PMTiles writer,
 * the manifest by `build-satellite-manifest.ts` (`mergeEntries`,
 * `mergeManifest`), coverage trees by `scripts/imagery/cells.ts`.
 *
 * Two detail sets over the same z13 cell, the finer listed first (catalogue
 * order): `icgc-ortofoto-2025` has tile 14/8288/6116 only; a second stamp of
 * the same set rebuilt one cell; and the base `worldcover-2021` has z8 cell
 * 128/94.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { IMAGERY_TIERS } from '../../lib/map/imagery';
import { mergeEntries, mergeManifest } from '../build-satellite-manifest';
import { writePmtiles } from '../citygen/pmtilesWriter';
import { COMPRESSION, TILE_TYPE } from '@goway/map-service/pmtiles.js';
import {
  candidatesFor,
  forgetSatelliteManifest,
  parseSatelliteManifest,
  satelliteTiers,
  serveSatellite,
} from '@goway/map-service/satellite.js';

const MANIFEST_KEY = 'satellite/manifest.json';
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

function entry(id, stamp, cellKeys, extra = {}) {
  const base = {
    'icgc-ortofoto-2025': {
      name: 'ICGC',
      tiers: ['detail'],
      minZoom: 13,
      maxZoom: 18,
      cellZoom: 13,
      sources: ['icgc-ortofoto'],
      vintage: '2025',
      format: 'webp',
    },
    'worldcover-2021': {
      name: 'WorldCover',
      tiers: ['base'],
      minZoom: 8,
      maxZoom: 13,
      cellZoom: 8,
      sources: ['esa-worldcover-2021'],
      vintage: '2021',
      format: 'webp',
    },
  }[id];
  return {
    id,
    stamp,
    ...base,
    bbox: [0, 40, 4, 43],
    cellKeys,
    tiles: 1,
    bytes: 1,
    builtAt: '2026-10-13T00:00:00.000Z',
    ...extra,
  };
}

const OLD = '20261012-a';
const NEW = '20261013-b';

function fixture() {
  const { manifest: first } = mergeManifest(
    null,
    mergeEntries([
      entry('icgc-ortofoto-2025', OLD, ['13/4144/3058', '13/4145/3058']),
      entry('worldcover-2021', OLD, ['8/129/95']),
    ]),
    '2026-10-12T00:00:00.000Z',
  );
  // A rebuild of one ICGC cell under a new stamp.
  const { manifest, retired } = mergeManifest(
    first,
    mergeEntries([entry('icgc-ortofoto-2025', NEW, ['13/4145/3058'])]),
    '2026-10-13T00:00:00.000Z',
  );
  const objects = new Map([
    [MANIFEST_KEY, encoder.encode(JSON.stringify(manifest))],
    [
      `satellite/icgc-ortofoto-2025/${OLD}/13/4144/3058.pmtiles`,
      archive([
        [14, 8288, 6116, 'icgc old 14/8288/6116'],
        [13, 4144, 3058, 'icgc old 13/4144/3058'],
      ]),
    ],
    [
      `satellite/icgc-ortofoto-2025/${OLD}/13/4144/3058.pmtiles.receipt.json`,
      encoder.encode('{"receipt":"old"}'),
    ],
    [
      `satellite/icgc-ortofoto-2025/${NEW}/13/4145/3058.pmtiles`,
      archive([[14, 8290, 6116, 'icgc new 14/8290/6116']]),
    ],
    [
      `satellite/worldcover-2021/${OLD}/8/129/95.pmtiles`,
      archive([[13, 4144, 3058, 'worldcover 13/4144/3058']]),
    ],
    ['planet/20260921.pmtiles', encoder.encode('the basemap')],
  ]);
  return { manifest, retired, objects };
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
beforeEach(() => {
  globalThis.caches = cacheStore();
  forgetSatelliteManifest();
});
afterEach(() => {
  globalThis.caches = realCaches;
});

async function get(path, env, method = 'GET') {
  const url = new URL(`https://goway.to${path}`);
  return serveSatellite(url, new Request(url, { method }), env, ctx);
}

describe('the tiers', () => {
  test('are the client’s (lib/map/imagery.ts)', () => {
    const fromLib = Object.fromEntries(
      Object.entries(IMAGERY_TIERS).map(([id, t]) => [
        id,
        { minZoom: t.minZoom, maxZoom: t.maxZoom },
      ]),
    );
    expect(satelliteTiers()).toEqual(fromLib);
  });
});

describe('the manifest', () => {
  test('a rebuilt cell moves to the new stamp, listed first, and the old one is retired', () => {
    const { manifest, retired } = fixture();
    const icgc = manifest.sets.filter((set) => set.id === 'icgc-ortofoto-2025');
    expect(icgc.map((set) => [set.stamp, set.cellCount])).toEqual([
      [NEW, 1],
      [OLD, 1],
    ]);
    expect(retired).toEqual([
      `satellite/icgc-ortofoto-2025/${OLD}/13/4145/3058.pmtiles`,
      `satellite/icgc-ortofoto-2025/${OLD}/13/4145/3058.pmtiles.receipt.json`,
    ]);
    // Catalogue order: the orthophoto before the base mosaic.
    expect(manifest.sets.map((set) => set.id)).toEqual([
      'icgc-ortofoto-2025',
      'icgc-ortofoto-2025',
      'worldcover-2021',
    ]);
  });

  test('the parser refuses what the builder would never write', () => {
    const { manifest } = fixture();
    const broken = (patch) =>
      expect(() =>
        parseSatelliteManifest({ ...manifest, sets: [{ ...manifest.sets[0], ...patch }] }),
      ).toThrow();
    broken({ tiers: ['street'] });
    broken({ cellZoom: 14 });
    broken({ stamp: 'yesterday' });
    broken({ cells: { maxZoom: 12, bits: manifest.sets[0].cells.bits } });
    broken({ minZoom: 19, maxZoom: 20 });
    expect(() => parseSatelliteManifest({ schema: 2, sets: [] })).toThrow();
  });

  test('candidates are the sets whose published cell holds the tile, in order', () => {
    const { manifest } = fixture();
    const parsed = parseSatelliteManifest(JSON.parse(JSON.stringify(manifest)));
    expect(candidatesFor(parsed, 'detail', 14, 8290, 6116).map((c) => c.key)).toEqual([
      `satellite/icgc-ortofoto-2025/${NEW}/13/4145/3058.pmtiles`,
    ]);
    expect(candidatesFor(parsed, 'base', 13, 4144, 3058).map((c) => c.key)).toEqual([
      `satellite/worldcover-2021/${OLD}/8/129/95.pmtiles`,
    ]);
    // Not in any published cell.
    expect(candidatesFor(parsed, 'detail', 14, 8300, 6116)).toEqual([]);
  });
});

describe('tiles', () => {
  test('the set that has the tile answers, with the stored WebP bytes', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    const old = await get('/map/satellite/detail/14/8288/6116.webp', env);
    expect(old.status).toBe(200);
    expect(old.headers.get('content-type')).toBe('image/webp');
    expect(old.headers.get('access-control-allow-origin')).toBe('*');
    expect(await old.text()).toBe('icgc old 14/8288/6116');
    const rebuilt = await get('/map/satellite/detail/14/8290/6116.webp', env);
    expect(await rebuilt.text()).toBe('icgc new 14/8290/6116');
    const base = await get('/map/satellite/base/13/4144/3058.webp', env);
    expect(await base.text()).toBe('worldcover 13/4144/3058');
  });

  test('a tile no set has is 404, so the tier below shows through', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    // In a published cell, absent from its archive (outside the flight).
    expect((await get('/map/satellite/detail/14/8289/6117.webp', env)).status).toBe(404);
    // No published cell: decided from the manifest, no archive read.
    const reads = env.MAP_TILES.reads.length;
    expect((await get('/map/satellite/detail/16/1/1.webp', env)).status).toBe(404);
    expect(env.MAP_TILES.reads.length).toBe(reads);
  });

  test('a cached answer is not read again', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    await get('/map/satellite/detail/14/8288/6116.webp', env);
    const reads = env.MAP_TILES.reads.length;
    const again = await get('/map/satellite/detail/14/8288/6116.webp', env);
    expect(await again.text()).toBe('icgc old 14/8288/6116');
    expect(env.MAP_TILES.reads.length).toBe(reads);
  });

  test('outside a tier or the world: 404 before storage is touched', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    expect((await get('/map/satellite/detail/11/0/0.webp', env)).status).toBe(404);
    expect((await get('/map/satellite/base/14/0/0.webp', env)).status).toBe(404);
    expect((await get('/map/satellite/fine/21/0/0.webp', env)).status).toBe(404);
    expect((await get('/map/satellite/base/2/4/0.webp', env)).status).toBe(404);
    expect((await get('/map/satellite/street/2/0/0.webp', env)).status).toBe(404);
    expect(env.MAP_TILES.reads).toEqual([]);
  });

  test('HEAD answers the status without a body', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    const head = await get('/map/satellite/detail/14/8288/6116.webp', env, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});

describe('off until configured', () => {
  test('every tile 404, no sets, no storage', async () => {
    const env = { MAP_TILES: bucket(new Map()) };
    expect((await get('/map/satellite/detail/14/8288/6116.webp', env)).status).toBe(404);
    const coverage = await get('/map/satellite/coverage.json', env);
    expect(await coverage.json()).toEqual({ schema: 1, sets: [] });
    expect((await get('/map/satellite/manifest.json', env)).status).toBe(404);
    expect(env.MAP_TILES.reads).toEqual([]);
  });
});

describe('the documents', () => {
  test('coverage.json: sets, sources and cells, nothing about storage', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    const body = await (await get('/map/satellite/coverage.json', env)).json();
    expect(body.sets.map((set) => [set.id, set.tiers, set.sources])).toEqual([
      ['icgc-ortofoto-2025', ['detail'], ['icgc-ortofoto']],
      ['icgc-ortofoto-2025', ['detail'], ['icgc-ortofoto']],
      ['worldcover-2021', ['base'], ['esa-worldcover-2021']],
    ]);
    expect(JSON.stringify(body)).not.toContain('.pmtiles');
  });

  test('a receipt the manifest publishes is served; anything else is not', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    const ok = await get(
      `/map/satellite/data/satellite/icgc-ortofoto-2025/${OLD}/13/4144/3058.pmtiles.receipt.json`,
      env,
    );
    expect(await ok.json()).toEqual({ receipt: 'old' });
    // The retired cell's receipt is no longer the current manifest's.
    expect(
      (
        await get(
          `/map/satellite/data/satellite/icgc-ortofoto-2025/${OLD}/13/4145/3058.pmtiles.receipt.json`,
          env,
        )
      ).status,
    ).toBe(404);
    // Archives and the rest of the bucket are not offered here.
    expect(
      (
        await get(
          `/map/satellite/data/satellite/icgc-ortofoto-2025/${OLD}/13/4144/3058.pmtiles`,
          env,
        )
      ).status,
    ).toBe(404);
    expect((await get('/map/satellite/data/planet/20260921.pmtiles', env)).status).toBe(404);
  });
});
