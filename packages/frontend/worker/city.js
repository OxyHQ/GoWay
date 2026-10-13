/**
 * The city tiles at the edge: `/map/city/*` and `/map/city-roads/*`, out of
 * REGIONAL PMTiles archives in R2, chosen per tile by a manifest.
 *
 * ## Why a manifest and not one archive
 *
 * The basemap is one planet archive (`MAP_TILE_ARCHIVE`) because Planetiler
 * builds the planet in one go. The city compiler cannot: it holds a region's
 * buildings in memory, so the world is built per Geofabrik region on ordinary
 * machines, in parallel, and a region is rebuilt on its own when it changes
 * (`docs/MAP_CITY_PLANET.md`). Merging hundreds of archives into one after
 * every regional rebuild would rewrite tens of gigabytes to change one
 * country. So the archives stay separate and ONE small document — the
 * manifest — says which archive answers which tile.
 *
 * Each region OWNS the z15 tiles wholly inside its polygon
 * (`scripts/citygen/ownership.ts`), stored in the manifest as a coverage tree
 * (`coverageTree.js`). A tile is answered by the first region in the manifest
 * that owns it; owned twice (polygons overlap at borders) means both archives
 * hold the same buildings, so the first is as good as the second.
 *
 * ## The answers, and what the client makes of them
 *
 * | Answer | Meaning | Client (`meshWorker.ts`, `sources.ts`) |
 * | --- | --- | --- |
 * | 200 | the tile, decoded MVT | meshes it |
 * | 204 | owned by a region, nothing in it (sea, fields) | empty ground |
 * | 404 | owned by no published region, or not a city-tile address | empty — but the client never asks: `coverage.json` says it is not covered and the basemap's buildings draw |
 *
 * 204 and 404 both decode as "no tile"; the difference is for people and
 * caches: an empty tile is a fact about an immutable archive and is cached
 * for a day, "not covered" can change with the next manifest and is cached
 * for five minutes.
 *
 * ## Off until configured
 *
 * Nothing here runs a request against storage unless `MAP_CITY_MANIFEST`
 * names the manifest's key in the `MAP_TILES` bucket. Unset — the state of
 * production until the owner flips it — every tile is 404 and the coverage
 * document covers nothing, so a client with the city-tile flag on draws the
 * basemap's buildings exactly as it does today.
 *
 * ## ODbL
 *
 * The archives are a Derivative Database of OpenStreetMap, served to every
 * browser that draws them, so the database is offered beside them:
 * `/map/city/manifest.json` lists every archive with its receipt (the extract,
 * its replication timestamp, the polygon), and `/map/city/data/<key>` serves
 * each archive and receipt the manifest names — and nothing else from the
 * bucket.
 */

import { MEMORY_BUDGET } from './budget.js';
import { compactCoverageAt, compactCoverageTree, FULL } from './coverageTree.js';
import { DirectoryMemo } from './pmtiles.js';
import { serveArchiveTile } from './tiles.js';

/** `/map/city/{z}/{x}/{y}.pbf` and `/map/city-roads/…`, and nothing that merely resembles them. */
const CITY_TILE_PATH = /^\/map\/(city|city-roads)\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.pbf$/;

/** `/map/city/data/<archive key>[.receipt.json]` — the ODbL download. */
const CITY_DATA_PATH = /^\/map\/city\/data\/(.+)$/;

/**
 * A dated archive key, exactly as the manifest builder writes them
 * (`scripts/build-city-manifest.ts` → `ARCHIVE_KEY`): kind, stamp, region id,
 * optional part. Checked before the manifest is consulted, so a path that is
 * not one never costs a lookup.
 */
const CITY_ARCHIVE_KEY =
  /^(city|city-roads)\/[0-9]{8}(-[a-z0-9]{1,24})?\/[a-z0-9-]+(\/[a-z0-9-]+)*(~[0-9]+of[0-9]+)?\.pmtiles(\.receipt\.json)?$/;

/** A region id: Geofabrik path segments, plus `~<i>of<n>` for a part. */
const REGION_ID = /^[a-z0-9-]+(\/[a-z0-9-]+)*(~[0-9]+of[0-9]+)?$/;

