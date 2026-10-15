/**
 * Tiles out of archives (`worker/tiles.js`): compressed on the wire as the
 * archive stores them, and one storage read per tile.
 *
 * Archives are written by the compiler's own PMTiles writer, gzipping tiles
 * as the real builds do; a small root budget forces leaf directories, so the
 * directory accounting covers the archives' real shape (header + root + leaf).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { rectOwnership } from '../../scripts/citygen/ownership';
import { encodeDirectory, writePmtiles } from '../../scripts/citygen/pmtilesWriter';
import { MEMORY_BUDGET } from '../budget.js';
import { manifestBytes } from '../city.js';
import { compactCoverageTree, encodeCoverageTree } from '../coverageTree.js';
import { serveTerrain, serveTile } from '../index.js';
import {
  COMPRESSION,
  DirectoryMemo,
  decodeDirectory,
  decodeDirectoryCompact,
  findEntry,
  findEntryCompact,
  TILE_TYPE,
} from '../pmtiles.js';
import { acceptsGzip, forgetDirectories, fromTileCacheEntry, tileCacheEntry } from '../tiles.js';

const encoder = new TextEncoder();

/** A z14 archive of `count` tiles in a row, each body naming itself; gzip or not. */
function archive({ count = 400, gzip = true, rootBudgetBytes } = {}) {
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const body = encoder.encode(`tile 14/${8000 + i}/6000 ${'x'.repeat(2000)}`);
    tiles.push({ z: 14, x: 8000 + i, y: 6000, bytes: gzip ? Bun.gzipSync(body) : body });
  }
  return writePmtiles(tiles, {
    minZoom: 14,
    maxZoom: 14,
    bounds: [-180, -85, 180, 85],
    center: [0, 0, 14],
    metadata: {},
    tileType: gzip ? TILE_TYPE.MVT : TILE_TYPE.WEBP,
    tileCompression: gzip ? COMPRESSION.GZIP : COMPRESSION.NONE,
    rootBudgetBytes,
  });
}

function bucketOver(bytes) {
  const reads = [];
  return {
    reads,
    async get(key, options) {
      const { offset, length } = options.range;
      reads.push({ key, offset, length });
      const slice = bytes.subarray(offset, Math.min(bytes.length, offset + length));
      return { arrayBuffer: async () => slice.slice().buffer };
    },
  };
}

