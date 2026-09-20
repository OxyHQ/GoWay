/**
 * The PMTiles reader and the R2 tile path, exercised without a Workers runtime.
 *
 * ## Why this file builds its own archives
 *
 * Because the alternative is testing against a 186 MB artefact that cannot be
 * committed, and a test that skips itself when a file is absent is a test that
 * is green in CI for the wrong reason. The writer below is forty lines, and
 * having one means every case this file cares about — a leaf directory, a run
 * of identical tiles, a tile that is not there, a corrupt archive — is a
 * fixture somebody can read rather than a byte range in a binary.
 *
 * The real artefact is not untested: `map:tiles --verify` opens a finished
 * build with this same reader and asserts its layers, its zoom range and the
 * OpenStreetMap element ids in its features. That check needs a build; this
 * one needs nothing, so this one runs on every push.
 *
 * ## What this canNOT prove
 *
 * That Cloudflare passes a manually-set `content-encoding: gzip` through
 * without re-encoding the body, that `caches.default` behaves like the stub
 * here, and that an R2 `get` with a range returns what this fake returns.
 * Those are platform behaviours; they were checked once against a real
 * `wrangler dev` with a local bucket, and the result is in the pull request,
 * not in an assertion here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  COMPRESSION,
  HEADER_BYTES,
  PMTiles,
  TILE_TYPE,
  contentEncodingFor,
  decodeDirectory,
  findEntry,
  readHeader,
  zxyToTileId,
} from '../pmtiles.js';
import * as workerModule from '../index.js';
import { serveTile } from '../index.js';

/**
 * The zoom `worker/index.js` stops at, copied rather than imported.
 *
 * It cannot be imported, and the reason is the test at the bottom of this
 * file: workerd refuses to start a Worker whose entry module has a named
 * export that is not a function or an object, so `export const MAX_TILE_ZOOM =
 * 14` is an outage rather than a convenience. Fourteen is also what
 * `buildTileJson()` declares and what every archive this repository builds is
 * capped at, so a drift here is caught by `map:tiles --verify` as well.
 */
const MAX_TILE_ZOOM = 14;

// ---------------------------------------------------------------------------
// A minimal PMTiles v3 writer, for fixtures only
// ---------------------------------------------------------------------------

function varint(value) {
  const out = [];
  let remaining = value;
  while (remaining >= 0x80) {
    out.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  out.push(remaining);
  return out;
}

function encodeDirectory(entries) {
  const out = [...varint(entries.length)];
  let last = 0;
  for (const entry of entries) {
    out.push(...varint(entry.tileId - last));
    last = entry.tileId;
  }
  for (const entry of entries) out.push(...varint(entry.runLength));
  for (const entry of entries) out.push(...varint(entry.length));
  // Always explicit (`offset + 1`) rather than the contiguous-run shorthand:
  // the shorthand is exercised by `decodes the contiguous-offset shorthand`
  // below, on bytes written by hand for that purpose.
  for (const entry of entries) out.push(...varint(entry.offset + 1));
  return new Uint8Array(out);
}

/**
 * Build an archive holding the given tiles.
 *
 * `tiles` maps `"z/x/y"` to the UNCOMPRESSED body; the writer gzips each one,
 * because that is what Planetiler writes and what the header will claim.
 */
function buildArchive(tiles, { corruptHeader = false } = {}) {
  const bodies = [];
  const entries = [];
  let cursor = 0;
  const sorted = [...tiles.entries()]
    .map(([key, body]) => {
      const [z, x, y] = key.split('/').map(Number);
      return { tileId: zxyToTileId(z, x, y), body: Bun.gzipSync(body) };
    })
    .sort((a, b) => a.tileId - b.tileId);

  for (const tile of sorted) {
    entries.push({ tileId: tile.tileId, runLength: 1, length: tile.body.length, offset: cursor });
    bodies.push(tile.body);
    cursor += tile.body.length;
  }

  const root = Bun.gzipSync(encodeDirectory(entries));
  const metadata = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ name: 'fixture' })));

  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode(corruptHeader ? 'NOTPMTi' : 'PMTiles'), 0);
  header[7] = 3;
  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + root.length;
  const tileDataOffset = metadataOffset + metadata.length;
  view.setBigUint64(8, BigInt(rootOffset), true);
  view.setBigUint64(16, BigInt(root.length), true);
  view.setBigUint64(24, BigInt(metadataOffset), true);
  view.setBigUint64(32, BigInt(metadata.length), true);
  view.setBigUint64(40, BigInt(tileDataOffset), true); // no leaves; offset is unused
  view.setBigUint64(48, 0n, true);
  view.setBigUint64(56, BigInt(tileDataOffset), true);
  view.setBigUint64(64, BigInt(cursor), true);
  view.setBigUint64(72, BigInt(entries.length), true);
  view.setBigUint64(80, BigInt(entries.length), true);
  view.setBigUint64(88, BigInt(entries.length), true);
  header[96] = 1;
  header[97] = COMPRESSION.GZIP;
  header[98] = COMPRESSION.GZIP;
  header[99] = TILE_TYPE.MVT;
  header[100] = 0;
  header[101] = MAX_TILE_ZOOM;

  const total = tileDataOffset + cursor;
  const archive = new Uint8Array(total);
  archive.set(header, 0);
  archive.set(root, rootOffset);
  archive.set(metadata, metadataOffset);
  let at = tileDataOffset;
  for (const body of bodies) {
    archive.set(body, at);
    at += body.length;
  }
  return archive;
}

