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
 * (generated, committed, static). Tiles cannot: the planet is gigabytes and
 * GoWay is deliberately not storing it. A proxy is the only shape left, and a
 * proxy is code.
 *
 * ## Be honest about what the tile proxy buys
 *
 * It buys two real things:
 *
 *  - The third-party origin leaves the browser. Every byte of GoWay's map now
 *    comes from `goway.to`, which is what makes the map embeddable, what keeps
 *    it working behind the kind of network policy that blocks unknown hosts,
 *    and what stops a vendor's name being the most prominent thing in a
 *    network panel.
 *  - A seam. Self-hosted tiles — PMTiles in R2, a different planet build, a
 *    regional extract — become a change to `MAP_TILE_UPSTREAM` and this file,
 *    with no style change, no app release and no client that ever knew.
 *
 * It buys NOTHING resembling independence. If OpenFreeMap is down, GoWay's map
 * is down, exactly as it was before. Edge caching narrows the window in which
 * that is visible; it does not change the dependency, and anyone reading this
 * should not tell a user otherwise.
 *
 * ## The upstream's position, as far as it was actually checked
 *
 * Read off openfreemap.org, and quoted rather than paraphrased because the
 * temptation here is to hear permission that was not given:
 *
 *   - "there are no limits on the number of map views or requests"
 *   - commercial use: "Yes"
 *   - "no registration, no user database, no API keys, and no cookies"
 *   - "You can either self-host or use our public instance", with weekly full
 *     planet downloads offered for anyone who wants their own infrastructure
 *
 * What is NOT there: any statement about proxying, mirroring or caching, in
 * either direction. So this proxy is not blessed by their terms; it is merely
 * not forbidden by them, and the honest summary is that GoWay is a heavy user
 * of a service that publishes no limits and offers a self-host path for
 * exactly this situation.
 *
 * Edge caching ought to mean FEWER requests reach them than direct client hits
 * would — one visitor's tile fetch serves the next visitor from Cloudflare —
 * but that is a reasonable expectation and not a measurement, and it will stop
 * being the interesting question at the point where GoWay should be taking the
 * weekly planet download instead. Re-read this before traffic grows by an
 * order of magnitude.
 *
 * The attribution obligation is separate, unaffected, and discharged by the
 * style document's `attribution` and by `components/map/MapAttribution.tsx`.
 *
 * @see `lib/map/provider.ts` — the one module that names the upstream in
 *      product code, and the paths this file answers.
 */

/** How long the edge may keep a vector tile. Tiles change on a planet rebuild. */
const TILE_EDGE_TTL_SECONDS = 86400;

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
 * `/map/tiles/{z}/{x}/{y}.pbf`.
 *
 * The coordinate is validated rather than interpolated on trust. The regex
 * already admits digits only, so there is no path traversal to worry about,
 * but an out-of-range `x` or `y` would still become an upstream request for a
 * tile that cannot exist — and at scale that is a stranger using GoWay to
 * generate misses against a free service. `z > 14` is not an error: the planet
 * build stops there and MapLibre overzooms from z14 on its own, so a request
 * above it is a bug in a style and is answered as a miss, not forwarded.
 */
async function serveTile(url, request, env, ctx) {
  const match = TILE_PATH.exec(url.pathname);
  if (!match) return notFound('Not a tile path.');

  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isInteger(z) || z > 14) return notFound('Zoom outside the planet build.');
  const span = 2 ** z;
  if (x >= span || y >= span) return notFound('Tile coordinate outside the world at that zoom.');

  const upstreamTileJson = env.MAP_TILE_UPSTREAM;
  if (!upstreamTileJson) {
    // Deliberately not a hardcoded fallback host. `lib/map/provider.ts` is the
    // one place in the repository that names an upstream, and a Worker that
    // quietly substituted its own copy would make that false the first time
    // the two drifted.
    return new Response('MAP_TILE_UPSTREAM is not configured for this deployment.', {
      status: 503,
      headers: { ...publicHeaders(0), 'content-type': 'text/plain; charset=utf-8' },
    });
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

  // A 404 from upstream is normal and frequent: OpenMapTiles omits tiles that
  // contain nothing (ocean, empty desert), and MapLibre treats a 404 as an
  // empty tile. Forwarding it as a 404 is correct; turning it into a 502 would
  // make every ocean tile an error in somebody's dashboard.
  return reissue(upstream, TILE_EDGE_TTL_SECONDS);
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
export { GLYPH_PATH, TILE_PATH, UPSTREAM_FONTSTACK, publicHeaders, serveGlyphs, serveTile };
