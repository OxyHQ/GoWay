/**
 * GoWay's Cloudflare Worker — the map origin.
 *
 * ## Why this file exists at all
 *
 * `wrangler.toml` used to carry no `main`, and the comment there argued the
 * case well: GoWay's web build is public, so there is nothing for a Worker to
 * gate, and "a script that exists only to forward to `env.ASSETS` is a runtime
 * failure mode bought for nothing". That argument still holds for every path
 * this file does not claim, which is why `run_worker_first` names exactly two
 * prefixes and everything else still reaches the asset pipeline without
 * executing a line of this.
 *
 * What changed is that GoWay acquired a path that CANNOT be an asset. Measured
 * on the live style document before this existed, loading GoWay's map made the
 * browser talk to `tiles.openfreemap.org` three times — tiles, glyphs, sprite
 * — and never to `goway.to` for any of them. The product's whole proposition
 * is being the map platform, so that is the wrong architecture no matter how
 * good the cartography is. Glyphs and the sprite became genuinely ours
 * (generated, committed, static); the tiles were, at first, only proxied,
 * because the planet is gigabytes and the argument at the time was that GoWay
 * should not store it. That argument no longer holds — see below — but the
 * conclusion it reached does: a tile path is not an asset, and whatever
 * answers it is code.
 *
 * ## What the tiles are now
 *
 * GoWay's own. `scripts/build-map-tiles.ts` runs Planetiler over an
 * OpenStreetMap extract and writes one **PMTiles** archive; that archive lives
 * in **Cloudflare R2**; and this Worker reads byte ranges out of it. There is
 * no tile server anywhere, and no tile request leaves Cloudflare.
 *
 * PMTiles is what makes those three things fit together. R2 is object storage:
 * it can hand back a range of an object and nothing else, so either the whole
 * planet is one object addressed by `Range:` or it is 350 million objects that
 * cost more in write operations to upload than the bytes cost to keep. The
 * Worker was already standing between the browser and the tiles, so the Worker
 * is the thing that reads the ranges. `pmtiles.js` is the reader, and it is the
 * SAME reader `map:tiles:verify` opens a finished build with.
 *
 * ## What this buys that the proxy did not
 *
 * The proxy that used to be here bought two real things — the third-party
 * origin left the browser, and there was a seam to swap. Its header said
 * plainly what it did not buy: "If OpenFreeMap is down, GoWay's map is down,
 * exactly as it was before." That sentence is what this change deletes.
 *
 * It also bought something nobody was looking for. Running the build means
 * choosing what goes in the tile, and what goes in the tile now is the
 * **OpenStreetMap element id** — Planetiler writes `osmId * 10 + 1|2|3` for
 * node, way and relation. A GoWay place whose provenance is
 * `openstreetmap:way/188938001` can therefore be joined to the basemap's own
 * label for the same thing, which is the join that de-duplicating a GoWay chip
 * against the basemap needs and could not previously have.
 *
 * ## The upstream proxy is still here, and only as a rollback
 *
 * If `MAP_TILES` (the R2 binding) or `MAP_TILE_ARCHIVE` (the object key) is
 * missing, {@link serveTile} falls back to proxying `MAP_TILE_UPSTREAM`
 * exactly as before. That is not indecision: R2 is a bucket a human has to
 * create, and a deployment that went out before the bucket existed must serve
 * a map rather than a 503. Delete the fallback once the bucket has been live
 * long enough to trust, and delete `MAP_TILE_UPSTREAM` with it.
 *
 * The attribution obligation is separate, unaffected, and discharged by the
 * style document's `attribution` and by `components/map/MapAttribution.tsx`.
 *
 * @see `lib/map/provider.ts` — the one module that names the upstream in
 *      product code, and the paths this file answers.
 */

import { PMTiles, contentEncodingFor } from './pmtiles.js';

/**
 * How long the edge may keep a vector tile.
 *
 * A day, and it could honestly be a year: the edge cache key below includes
 * the ARCHIVE KEY, and a rebuild goes to a new key rather than overwriting the
 * old object, so a cached tile can never be stale with respect to the archive
 * it came from. A day is kept because it also bounds how long a rolled-back
 * archive keeps being served from a colo nobody has re-warmed.
 */
const TILE_EDGE_TTL_SECONDS = 86400;