/** The one zoom city tiles exist at (`CITY_TILE_ZOOM` in `lib/map/cityTiles.ts`). */
const CITY_ZOOM = 15;

/** The zoom the client's coverage is decided at (`CLIENT_COVERAGE_ZOOM`). */
const COVERAGE_ZOOM = 14;

/** The manifest schema this Worker reads. */
const MANIFEST_SCHEMA = 1;

/**
 * Seconds a tile answer may be kept: a day, like the basemap's. The archive
 * key is in the edge cache key and archives are never overwritten, so the
 * edge can never mix two builds of one region; a browser's own cache can,
 * for at most this long after a regional rebuild.
 */
const TILE_TTL = 86400;

/** Seconds the manifest, and anything derived from it, may be kept. */
const MANIFEST_TTL = 300;

function headers(cacheSeconds, extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': `public, max-age=${cacheSeconds}`,
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function text(status, body, cacheSeconds) {
  return new Response(body, {
    status,
    headers: headers(cacheSeconds, { 'content-type': 'text/plain; charset=utf-8' }),
  });
}

function withMethod(request, response) {
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

/**
 * Check a manifest document, refusing anything that is not exactly what the
 * manifest builder writes. A manifest is the one file that, if wrong,
 * mis-serves every region at once, so a partial read is not an option.
 */
export function parseCityManifest(document) {
  if (document?.schema !== MANIFEST_SCHEMA) throw new Error('not a schema-1 city manifest');
  if (document.tileZoom !== CITY_ZOOM) throw new Error(`tileZoom is not ${CITY_ZOOM}`);
  if (!Array.isArray(document.regions)) throw new Error('regions is not a list');
  const regions = document.regions.map((region) => {
    if (typeof region?.id !== 'string' || !REGION_ID.test(region.id)) {
      throw new Error(`"${region?.id}" is not a region id`);
    }
    const bbox = region.bbox;
    if (
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
      !(bbox[0] < bbox[2] && bbox[1] < bbox[3])
    ) {
      throw new Error(`${region.id}: bbox`);
    }
    if (region.ownership?.maxZoom !== CITY_ZOOM || typeof region.ownership.bits !== 'string') {
      throw new Error(`${region.id}: ownership`);
    }
    const ref = (value, kind) => {
      if (value === null || value === undefined) return null;
      if (typeof value.key !== 'string' || !CITY_ARCHIVE_KEY.test(value.key)) {
        throw new Error(`${region.id}: ${kind} key`);
      }
      if (!value.key.startsWith(`${kind}/`) || value.key.endsWith('.receipt.json')) {
        throw new Error(`${region.id}: ${kind} key is not a ${kind} archive`);
      }
      if (value.receipt !== `${value.key}.receipt.json`) throw new Error(`${region.id}: receipt`);
      return { key: value.key, receipt: value.receipt };
    };
    return {
      id: region.id,
      bbox,
      ownership: { maxZoom: region.ownership.maxZoom, bits: region.ownership.bits },
      city: ref(region.city, 'city'),
      roads: ref(region.roads, 'city-roads'),
    };
  });
  for (const kind of ['coverage', 'roadsCoverage']) {
    const coverage = document[kind];
    if (coverage?.maxZoom !== COVERAGE_ZOOM || typeof coverage.bits !== 'string') {
      throw new Error(`${kind} is not a z${COVERAGE_ZOOM} coverage tree`);
    }
  }
  // What `/map/city/coverage.json` answers, built once per manifest: the
  // parsed document itself is not kept (its 2.6 MB of objects would be the
  // largest thing in the isolate), only what the routes read.
  const coverageBody = JSON.stringify({
    schema: 2,
    generatedAt: document.generatedAt,
    tileZoom: CITY_ZOOM,
    tiles: { maxZoom: document.coverage.maxZoom, bits: document.coverage.bits },
    roads: { maxZoom: document.roadsCoverage.maxZoom, bits: document.roadsCoverage.bits },
    regions: document.regions.map((region) => ({
      id: region.id,
      name: region.name,
      bbox: region.bbox,
      replicationTimestamp: region.source?.replicationTimestamp,
    })),
    manifest: '/map/city/manifest.json',
  });
  return {
    version: String(document.generatedAt ?? ''),
    regions,
    keys: new Set(regions.flatMap(archiveKeysOf)),
    coverageBody,
  };
}

/**
 * Bytes a parsed manifest holds, by the strings and small objects it keeps —
 * an estimate on the high side (two bytes a character, ~300 B a region), for
 * the memory budget and its test.
 */
export function manifestBytes(manifest) {
  let bytes = manifest.coverageBody.length * 2;
  for (const region of manifest.regions) {
    bytes += 300 + region.id.length * 2 + region.ownership.bits.length * 2;
    for (const ref of [region.city, region.roads]) if (ref) bytes += 4 * ref.key.length + 64;
  }
  return bytes;
}

/**
 * Decoded ownership trees, compact (5 B a node), least recently used out
 * first within their byte budget: an isolate holds the regions it is asked
 * about, not the planet's 4.58 M nodes.
 */
const ownershipTrees = new DirectoryMemo(MEMORY_BUDGET.ownershipTrees);

function ownershipTree(manifest, region) {
  const key = `${manifest.version}|${region.id}`;
  let tree = ownershipTrees.get(key);
  if (!tree) {
    tree = compactCoverageTree(region.ownership);
    ownershipTrees.set(key, tree, tree.bytes);
  }
  return tree;
}

function archiveKeysOf(region) {
  return [region.city, region.roads].filter(Boolean).flatMap((ref) => [ref.key, ref.receipt]);
}

/**
 * The parsed manifest, per isolate for a minute and per colo for five.
 *
 * Module state is fine here because it is only a cache, keyed by the
 * manifest's object key: a rewritten manifest is picked up by every colo
 * within `MANIFEST_TTL` + a minute, and one request only ever reads one
 * manifest. Nothing it names can go stale meanwhile, because archives are
 * never overwritten — a manifest only ever points at immutable keys.
 *
 * The planet's manifest is 2.6 MB of JSON. Re-reading and re-parsing it every
 * minute in every isolate was the largest CPU cost of a city tile, so the
 * colo's copy carries the R2 object's etag: when the minute is up and the
 * etag is the one already parsed, the isolate keeps what it has (and the
 * ownership trees it decoded) without reading the body. Concurrent requests
 * in a cold isolate share one load.
 */
const memory = { key: null, at: 0, value: null, etag: null, loading: null, loadingKey: null };

async function loadManifest(env, ctx) {
  const key = env.MAP_CITY_MANIFEST;
  if (memory.key === key && memory.value && Date.now() - memory.at < 60_000) return memory.value;
  if (memory.loading && memory.loadingKey === key) return memory.loading;
  memory.loadingKey = key;
  memory.loading = refreshManifest(env, ctx, key).finally(() => {
    memory.loading = null;
  });
  return memory.loading;
}

function manifestCacheKey(key) {
  return new Request(`https://goway.internal/city-manifest/${encodeURIComponent(key)}`);
}

/** The manifest's text and etag, from the colo's cache or R2 (then cached). */
async function fetchManifest(env, ctx, key, knownEtag) {
  const cache = caches.default;
  const hit = await cache.match(manifestCacheKey(key));
  if (hit) {
    const etag = hit.headers.get('x-goway-etag');
    if (etag && knownEtag && etag === knownEtag) {
      await hit.body?.cancel();
      return { body: null, etag };
    }
    return { body: await hit.text(), etag };
  }
  const object = await env.MAP_TILES.get(key);
  if (!object) throw new Error(`the city manifest "${key}" is missing from the bucket`);
  const body = await object.text();
  const etag = object.etag ?? null;
  ctx.waitUntil(
    cache.put(
      manifestCacheKey(key),
      new Response(body, {
        headers: {
          'cache-control': `public, max-age=${MANIFEST_TTL}`,
          ...(etag ? { 'x-goway-etag': etag } : {}),
        },
      }),
    ),
  );
  return { body, etag };
}

/** The manifest as published, for `/map/city/manifest.json`. */
async function manifestText(env, ctx) {
  return (await fetchManifest(env, ctx, env.MAP_CITY_MANIFEST, null)).body;
}

async function refreshManifest(env, ctx, key) {
  const known = memory.key === key && memory.value ? memory.etag : null;
  const { body, etag } = await fetchManifest(env, ctx, key, known);
  if (body === null) {
    memory.at = Date.now();
    return memory.value;
  }
  const value = parseCityManifest(JSON.parse(body));
  memory.key = key;
  memory.at = Date.now();
  memory.value = value;
  memory.etag = etag;
  return value;
}

/** Whether the city tiles are configured on this deployment. */
function configured(env) {
  return Boolean(env.MAP_TILES && env.MAP_CITY_MANIFEST);
}

/**
 * The region that owns z15 tile (x, y), or null. First in manifest order;
 * the bounding box is checked before the ownership tree is decoded, so a
 * tile is tested in full against one or two regions, not hundreds.
 */
export function ownerOf(manifest, x, y) {
  const n = 2 ** CITY_ZOOM;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  for (const region of manifest.regions) {
    const [w, s, e, nn] = region.bbox;
    if (lon < w || lon > e || lat < s || lat > nn) continue;
    if (compactCoverageAt(ownershipTree(manifest, region), CITY_ZOOM, x, y) === FULL) return region;
  }
  return null;
}

/** `/map/city/{z}/{x}/{y}.pbf` and `/map/city-roads/{z}/{x}/{y}.pbf`. */
export async function serveCityTile(url, request, env, ctx) {
  const match = CITY_TILE_PATH.exec(url.pathname);
  if (!match) return text(404, 'Not a city tile path.', 60);
  const kind = match[1] === 'city' ? 'city' : 'roads';
  const z = Number(match[2]);
  const x = Number(match[3]);
  const y = Number(match[4]);
  // Refused before storage is touched: city tiles exist at one zoom only, and
  // a coordinate outside the world is a stranger generating lookups.
  if (z !== CITY_ZOOM) return text(404, `City tiles exist at z${CITY_ZOOM} only.`, 86400);
  const span = 2 ** z;
  if (x >= span || y >= span) return text(404, 'Tile coordinate outside the world.', 86400);
  if (!configured(env)) {
    return withMethod(request, text(404, 'City tiles are not served by this deployment.', 300));
  }

  let manifest;
  const manifestStarted = Date.now();
  try {
    manifest = await loadManifest(env, ctx);
  } catch (error) {
    return text(502, `The city manifest could not be read: ${error.message}`, 0);
  }
  const manifestMs = Date.now() - manifestStarted;
  const owner = ownerOf(manifest, x, y);
  const ref = owner?.[kind];
  if (!ref) {
    return withMethod(request, text(404, 'No published region covers this tile.', MANIFEST_TTL));
  }

  // Owned and empty (sea, fields) is a 204 — a fact about an immutable
  // archive, cached for a day. A tile goes out as the archive stores it,
  // gzipped, declared, and never re-encoded (`tiles.js`).
  const response = await serveArchiveTile({
    request,
    ctx,
    bucket: env.MAP_TILES,
    key: ref.key,
    z,
    x,
    y,
    cacheKey: `map/city/${encodeURIComponent(ref.key)}/${z}/${x}/${y}.pbf`,
    cacheSeconds: TILE_TTL,
    contentType: 'application/vnd.mapbox-vector-tile',
    publicHeaders: headers(TILE_TTL),
    missStatus: 204,
    what: 'city archive',
  });
  response.headers.append('server-timing', `manifest;dur=${manifestMs}`);
  return response;
}

/**
 * `/map/city/coverage.json`: what the client needs to choose a source per
 * tile — the union of every region's owned tiles at z14 — and the regions'
 * names and boxes, for people. The `archives` key the development route
 * answers with is deliberately absent: a client that only knows boxes then
 * sees no coverage and draws the basemap, rather than a region's bounding box
 * (which holds its neighbours) as if it were covered.
 */
export async function serveCityCoverage(request, env, ctx) {
  if (!configured(env)) {
    return withMethod(
      request,
      new Response(JSON.stringify({ schema: 2, regions: [], tiles: null }), {
        headers: headers(300, { 'content-type': 'application/json' }),
      }),
    );
  }
  let manifest;
  try {
    manifest = await loadManifest(env, ctx);
  } catch (error) {
    // Not a 200: the client reads any failure as "no coverage" and draws the basemap.
    return text(503, `The city manifest could not be read: ${error.message}`, 0);
  }
  const body = manifest.coverageBody;
  return withMethod(
    request,
    new Response(body, {
      headers: headers(MANIFEST_TTL, { 'content-type': 'application/json' }),
    }),
  );
}

/** `/map/city/manifest.json`: the manifest itself, the index of the published database. */
export async function serveCityManifest(request, env, ctx) {
  if (!configured(env))
    return withMethod(request, text(404, 'No city manifest is published.', 300));
  // Read, not remembered: the isolate keeps only the slim parse.
  let body;
  try {
    body = await manifestText(env, ctx);
  } catch (error) {
    return text(503, `The city manifest could not be read: ${error.message}`, 0);
  }
  return withMethod(
    request,
    new Response(body, {
      headers: headers(MANIFEST_TTL, { 'content-type': 'application/json' }),
    }),
  );
}

/**
 * `/map/city/data/<key>`: an archive or receipt the CURRENT manifest names,
 * streamed from R2, ranges honoured (a PMTiles archive is read by range, and
 * `pmtiles` tools can open this URL directly). Anything else is 404 — the
 * bucket also holds the basemap and every superseded build, and none of that
 * is offered here.
 */
export async function serveCityData(url, request, env, ctx) {
  const match = CITY_DATA_PATH.exec(url.pathname);
  const key = match ? match[1] : '';
  if (!CITY_ARCHIVE_KEY.test(key)) return text(404, 'Not a city archive.', 3600);
  if (!configured(env)) return text(404, 'No city archives are published.', 300);
  let manifest;
  try {
    manifest = await loadManifest(env, ctx);
  } catch (error) {
    return text(503, `The city manifest could not be read: ${error.message}`, 0);
  }
  if (!manifest.keys.has(key)) return text(404, 'Not an archive the current manifest names.', 300);

  const range = request.headers.get('range');
  const object =
    request.method === 'HEAD'
      ? await env.MAP_TILES.head(key)
      : await env.MAP_TILES.get(key, range ? { range: request.headers } : undefined);
  if (!object) return text(404, 'The archive is missing from the bucket.', 60);

  const receipt = key.endsWith('.receipt.json');
  const out = new Headers(
    headers(TILE_TTL, {
      'content-type': receipt ? 'application/json' : 'application/vnd.pmtiles',
      'accept-ranges': 'bytes',
      etag: object.httpEtag,
    }),
  );
  if (!receipt) {
    const name = key.replaceAll('/', '_');
    out.set('content-disposition', `attachment; filename="${name}"`);
  }
  if (request.method === 'HEAD') {
    out.set('content-length', String(object.size));
    return new Response(null, { headers: out });
  }
  if (range && object.range) {
    // R2 reports a range as {offset, length} or, for `bytes=-n`, {suffix}.
    const suffix = object.range.suffix;
    const offset = suffix !== undefined ? object.size - suffix : (object.range.offset ?? 0);
    const length = suffix !== undefined ? suffix : (object.range.length ?? object.size - offset);
    out.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    out.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers: out });
  }
  out.set('content-length', String(object.size));
  return new Response(object.body, { headers: out });
}

/** Route a request under `/map/city/` or `/map/city-roads/`. */
export async function serveCity(url, request, env, ctx) {
  if (url.pathname === '/map/city/coverage.json') return serveCityCoverage(request, env, ctx);
  if (url.pathname === '/map/city/manifest.json') return serveCityManifest(request, env, ctx);
  if (url.pathname.startsWith('/map/city/data/')) return serveCityData(url, request, env, ctx);
  return serveCityTile(url, request, env, ctx);
}

/** For tests: forget the per-isolate manifest. */
export function forgetCityManifest() {
  ownershipTrees.clear();
  memory.key = null;
  memory.at = 0;
  memory.value = null;
  memory.etag = null;
  memory.loading = null;
}