/** An R2 bucket over a byte array, counting the ranges it is asked for. */
function bucketOver(archive) {
  const reads = [];
  return {
    reads,
    async get(key, options) {
      const { offset, length } = options.range;
      reads.push({ key, offset, length });
      if (offset >= archive.length) return null;
      const slice = archive.subarray(offset, Math.min(archive.length, offset + length));
      return { arrayBuffer: async () => slice.slice().buffer };
    },
  };
}

/** A `caches.default` that really stores, so cache behaviour is observable. */
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
const realFetch = globalThis.fetch;

let caches;
beforeEach(() => {
  caches = cacheStore();
  globalThis.caches = caches;
});
afterEach(() => {
  globalThis.caches = realCaches;
  globalThis.fetch = realFetch;
});

const TILE_BODY = new TextEncoder().encode('not really a vector tile, but bytes are bytes');

function tileRequest(z, x, y, method = 'GET') {
  return new Request(`https://goway.to/map/tiles/${z}/${x}/${y}.pbf`, { method });
}

// ---------------------------------------------------------------------------

describe('the Hilbert tile id', () => {
  test('numbers z0 and z1 the way the spec does', () => {
    expect(zxyToTileId(0, 0, 0)).toBe(0);
    expect(zxyToTileId(1, 0, 0)).toBe(1);
    expect(zxyToTileId(1, 0, 1)).toBe(2);
    expect(zxyToTileId(1, 1, 1)).toBe(3);
    expect(zxyToTileId(1, 1, 0)).toBe(4);
  });

  test('gives every tile at a zoom a distinct id inside that zoom block', () => {
    // The property that matters: a zoom's ids are exactly the half-open range
    // [(4^z - 1)/3, (4^(z+1) - 1)/3). An off-by-one in the accumulator would
    // resolve every tile to a NEIGHBOUR's bytes, which renders a perfect map
    // of the wrong place and raises nothing.
    for (const z of [2, 5, 8]) {
      const span = 2 ** z;
      const first = (4 ** z - 1) / 3;
      const seen = new Set();
      for (let x = 0; x < span; x += 1) {
        for (let y = 0; y < span; y += 1) {
          const id = zxyToTileId(z, x, y);
          expect(id).toBeGreaterThanOrEqual(first);
          expect(id).toBeLessThan(first + span * span);
          seen.add(id);
        }
      }
      expect(seen.size).toBe(span * span);
    }
  });

  test('refuses a coordinate outside the world', () => {
    expect(() => zxyToTileId(2, 4, 0)).toThrow();
    expect(() => zxyToTileId(2, 0, -1)).toThrow();
    expect(() => zxyToTileId(40, 0, 0)).toThrow();
  });
});

describe('the header', () => {
  test('names the problem when the bytes are not an archive', () => {
    // The realistic failure: a misconfigured bucket answering with an error
    // page. This must not surface as a varint RangeError forty bytes later.
    const html = new TextEncoder().encode('<!doctype html><html><body>404</body></html>'.padEnd(200));
    expect(() => readHeader(html)).toThrow(/not a PMTiles archive/);
  });

  test('refuses a version it cannot read', () => {
    const bytes = buildArchive(new Map([['0/0/0', TILE_BODY]]));
    bytes[7] = 2;
    expect(() => readHeader(bytes)).toThrow(/v2 is not supported/);
  });

  test('round-trips what the fixture writer put in it', () => {
    const header = readHeader(buildArchive(new Map([['0/0/0', TILE_BODY]])));
    expect(header.tileType).toBe(TILE_TYPE.MVT);
    expect(header.tileCompression).toBe(COMPRESSION.GZIP);
    expect(header.maxZoom).toBe(MAX_TILE_ZOOM);
    expect(header.clustered).toBe(true);
  });
});