/**
 * How long the edge may keep a piece of the archive's directory tree.
 *
 * This is the number that decides the OPERATIONS bill — the storage bill is
 * decided by the archive and is about a dollar fifty. Every tile request needs
 * the header, the root directory and usually one leaf directory before it can
 * ask for a single byte of map, and those are the same few kilobytes for every
 * visitor in a colo. Cached, a warm tile request is ONE R2 read; uncached it
 * would be three or four, and the Class B operations — not the bytes — are
 * what R2 charges for.
 *
 * A week rather than a day because a directory is immutable for the life of an
 * archive key, which is the same reason it is safe to cache at all.
 */
const DIRECTORY_EDGE_TTL_SECONDS = 604800;

/** The media type a vector tile is served as. */
const TILE_CONTENT_TYPE = 'application/vnd.mapbox-vector-tile';

/** How long the edge may keep a proxied glyph range Inter does not cover. */
const GLYPH_EDGE_TTL_SECONDS = 86400;

/**
 * How long a resolved upstream tile template is trusted.
 *
 * The upstream TileJSON names a DATE-STAMPED planet build
 * (`…/planet/20260913_164504_pt/{z}/{x}/{y}.pbf`) and old builds are deleted,
 * so this cannot be resolved once at deploy time and kept — a deployment that
 * did would serve 404s from the day the next planet lands until somebody
 * redeployed. An hour is short enough that a rebuild is picked up the same
 * working day and long enough that the TileJSON is fetched a handful of times
 * per colo per day rather than once per tile.
 */
const TILEJSON_TTL_SECONDS = 3600;

/** `/map/tiles/{z}/{x}/{y}.pbf`, and nothing that merely resembles it. */
const TILE_PATH = /^\/map\/tiles\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.pbf$/;

/** `/map/fonts/{fontstack}/{start}-{end}.pbf`. */
const GLYPH_PATH = /^\/map\/fonts\/([^/]{1,64})\/(\d{1,7})-(\d{1,7})\.pbf$/;

/**
 * Which upstream fontstack answers for one of ours.
 *
 * GoWay's ranges are Inter at four weights. Inter is Latin, Greek and Cyrillic,
 * so a label drawn from a feature's `name` rather than its `name:latin` — most
 * of the CJK, Arabic, Devanagari and Thai world — asks for a range we do not
 * have. Rather than let that label vanish, the request falls through to the
 * upstream font server, which serves Noto. The mapping is by weight, not by
 * name: there is no `Noto Sans Medium` or `Noto Sans SemiBold` upstream (both
 * 404 — that absence is most of why GoWay generates its own), so the two
 * intermediate weights round to the nearest weight that exists.
 *
 * The result is a Tokyo label set in Noto sitting beside a Barcelona label set
 * in Inter. That is a visible inconsistency and it is the deliberate trade:
 * the alternative is no Tokyo label at all.
 */
const UPSTREAM_FONTSTACK = {
  'Inter Regular': 'Noto Sans Regular',
  'Inter Medium': 'Noto Sans Regular',
  'Inter SemiBold': 'Noto Sans Bold',
  'Inter Bold': 'Noto Sans Bold',
};

/**
 * Response headers every public map resource carries.
 *
 * These mirror `public/_headers`, which covers the STATIC half of `/map/*`.
 * The Worker's responses never pass through that file, so the two must be kept
 * in step by hand; changing one without the other is how a third-party embed
 * ends up with a style document it may read and tiles it may not.
 *
 * `Cross-Origin-Resource-Policy` is the one that is easy to omit and hard to
 * debug: a wildcard ACAO admits the fetch, but an embedder running under
 * `Cross-Origin-Embedder-Policy: require-corp` has its browser block every
 * subresource that does not opt in, and the console blames COEP rather than
 * GoWay.
 */
function publicHeaders(cacheSeconds) {
  return {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': `public, max-age=${cacheSeconds}`,
    'x-content-type-options': 'nosniff',
  };
}

/**
 * Upstream response headers that must not travel back out.
 *
 * Two reasons, and only the first is cosmetic. `x-ofm-debug` and friends name
 * the vendor in a response the whole point of which is that it comes from
 * GoWay. More importantly `expires`, `age` and the upstream's own
 * `cache-control` would fight the freshness this Worker is asserting, and
 * `nel`/`report-to` would enrol GoWay's visitors in a third party's error
 * reporting.
 */
const STRIPPED_UPSTREAM_HEADERS = [
  'age',
  'alt-svc',
  'cache-control',
  'expires',
  'nel',
  'report-to',
  'server',
  'set-cookie',
  'x-ofm-debug',
  'x-robots-tag',
];

