/**
 * Serving a tile out of a PMTiles archive in R2: the part the basemap
 * (`/map/tiles`), the elevation tiles (`/map/terrain`) and the city tiles
 * (`/map/city`, `/map/city-roads`) share.
 *
 * ## Compressed on the wire, compressed nowhere in the Worker
 *
 * The archives store their vector tiles gzipped (PMTiles `tile_compression`
 * gzip; the WebP elevation tiles are stored as they are). A client that
 * accepts gzip gets those stored bytes as they are, declared with
 * `content-encoding: gzip` and handed to the runtime with
 * `encodeBody: 'manual'` — "this body is already encoded as its header says"
 * — so nothing is decompressed or compressed per request. A client that does
 * not accept gzip gets the tile decoded. `Vary: Accept-Encoding` says the two
 * differ.
 *
 * History, because it decided the shape: #68 tried exactly this and the map
 * went blank, #69 concluded the runtime drops a hand-set `content-encoding`
 * and decoded every tile instead — measured 2026-10-12 on Madrid's densest
 * city tile, 502,915 B on the wire where 269,651 B of gzip were stored, and
 * 936 kB for a dense basemap tile, because Cloudflare does not compress
 * `application/vnd.mapbox-vector-tile`. What #68 did NOT do is control the
 * cache: it `cache.put` the manual-encoded response and returned
 * `cache.match`'s answer as is, a response whose body the runtime then treats
 * as decoded content. So here the cache holds the stored bytes as an opaque
 * entry (the archive's compression in a header of our own), and every answer
 * — hit or miss — is built fresh by {@link tileResponse}.
 *
 * ## One storage read per tile
 *
 * Reading a tile is: the archive's header and root directory, usually one
 * leaf directory, then the tile's bytes. The tile is read once per colo (then
 * the edge cache answers); the header and directories are the same few
 * kilobytes for every tile of an archive, so they are kept three ways, nearest
 * first: decoded, in this isolate's {@link DirectoryMemo}; as bytes, in the
 * colo's cache for a week (keyed by archive key — immutable); and in R2.
 * A warm isolate therefore reads exactly one range from R2 for a tile the
 * colo has not served yet. Every answer carries `Server-Timing` saying how
 * many R2 reads and cache lookups it took, which is how that claim is checked
 * in production.
 */

import { COMPRESSION, DirectoryMemo, PMTiles, decompress } from './pmtiles.js';

/** How long a directory read may be kept at the edge: a week (immutable per archive key). */
const DIRECTORY_TTL = 604800;

/** The header this module stores an archive's tile compression in, on cached entries. */
const STORED_COMPRESSION = 'x-goway-tile-compression';

/**
 * The isolate's memory of archive headers and directories, shared by every
 * route. 192 entries: a header, a root and a leaf or two for each of the
 * archives a busy isolate touches (the basemap, and the few city regions in
 * view).
 */
const memo = new DirectoryMemo(192);

/** For tests: forget what this isolate has read. */
export function forgetDirectories() {
  memo.entries.clear();
}

/**
 * A request's storage accounting, reported as `Server-Timing`: R2 range reads
 * and edge-cache lookups, with the milliseconds each took.
 */
export function newTimings() {
  return { r2: 0, r2Ms: 0, cache: 0, cacheMs: 0, started: Date.now() };
}

export function serverTiming(timings, label) {
  const total = Date.now() - timings.started;
  return [
    `r2;desc="${timings.r2} reads";dur=${timings.r2Ms}`,
    `cache;desc="${timings.cache} lookups";dur=${timings.cacheMs}`,
    `${label};dur=${total}`,
  ].join(', ');
}

/**
 * A PMTiles byte source over R2 with directory reads cached at the edge.
 * Tile bodies are not cached here: the whole answer is, by the caller.
 */
export function archiveSource(bucket, key, ctx, timings = newTimings()) {
  const cache = caches.default;
  const r2 = async (range) => {
    const started = Date.now();
    const object = await bucket.get(key, { range });
    timings.r2 += 1;
    timings.r2Ms += Date.now() - started;
    if (!object) throw new Error(`the archive "${key}" is missing from the bucket`);
    return new Uint8Array(await object.arrayBuffer());
  };
  return {
    async read(offset, length, options = {}) {
      const range = { offset, length };
      if (!options.hot) return r2(range);

      const cacheKey = new Request(
        `https://goway.internal/pmtiles/${encodeURIComponent(key)}/${offset}-${length}`,
      );
      const started = Date.now();
      const hit = await cache.match(cacheKey);
      timings.cache += 1;
      timings.cacheMs += Date.now() - started;
      if (hit) return new Uint8Array(await hit.arrayBuffer());

      const bytes = await r2(range);
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(bytes, {
            headers: { 'cache-control': `public, max-age=${DIRECTORY_TTL}` },
          }),
        ),
      );
      return bytes;
    },
  };
}