function cacheStore() {
  const store = new Map();
  let lookups = 0;
  return {
    store,
    get lookups() {
      return lookups;
    },
    default: {
      async match(request) {
        lookups += 1;
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
  forgetDirectories();
});
afterEach(() => {
  globalThis.caches = realCaches;
});

const GZIP = { 'accept-encoding': 'gzip, deflate, br, zstd' };

function get(path, headers = {}, method = 'GET') {
  const request = new Request(`https://goway.to${path}`, { headers, method });
  return { request, url: new URL(request.url) };
}

async function tile(env, x, headers = GZIP, method = 'GET') {
  const { request, url } = get(`/map/tiles/14/${x}/6000.pbf`, headers, method);
  return serveTile(url, request, env, ctx);
}

const original = (x) => `tile 14/${x}/6000 ${'x'.repeat(2000)}`;

describe('compressed on the wire', () => {
  test('a client that takes gzip gets the stored bytes, declared, and they inflate to the tile', async () => {
    const bytes = archive();
    const env = { MAP_TILES: bucketOver(bytes), MAP_TILE_ARCHIVE: 'planet/test.pmtiles' };
    const response = await tile(env, 8003);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toContain('accept-encoding');
    expect(response.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile');
    const body = new Uint8Array(await response.arrayBuffer());
    expect([body[0], body[1]]).toEqual([0x1f, 0x8b]);
    expect(Number(response.headers.get('content-length'))).toBe(body.length);
    expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(original(8003));
    // The win the client gets: the gzip is a fraction of the tile.
    expect(body.length).toBeLessThan(original(8003).length / 4);
  });

  test('a client that does not take gzip gets the tile decoded, and nothing declared', async () => {
    const env = { MAP_TILES: bucketOver(archive()), MAP_TILE_ARCHIVE: 'planet/test.pmtiles' };
    for (const headers of [
      {},
      { 'accept-encoding': 'identity' },
      { 'accept-encoding': 'gzip;q=0, br' },
    ]) {
      const response = await tile(env, 8004, headers);
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('vary')).toContain('accept-encoding');
      expect(await response.text()).toBe(original(8004));
    }
  });

  test('the cached answer is rebuilt per request: the second client, either kind, gets its own', async () => {
    const env = { MAP_TILES: bucketOver(archive()), MAP_TILE_ARCHIVE: 'planet/test.pmtiles' };
    await tile(env, 8005); // fills the cache
    const reads = env.MAP_TILES.reads.length;
    const gz = await tile(env, 8005);
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(
      original(8005),
    );
    const plain = await tile(env, 8005, {});
    expect(await plain.text()).toBe(original(8005));
    expect(env.MAP_TILES.reads.length).toBe(reads);
    // The cache holds the stored bytes opaquely, never an encoded response.
    const [entry] = [...caches.store.entries()]
      .filter(([url]) => url.includes('/tiles/v2/'))
      .map(([, response]) => response);
    expect(entry.headers.get('content-encoding')).toBeNull();
    expect(entry.headers.get('x-goway-tile-compression')).toBe(String(COMPRESSION.GZIP));
  });

  test('HEAD says what GET would send, with no body', async () => {
    const env = { MAP_TILES: bucketOver(archive()), MAP_TILE_ARCHIVE: 'planet/test.pmtiles' };
    const full = await tile(env, 8006);
    const gzLength = full.headers.get('content-length');
    const head = await tile(env, 8006, GZIP, 'HEAD');
    expect(head.headers.get('content-encoding')).toBe('gzip');
    expect(head.headers.get('content-length')).toBe(gzLength);
    expect(await head.text()).toBe('');
  });

  test('an elevation tile (stored uncompressed WebP) passes as it is', async () => {
    const env = {
      MAP_TILES: bucketOver(archive({ gzip: false })),
      MAP_TERRAIN_ARCHIVE: 'terrain/test.pmtiles',
    };
    // The fixture's x range is z14; terrain stops at z12, so use z12 ids.
    const bytes = writePmtiles(
      [{ z: 12, x: 2069, y: 1525, bytes: encoder.encode('RIFF....WEBP') }],
      {
        minZoom: 12,
        maxZoom: 12,
        bounds: [-180, -85, 180, 85],
        center: [0, 0, 12],
        metadata: {},
        tileType: TILE_TYPE.WEBP,
        tileCompression: COMPRESSION.NONE,
      },
    );
    env.MAP_TILES = bucketOver(bytes);
    const { request, url } = get('/map/terrain/12/2069/1525.webp', GZIP);
    const response = await serveTerrain(url, request, env, ctx);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe('RIFF....WEBP');
  });

  test('Accept-Encoding is read as a list with weights', () => {
    const r = (value) =>
      new Request('https://x', { headers: value ? { 'accept-encoding': value } : {} });
    expect(acceptsGzip(r('gzip'))).toBe(true);
    expect(acceptsGzip(r('br, GZIP;q=0.5'))).toBe(true);
    expect(acceptsGzip(r('*'))).toBe(true);
    expect(acceptsGzip(r('gzip;q=0'))).toBe(false);
    expect(acceptsGzip(r('br'))).toBe(false);
    expect(acceptsGzip(r(''))).toBe(false);
    // An explicit gzip weight beats the wildcard (finding 6 of the review).
    expect(acceptsGzip(r('*, gzip;q=0'))).toBe(false);
    expect(acceptsGzip(r('*;q=0, gzip'))).toBe(true);
    expect(acceptsGzip(r('x-gzip'))).toBe(true);
  });

  test("Cloudflare's rewritten Accept-Encoding is ignored for the client's own", () => {
    // In production the Worker's request says `br, gzip` whatever the client
    // sent; `cf.clientAcceptEncoding` is what it sent ('' for nothing).
    const seen = (client) => ({
      headers: new Headers({ 'accept-encoding': 'br, gzip' }),
      cf: { clientAcceptEncoding: client },
    });
    expect(acceptsGzip(seen('gzip, deflate, br'))).toBe(true);
    expect(acceptsGzip(seen(''))).toBe(false);
    expect(acceptsGzip(seen('identity'))).toBe(false);
    expect(acceptsGzip(seen('br'))).toBe(false);
  });

  test('a cache entry round-trips the stored bytes and the miss status', async () => {
    const stored = { bytes: Bun.gzipSync(encoder.encode('t')), compression: COMPRESSION.GZIP };
    const back = await fromTileCacheEntry(tileCacheEntry(stored, 60, 204));
    expect(back.status).toBe(200);
    expect(back.tile.compression).toBe(COMPRESSION.GZIP);
    expect(back.tile.bytes).toEqual(stored.bytes);
    expect(await fromTileCacheEntry(tileCacheEntry(null, 60, 204))).toEqual({
      tile: null,
      status: 204,
    });
  });
});

describe('one storage read per tile', () => {
  // A small root budget makes the writer spill into leaf directories: the
  // shape of the real planet and regional archives.
  const leafy = () => archive({ count: 2000, rootBudgetBytes: 64 });

  test('the archive has leaves, so a cold read is header + leaf + tile', async () => {
    const env = { MAP_TILES: bucketOver(leafy()), MAP_TILE_ARCHIVE: 'planet/leafy.pmtiles' };
    const response = await tile(env, 8100);
    expect(response.status).toBe(200);
    // Cold isolate, cold colo: the header (with the root), one leaf, the tile.
    expect(env.MAP_TILES.reads).toHaveLength(3);
    expect(response.headers.get('server-timing')).toContain('r2;desc="3 reads"');
  });

  test('a warm isolate reads only the tile, and asks the edge cache nothing about directories', async () => {
    const env = { MAP_TILES: bucketOver(leafy()), MAP_TILE_ARCHIVE: 'planet/leafy.pmtiles' };
    await tile(env, 8100);
    const before = env.MAP_TILES.reads.length;
    const lookups = caches.lookups;
    const response = await tile(env, 8101); // same leaf, another tile
    expect(env.MAP_TILES.reads.length - before).toBe(1);
    // One lookup: the tile's own cache entry. None for the header or the leaf.
    expect(caches.lookups - lookups).toBe(1);
    expect(response.headers.get('server-timing')).toContain('r2;desc="1 reads"');
    expect(
      new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()))),
    ).toBe(original(8101));
  });

  test('a cold isolate in a warm colo reads only the tile from R2 (directories from the edge cache)', async () => {
    const env = { MAP_TILES: bucketOver(leafy()), MAP_TILE_ARCHIVE: 'planet/leafy.pmtiles' };
    await tile(env, 8100);
    forgetDirectories(); // a new isolate; the colo's cache is warm
    const before = env.MAP_TILES.reads.length;
    await tile(env, 8102);
    expect(env.MAP_TILES.reads.length - before).toBe(1);
  });

  test('a tile the colo has served costs no storage read at all', async () => {
    const env = { MAP_TILES: bucketOver(leafy()), MAP_TILE_ARCHIVE: 'planet/leafy.pmtiles' };
    await tile(env, 8103);
    const before = env.MAP_TILES.reads.length;
    const response = await tile(env, 8103);
    expect(env.MAP_TILES.reads.length).toBe(before);
    expect(response.headers.get('server-timing')).toContain('hit;dur=');
  });

  test('the memo is per archive: another archive key reads its own directories', async () => {
    const bytes = leafy();
    const one = { MAP_TILES: bucketOver(bytes), MAP_TILE_ARCHIVE: 'planet/one.pmtiles' };
    const two = { MAP_TILES: bucketOver(bytes), MAP_TILE_ARCHIVE: 'planet/two.pmtiles' };
    await tile(one, 8100);
    await tile(two, 8100);
    expect(two.MAP_TILES.reads).toHaveLength(3);
  });
});