describe('directories', () => {
  test('decodes the contiguous-offset shorthand', () => {
    // `offset === 0` means "immediately after the previous entry", which is
    // how a clustered archive stores a run for free. Written by hand because
    // the fixture writer deliberately never emits it.
    const bytes = new Uint8Array([
      2, // two entries
      5, 1, // tile ids 5 and 6
      1, 1, // run lengths
      10, 20, // lengths
      101, 0, // offsets: 100, then "contiguous"
    ]);
    const entries = decodeDirectory(bytes);
    expect(entries).toEqual([
      { tileId: 5, runLength: 1, length: 10, offset: 100 },
      { tileId: 6, runLength: 1, length: 20, offset: 110 },
    ]);
  });

  test('finds a tile inside a run and rejects one past its end', () => {
    const entries = [{ tileId: 10, runLength: 3, length: 1, offset: 0 }];
    expect(findEntry(entries, 10)?.tileId).toBe(10);
    expect(findEntry(entries, 12)?.tileId).toBe(10);
    expect(findEntry(entries, 13)).toBeNull();
    expect(findEntry(entries, 9)).toBeNull();
  });

  test('treats a zero run length as a leaf pointer, not as a tile', () => {
    // Confusing the two serves directory bytes to MapLibre as a vector tile.
    const entries = [{ tileId: 10, runLength: 0, length: 40, offset: 0 }];
    expect(findEntry(entries, 999)?.runLength).toBe(0);
  });
});

describe('the archive reader', () => {
  test('reads a tile back out of an archive it wrote', async () => {
    const archive = buildArchive(new Map([['14/8290/6119', TILE_BODY]]));
    const bucket = bucketOver(archive);
    const source = {
      read: async (offset, length) =>
        new Uint8Array(await (await bucket.get('k', { range: { offset, length } })).arrayBuffer()),
    };
    const tile = await new PMTiles(source).getTile(14, 8290, 6119);
    expect(tile).not.toBeNull();
    expect(Bun.gunzipSync(tile.bytes)).toEqual(TILE_BODY);
    expect(contentEncodingFor(tile.compression)).toBe('gzip');
  });
});