/** CORS preflight for the proxied paths. Simple, because the requests are. */
function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      ...publicHeaders(TILE_EDGE_TTL_SECONDS),
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

function notFound(reason) {
  return new Response(reason, {
    status: 404,
    headers: { ...publicHeaders(60), 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Re-dress an upstream response as one of ours.
 *
 * `response.body` is streamed through rather than buffered, and the upstream's
 * `content-type`, `content-encoding` and `etag` are KEPT. Dropping
 * `content-encoding` is the classic mistake here: vector tiles arrive gzipped,
 * and a body forwarded without the header that says so is a `.pbf` the
 * renderer cannot parse and will not explain.
 */
function reissue(response, cacheSeconds) {
  const headers = new Headers(response.headers);
  for (const name of STRIPPED_UPSTREAM_HEADERS) headers.delete(name);
  for (const [name, value] of Object.entries(publicHeaders(cacheSeconds))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The current upstream `{z}/{x}/{y}` template, resolved and cached.
 *
 * Cached in the colo's shared `caches.default` rather than in a module-level
 * variable, because a module-level variable lives as long as one isolate —
 * which can be seconds — and would have every cold isolate re-fetch the
 * TileJSON before its first tile. The cache key is a synthetic `https://goway`
 * URL: `caches.default` keys on a Request, and using the real upstream URL
 * would collide with any other caching of that document.
 */
async function upstreamTileTemplate(upstreamTileJson, ctx) {
  const cacheKey = new Request('https://goway.internal/map/upstream-tilejson', { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const cached = await hit.text();
    if (cached) return cached;
  }

  const response = await fetch(upstreamTileJson, {
    cf: { cacheEverything: true, cacheTtl: TILEJSON_TTL_SECONDS },
  });
  if (!response.ok) return null;

  const document = await response.json();
  const template = Array.isArray(document?.tiles) ? document.tiles[0] : null;
  if (typeof template !== 'string' || !template.includes('{z}')) return null;

  const store = new Response(template, {
    headers: { 'cache-control': `public, max-age=${TILEJSON_TTL_SECONDS}` },
  });
  ctx.waitUntil(cache.put(cacheKey, store));
  return template;
}

/**
 * The highest zoom any GoWay archive is built to.
 *
 * Checked before storage is touched, deliberately. The archive header carries
 * the same number and {@link PMTiles.getTile} honours it, but reaching that
 * check costs a read; refusing here costs nothing. `z > 14` is not an error
 * either way — OpenMapTiles stops at 14 and MapLibre overzooms from there on
 * its own, so a request above it is a bug in a style document and is answered
 * as a miss.
 */
const MAX_TILE_ZOOM = 14;

/**
 * A PMTiles byte source backed by an R2 bucket and the colo's shared cache.
 *
 * `hot` reads — the header, the root directory, a leaf directory — go through
 * `caches.default` and are therefore read from R2 once per colo per week
 * rather than once per tile. Tile bodies do not: they are cached as whole
 * responses by {@link serveTileFromArchive}, and caching them twice would
 * double the edge storage for nothing.
 *
 * The cache key names the archive key, so pointing `MAP_TILE_ARCHIVE` at a new
 * build invalidates every cached directory in the world at the moment of the
 * deploy. That is the entire cutover procedure, and the reason a rebuild is
 * never written over the object a Worker is mid-request against: a PMTiles
 * archive is addressed by byte offset, so overwriting one in place does not
 * serve a stale tile, it serves whatever now lives at that offset.
 */
function archiveSource(bucket, key, ctx) {
  const cache = caches.default;
  return {
    async read(offset, length, options = {}) {
      const range = { offset, length };
      if (!options.hot) {
        const object = await bucket.get(key, { range });
        if (!object) throw new Error(`the archive "${key}" is missing from the bucket`);
        return new Uint8Array(await object.arrayBuffer());
      }

      const cacheKey = new Request(
        `https://goway.internal/pmtiles/${encodeURIComponent(key)}/${offset}-${length}`,
      );
      const hit = await cache.match(cacheKey);
      if (hit) return new Uint8Array(await hit.arrayBuffer());

      const object = await bucket.get(key, { range });
      if (!object) throw new Error(`the archive "${key}" is missing from the bucket`);
      const bytes = new Uint8Array(await object.arrayBuffer());
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(bytes, {
            headers: { 'cache-control': `public, max-age=${DIRECTORY_EDGE_TTL_SECONDS}` },
          }),
        ),
      );
      return bytes;
    },
  };
}

/**
 * `/map/tiles/{z}/{x}/{y}.pbf`, out of GoWay's own archive in R2.
 *
 * ## The bytes are never decompressed
 *
 * Planetiler writes gzipped MVT and the PMTiles header says so, so the stored
 * bytes ARE the response body and `content-encoding: gzip` is the whole of the
 * work. Decompressing here to let the platform re-compress on the wire would
 * burn CPU on every tile to arrive at the same bytes. This is also the one
 * place where getting a header wrong produces the classic unexplained failure:
 * a gzipped body forwarded WITHOUT `content-encoding` is a `.pbf` MapLibre
 * cannot parse and will not explain.
 *
 * ## A missing tile is a 404 and that is correct
 *
 * An OpenMapTiles build omits every tile that would be empty — mid-ocean,
 * empty desert — and MapLibre treats a 404 as an empty tile. Turning that into
 * a 502 would make the Atlantic an incident. It is cached for the full TTL
 * like any other answer, because a tile absent from a given archive key is
 * absent from it forever.
 */
async function serveTileFromArchive(z, x, y, request, env, ctx) {
  const cache = caches.default;
  const key = env.MAP_TILE_ARCHIVE;
  const cacheKey = new Request(
    `https://goway.internal/map/tiles/${encodeURIComponent(key)}/${z}/${x}/${y}.pbf`,
  );

  const hit = await cache.match(cacheKey);
  if (hit) {
    // `status` has to be carried across, not defaulted. A cached MISS is a
    // 404, and `new Response(null, { headers })` is a 200 — a HEAD for an
    // ocean tile would have answered "this tile exists" with an empty body.
    return request.method === 'HEAD'
      ? new Response(null, { status: hit.status, headers: hit.headers })
      : hit;
  }

  let tile;
  try {
    tile = await new PMTiles(archiveSource(env.MAP_TILES, key, ctx)).getTile(z, x, y);
  } catch (error) {
    // A bucket that answers and an archive that does not parse are different
    // problems from an empty tile, and only this one deserves a 5xx.
    return new Response(`The tile archive could not be read: ${error.message}`, {
      status: 502,
      headers: { ...publicHeaders(0), 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const headers = new Headers(publicHeaders(TILE_EDGE_TTL_SECONDS));
  if (!tile) {
    const miss = new Response(null, { status: 404, headers });
    ctx.waitUntil(cache.put(cacheKey, miss.clone()));
    return miss;
  }

  headers.set('content-type', TILE_CONTENT_TYPE);
  headers.set('content-length', String(tile.bytes.length));
  const encoding = contentEncodingFor(tile.compression);
  if (encoding) headers.set('content-encoding', encoding);

  const response = new Response(tile.bytes, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return request.method === 'HEAD' ? new Response(null, { headers }) : response;
}

/**
 * `/map/tiles/{z}/{x}/{y}.pbf`, proxied from the upstream planet build.
 *
 * The rollback path, kept for exactly as long as it takes to trust the bucket.
 * Everything it was and everything it was not is in this file's header.
 */
async function proxyTile(z, x, y, request, env, ctx) {
  const upstreamTileJson = env.MAP_TILE_UPSTREAM;
  if (!upstreamTileJson) {
    return new Response(
      'Neither an R2 tile archive (MAP_TILES + MAP_TILE_ARCHIVE) nor MAP_TILE_UPSTREAM is ' +
        'configured for this deployment.',
      { status: 503, headers: { ...publicHeaders(0), 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const template = await upstreamTileTemplate(upstreamTileJson, ctx);
  if (!template) {
    return new Response('The upstream tile index could not be read.', {
      status: 502,
      headers: { ...publicHeaders(0), 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const target = template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

  const upstream = await fetch(target, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    cf: { cacheEverything: true, cacheTtl: TILE_EDGE_TTL_SECONDS },
  });

  return reissue(upstream, TILE_EDGE_TTL_SECONDS);
}

/**
 * `/map/tiles/{z}/{x}/{y}.pbf`.
 *
 * The coordinate is validated rather than trusted, and it is validated BEFORE
 * either backend is chosen. The regex already admits digits only, so there is
 * no path traversal to worry about, but an out-of-range `x` or `y` would still
 * become a lookup for a tile that cannot exist — a stranger generating misses
 * against GoWay's storage, which now costs GoWay operations rather than
 * costing a free service its bandwidth. The argument for refusing it got
 * stronger, not weaker, when the tiles became ours.
 */
async function serveTile(url, request, env, ctx) {
  const match = TILE_PATH.exec(url.pathname);
  if (!match) return notFound('Not a tile path.');

  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isInteger(z) || z > MAX_TILE_ZOOM) return notFound('Zoom outside the planet build.');
  const span = 2 ** z;
  if (x >= span || y >= span) return notFound('Tile coordinate outside the world at that zoom.');

  if (env.MAP_TILES && env.MAP_TILE_ARCHIVE) {
    return serveTileFromArchive(z, x, y, request, env, ctx);
  }
  return proxyTile(z, x, y, request, env, ctx);
}

/**
 * `/map/fonts/{fontstack}/{range}.pbf`.
 *
 * Assets first, upstream second. The ranges Inter covers are committed under
 * `public/map/fonts/` and are served by the asset pipeline exactly like any
 * other file; this function exists only for the ranges it does not.
 *
 * ## The trap
 *
 * `wrangler.toml` sets `not_found_handling = "single-page-application"`, which
 * means `env.ASSETS.fetch()` answers a path it does not have with **200 and
 * `index.html`**, not with a 404. A naive `if (response.ok) return response`
 * would therefore hand MapLibre the HTML shell of the app labelled as a glyph
 * range, and MapLibre's protobuf reader would fail on it with an error naming
 * neither the font nor the fallback that should have happened. The content
 * type is what distinguishes the two, so that is what is checked. If the SPA
 * fallback is ever changed, re-read this.
 */
async function serveGlyphs(url, request, env) {
  const match = GLYPH_PATH.exec(url.pathname);
  if (!match) return notFound('Not a glyph path.');

  const fontstack = decodeURIComponent(match[1]);
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (end !== start + 255 || start % 256 !== 0 || start > 0x10ffff) {
    return notFound('Not a 256-codepoint glyph range.');
  }

  const asset = await env.ASSETS.fetch(request);
  const type = asset.headers.get('content-type') || '';
  if (asset.ok && !type.startsWith('text/html')) {
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(publicHeaders(GLYPH_EDGE_TTL_SECONDS))) {
      headers.set(name, value);
    }
    return new Response(asset.body, { status: asset.status, headers });
  }

  const upstreamStack = UPSTREAM_FONTSTACK[fontstack];
  const upstreamGlyphs = env.MAP_GLYPH_UPSTREAM;
  if (!upstreamStack || !upstreamGlyphs) return notFound('No glyphs for that fontstack and range.');

  const target = upstreamGlyphs
    .replace('{fontstack}', encodeURIComponent(upstreamStack))
    .replace('{range}', `${start}-${end}`);

  const upstream = await fetch(target, {
    cf: { cacheEverything: true, cacheTtl: GLYPH_EDGE_TTL_SECONDS },
  });
  return reissue(upstream, GLYPH_EDGE_TTL_SECONDS);
}

export default {
  /**
   * Only the two prefixes named by `run_worker_first` ever arrive here; every
   * other request is answered by the asset pipeline without this Worker
   * running. The `env.ASSETS.fetch` at the bottom is therefore a safety net
   * for a misconfiguration rather than the normal path, and it is what keeps a
   * mistake in `run_worker_first` from taking the whole app down.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed.', {
        status: 405,
        headers: { ...publicHeaders(0), allow: 'GET, HEAD, OPTIONS' },
      });
    }

    if (url.pathname.startsWith('/map/tiles/')) return serveTile(url, request, env, ctx);
    if (url.pathname.startsWith('/map/fonts/')) return serveGlyphs(url, request, env);

    return env.ASSETS.fetch(request);
  },
};

// Exported for `worker/__tests__/`: the routing and validation above is the
// part with edge cases, and it is testable without a Workers runtime as long
// as the pieces are reachable. The default export stays the deployed contract.
//
// One rule, learned from a real `wrangler dev` rather than from a document:
// **every named export of a Worker's entry module must be a function or an
// object.** workerd inspects them looking for entrypoint classes, and a
// `export const MAX_TILE_ZOOM = 14` makes the whole service refuse to start
// with `Incorrect type for map entry 'MAX_TILE_ZOOM': the provided value is
// not of type 'function or ExportedHandler'`. That is a total outage for the
// map, produced by a constant exported for a unit test. The regexes and the
// fontstack table below are objects and are therefore fine; numbers and
// strings are not. `worker/__tests__/pmtiles.test.js` asserts this.
export { GLYPH_PATH, TILE_PATH, UPSTREAM_FONTSTACK, archiveSource, publicHeaders, serveGlyphs, serveTile };