describe('the memory budget', () => {
  // Measured 2026-10-12 in R2: the planet basemap's leaves hold 17,685
  // entries each (2,917 of them), the city archives' 4,096.
  const PLANET_LEAF = 17685;

  function leafBytes(count, firstTileId = 0) {
    const entries = [];
    for (let i = 0; i < count; i++) {
      entries.push({
        tileId: firstTileId + i * 3,
        runLength: 1,
        length: 900 + (i % 400),
        offset: i * 2000,
      });
    }
    return encodeDirectory(entries);
  }

  test('a compact planet leaf is 24 bytes an entry, and that is what it counts', () => {
    const leaf = decodeDirectoryCompact(leafBytes(PLANET_LEAF));
    expect(leaf.count).toBe(PLANET_LEAF);
    const actual =
      leaf.tileIds.byteLength +
      leaf.runLengths.byteLength +
      leaf.lengths.byteLength +
      leaf.offsets.byteLength;
    expect(leaf.bytes).toBe(actual);
    expect(leaf.bytes).toBe(PLANET_LEAF * 24);
    // The same lookups as the object form.
    const objects = decodeDirectory(leafBytes(PLANET_LEAF));
    for (const tileId of [0, 1, 3, 5000, 53052, 53055, 99999]) {
      const index = findEntryCompact(leaf, tileId);
      const entry = findEntry(objects, tileId);
      expect(index < 0 ? null : leaf.offsets[index]).toBe(entry ? entry.offset : null);
    }
  });

  test('filled with a hundred planet leaves, the directory memo stays inside its bytes', () => {
    const memo = new DirectoryMemo(MEMORY_BUDGET.directories);
    for (let i = 0; i < 100; i++) {
      const leaf = decodeDirectoryCompact(leafBytes(PLANET_LEAF, i * 100000));
      memo.set(`planet|leaf@${i}`, leaf, leaf.bytes);
      expect(memo.bytes).toBeLessThanOrEqual(MEMORY_BUDGET.directories);
    }
    // ~28 planet leaves fit; the most recent ones are the ones kept.
    expect(memo.size).toBe(Math.floor(MEMORY_BUDGET.directories / (PLANET_LEAF * 24)));
    expect(memo.get('planet|leaf@99')).toBeDefined();
    expect(memo.get('planet|leaf@0')).toBeUndefined();
    // A value larger than the whole budget is not kept, and evicts nothing.
    const before = memo.size;
    memo.set('huge', {}, MEMORY_BUDGET.directories + 1);
    expect(memo.get('huge')).toBeUndefined();
    expect(memo.size).toBe(before);
  });

  test('the ownership trees and the manifest fit their lines, and the lines fit the total', () => {
    expect(
      MEMORY_BUDGET.directories +
        MEMORY_BUDGET.ownershipTrees +
        MEMORY_BUDGET.manifest +
        MEMORY_BUDGET.contours +
        MEMORY_BUDGET.satellite,
    ).toBeLessThanOrEqual(MEMORY_BUDGET.total);
    // A compact tree counts 5 bytes a node, and that is its arrays.
    const tree = compactCoverageTree(
      encodeCoverageTree(rectOwnership({ zoom: 15, x0: 1000, y0: 2000, x1: 1777, y1: 2333 }), 15),
    );
    expect(tree.bytes).toBe(tree.codes.byteLength + tree.skip.byteLength);
    // The planet's manifest: 430 entries with ~3.7 kB of ownership each.
    const manifest = {
      coverageBody: 'x'.repeat(320_000),
      regions: Array.from({ length: 450 }, (_, i) => ({
        id: `continent/country-${i}`,
        ownership: { bits: 'A'.repeat(3700) },
        city: { key: `city/20261012-r8/continent/country-${i}.pmtiles` },
        roads: { key: `city-roads/20261012-r8/continent/country-${i}.pmtiles` },
      })),
    };
    expect(manifestBytes(manifest)).toBeLessThanOrEqual(MEMORY_BUDGET.manifest);
  });
});