describe('serving a tile from R2', () => {
  const env = (archive) => {
    const bucket = bucketOver(archive);
    return { env: { MAP_TILES: bucket, MAP_TILE_ARCHIVE: 'basemap/test.pmtiles' }, bucket };
  };

  test('answers with the stored bytes and declares their encoding', async () => {
    const { env: e } = env(buildArchive(new Map([['14/8290/6119', TILE_BODY]])));
    const request = tileRequest(14, 8290, 6119);
    const response = await serveTile(new URL(request.url), request, e, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    // The body is the STORED body — it is never decompressed and recompressed.
    expect(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()))).toEqual(TILE_BODY);
  });

  test('answers a tile the archive does not hold with a 404, not an error', async () => {
    // Every ocean tile takes this path. A 502 here would make the Atlantic an
    // incident, and MapLibre already treats a 404 as an empty tile.
    const { env: e } = env(buildArchive(new Map([['14/8290/6119', TILE_BODY]])));
    const request = tileRequest(14, 8291, 6119);
    const response = await serveTile(new URL(request.url), request, e, ctx);
    expect(response.status).toBe(404);
  });

  test('refuses an impossible coordinate without touching storage', async () => {
    // At scale this is a stranger generating R2 operations, which now cost
    // GoWay money rather than costing a free service bandwidth.
    const { env: e, bucket } = env(buildArchive(new Map([['0/0/0', TILE_BODY]])));
    for (const [z, x, y] of [
      [15, 0, 0],
      [2, 4, 0],
      [2, 0, 9],
    ]) {
      const request = tileRequest(z, x, y);
      const response = await serveTile(new URL(request.url), request, e, ctx);
      expect(response.status).toBe(404);
    }
    expect(bucket.reads).toHaveLength(0);
  });

  test('reads the directory once and serves later tiles from the cache', async () => {
    // This is the number that decides the R2 bill: the header and root
    // directory are read by every request, so they must be read from storage
    // once per colo and not once per tile.
    const { env: e, bucket } = env(
      buildArchive(
        new Map([
          ['14/8290/6119', TILE_BODY],
          ['14/8290/6120', TILE_BODY],
        ]),
      ),
    );
    const first = tileRequest(14, 8290, 6119);
    await serveTile(new URL(first.url), first, e, ctx);
    const headerReads = bucket.reads.filter((read) => read.offset === 0).length;
    expect(headerReads).toBe(1);

    const second = tileRequest(14, 8290, 6120);
    await serveTile(new URL(second.url), second, e, ctx);
    expect(bucket.reads.filter((read) => read.offset === 0).length).toBe(1);
  });

  test('serves a repeated tile entirely from the edge, with no read at all', async () => {
    const { env: e, bucket } = env(buildArchive(new Map([['14/8290/6119', TILE_BODY]])));
    const request = tileRequest(14, 8290, 6119);
    await serveTile(new URL(request.url), request, e, ctx);
    const before = bucket.reads.length;
    const response = await serveTile(new URL(request.url), request, e, ctx);
    expect(bucket.reads.length).toBe(before);
    expect(response.status).toBe(200);
  });

  test('keys the edge cache on the archive, so a cutover cannot serve stale tiles', async () => {
    // A rebuild goes to a NEW object key. If the cache key did not name the
    // key, the day-long tile TTL would keep serving the old planet from every
    // warm colo after the deploy that replaced it.
    const archive = buildArchive(new Map([['14/8290/6119', TILE_BODY]]));
    const one = { MAP_TILES: bucketOver(archive), MAP_TILE_ARCHIVE: 'basemap/old.pmtiles' };
    const request = tileRequest(14, 8290, 6119);
    await serveTile(new URL(request.url), request, one, ctx);
    expect([...caches.store.keys()].some((key) => key.includes('old.pmtiles'))).toBe(true);

    const two = { MAP_TILES: bucketOver(archive), MAP_TILE_ARCHIVE: 'basemap/new.pmtiles' };
    await serveTile(new URL(request.url), request, two, ctx);
    expect(two.MAP_TILES.reads.length).toBeGreaterThan(0);
  });

  test('answers HEAD for a cached miss with 404, not 200', async () => {
    // A cached response carries its own status, and `new Response(null, {
    // headers })` does not: without carrying it across, a HEAD for an ocean
    // tile would answer "this tile exists" with an empty body.
    const { env: e } = env(buildArchive(new Map([['14/8290/6119', TILE_BODY]])));
    const get = tileRequest(14, 8291, 6119);
    expect((await serveTile(new URL(get.url), get, e, ctx)).status).toBe(404);
    const head = tileRequest(14, 8291, 6119, 'HEAD');
    expect((await serveTile(new URL(head.url), head, e, ctx)).status).toBe(404);
  });

  test('answers HEAD with the headers and no body', async () => {
    const { env: e } = env(buildArchive(new Map([['14/8290/6119', TILE_BODY]])));
    const request = tileRequest(14, 8290, 6119, 'HEAD');
    const response = await serveTile(new URL(request.url), request, e, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(await response.text()).toBe('');
  });

  test('turns an unreadable archive into a 502 rather than a 500', async () => {
    const { env: e } = env(buildArchive(new Map([['0/0/0', TILE_BODY]]), { corruptHeader: true }));
    const request = tileRequest(0, 0, 0);
    const response = await serveTile(new URL(request.url), request, e, ctx);
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/not a PMTiles archive/);
  });
});

describe('what the entry module exports', () => {
  test('exports nothing workerd would refuse to start with', () => {
    // Measured, not read: adding `export const MAX_TILE_ZOOM = 14` made a real
    // `wrangler dev` fail with "Incorrect type for map entry 'MAX_TILE_ZOOM':
    // the provided value is not of type 'function or ExportedHandler'". The
    // Worker never starts, so the map is entirely down — and nothing in the
    // repository except a deploy would have said so. A regex or a plain object
    // passes because workerd sees an object; a number or a string does not.
    for (const [name, value] of Object.entries(workerModule)) {
      if (name === 'default') continue;
      const acceptable = typeof value === 'function' || (value !== null && typeof value === 'object');
      expect({ name, acceptable }).toEqual({ name, acceptable: true });
    }
  });
});

describe('the rollback path', () => {
  test('proxies the upstream when no archive is bound', async () => {
    // The state of any deployment made before the R2 bucket exists. It must
    // serve a map, not a 503.
    const asked = [];
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      asked.push(url);
      if (url.endsWith('/planet')) {
        return new Response(JSON.stringify({ tiles: ['https://up.example/{z}/{x}/{y}.pbf'] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('tile', { status: 200 });
    };
    const request = tileRequest(14, 8290, 6119);
    const response = await serveTile(
      new URL(request.url),
      request,
      { MAP_TILE_UPSTREAM: 'https://tiles.openfreemap.org/planet' },
      ctx,
    );
    expect(response.status).toBe(200);
    expect(asked).toContain('https://up.example/14/8290/6119.pbf');
  });

  test('says so plainly when neither backend is configured', async () => {
    const request = tileRequest(0, 0, 0);
    const response = await serveTile(new URL(request.url), request, {}, ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/MAP_TILES/);
  });
});