/** A tile of `key`, read with the isolate's memo: `{ bytes, compression }` or `null`. */
export function readTile(bucket, key, ctx, timings, z, x, y) {
  return new PMTiles(archiveSource(bucket, key, ctx, timings), { memo, name: key }).getTile(
    z,
    x,
    y,
  );
}

/**
 * The edge-cache entry for a stored tile: the archive's bytes as they are,
 * opaque to the cache (no `content-encoding`), its compression in our own
 * header. `null` (the archive has no such tile) is stored as a bodiless entry
 * with `missStatus`.
 */
export function tileCacheEntry(tile, cacheSeconds, missStatus) {
  const headers = { 'cache-control': `public, max-age=${cacheSeconds}` };
  if (!tile) return new Response(null, { status: missStatus, headers });
  return new Response(tile.bytes, {
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      [STORED_COMPRESSION]: String(tile.compression),
    },
  });
}

/** Read a {@link tileCacheEntry} back: `{ tile, status }`. */
export async function fromTileCacheEntry(entry) {
  const compression = entry.headers.get(STORED_COMPRESSION);
  if (entry.status !== 200 || compression === null) {
    await entry.body?.cancel();
    return { tile: null, status: entry.status };
  }
  return {
    tile: { bytes: new Uint8Array(await entry.arrayBuffer()), compression: Number(compression) },
    status: 200,
  };
}

/** Whether the client takes gzip (`Accept-Encoding`, `q=0` refusing it). */
export function acceptsGzip(request) {
  const header = request.headers.get('accept-encoding') ?? '';
  return header.split(',').some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== '*') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

/**
 * The answer for a stored tile.
 *
 * Gzip stored and gzip accepted: the stored bytes, `content-encoding: gzip`,
 * `encodeBody: 'manual'` — zero work. Anything else: decoded once, sent plain.
 * `headers` carries the route's public headers and content type.
 */
export async function tileResponse(tile, request, headers) {
  const out = new Headers(headers);
  out.append('vary', 'accept-encoding');
  const head = request.method === 'HEAD';
  if (tile.compression === COMPRESSION.GZIP && acceptsGzip(request)) {
    out.set('content-encoding', 'gzip');
    out.set('content-length', String(tile.bytes.length));
    return new Response(head ? null : tile.bytes, { headers: out, encodeBody: 'manual' });
  }
  const body = await decompress(tile.bytes, tile.compression);
  out.set('content-length', String(body.length));
  return new Response(head ? null : body, { headers: out });
}

/**
 * Answer a tile request out of an archive: the edge cache first, the archive
 * on a miss, every answer built by {@link tileResponse}.
 *
 * `cacheKey` must name the archive key (immutable, so a cached answer can
 * never be stale for it) and must be in this module's namespace: an entry is
 * the stored bytes plus {@link STORED_COMPRESSION}, a different thing from the
 * decoded responses cached under the routes' old keys, which are left to
 * expire unread.
 */
export async function serveArchiveTile({
  request,
  ctx,
  bucket,
  key,
  z,
  x,
  y,
  cacheKey,
  cacheSeconds,
  contentType,
  publicHeaders,
  missStatus,
  what,
}) {
  const timings = newTimings();
  const cache = caches.default;
  const cacheRequest = new Request(`https://goway.internal/tiles/v2/${cacheKey}`);
  const started = Date.now();
  const hit = await cache.match(cacheRequest);
  timings.cache += 1;
  timings.cacheMs += Date.now() - started;

  let tile;
  let status;
  if (hit) {
    ({ tile, status } = await fromTileCacheEntry(hit));
  } else {
    try {
      tile = await readTile(bucket, key, ctx, timings, z, x, y);
    } catch (error) {
      // A bucket that answers and an archive that does not parse are a
      // different problem from an empty tile, and only this one is a 5xx.
      return new Response(`The ${what} could not be read: ${error.message}`, {
        status: 502,
        headers: {
          ...publicHeaders,
          'cache-control': 'public, max-age=0',
          'content-type': 'text/plain; charset=utf-8',
        },
      });
    }
    status = tile ? 200 : missStatus;
    ctx.waitUntil(cache.put(cacheRequest, tileCacheEntry(tile, cacheSeconds, missStatus)));
  }

  const headers = new Headers(publicHeaders);
  headers.set('server-timing', serverTiming(timings, hit ? 'hit' : 'miss'));
  if (!tile) return new Response(null, { status, headers });
  headers.set('content-type', contentType);
  return tileResponse(tile, request, headers);
}
