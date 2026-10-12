/**
 * Satellite imagery at the edge: `/map/satellite/*`, out of per-cell PMTiles
 * archives in R2, chosen per tile by a manifest (`docs/MAP_SATELLITE.md`).
 *
 * ## The model
 *
 * Imagery is published as SETS: one source (or a composite of sources) at one
 * vintage, built for one or more zoom TIERS (`lib/map/imagery.ts`: `base`
 * z0–13, `detail` z12–18, `fine` z19–20), cut into CELLS — the tiles of one
 * web-mercator zoom (`cellZoom`) — with one archive per cell:
 *
 *     satellite/<set>/<stamp>/<cellZoom>/<x>/<y>.pmtiles          (+ .receipt.json)
 *
 * The manifest lists the sets in PRIORITY order, each with the cells it holds
 * as a coverage tree (`coverageTree.js`), so the archive for a tile is
 * computed, not listed: a planet of cells is a few kilobytes of manifest. A
 * set rebuilt in part (a failed job, a new flight over one province) is a
 * second entry with the new stamp, listed first and holding only the cells it
 * rebuilt; the builder takes those cells out of the older entry
 * (`scripts/build-satellite-manifest.ts`), so a cell is answered by one stamp.
 *
 * ## One tile
 *
 * For `/map/satellite/<tier>/<z>/<x>/<y>.webp`: every set built for that tier
 * whose zooms include `z`, in manifest order, whose cell holding the tile is
 * published, is asked for it; the first that has it answers. An orthophoto's
 * edge is transparent, and a tile wholly outside its footprint is simply
 * absent from the archive — the next set (or nothing, and the tier below
 * shows through) answers instead. Each archive's answer for a tile, a tile or
 * "absent", is cached at the edge under the archive's key: archives are never
 * overwritten, so that answer is a fact.
 *
 * | Answer | Meaning |
 * | --- | --- |
 * | 200 | the tile (WebP; the stored bytes, never re-encoded) |
 * | 404 | no published set has it: the client draws the tier below |
 *
 * ## Off until configured
 *
 * `MAP_SATELLITE_MANIFEST` names the manifest's key in `MAP_TILES`. Unset,
 * every tile is 404, the coverage document lists no sets (so a style picker
 * offers no imagery) and no request touches storage.
 *
 * ## The credit
 *
 * `/map/satellite/coverage.json` tells the client which sets exist, which
 * sources each is made of and which cells it covers, so the map draws each
 * source's credit exactly while that source is on screen (`MapAttribution`).
 * `/map/satellite/manifest.json` and every receipt it names are public: what
 * each archive was built from, with which tool and when.
 */

import { MEMORY_BUDGET } from './budget.js';
import { compactCoverageAt, compactCoverageTree, FULL } from './coverageTree.js';
import {
  fromTileCacheEntry,
  newTimings,
  readTile,
  serverTiming,
  tileCacheEntry,
  tileResponse,
} from './tiles.js';

/** The tiers by zoom — `IMAGERY_TIERS` in `lib/map/imagery.ts`, pinned equal by a test. */
const TIERS = {
  base: { minZoom: 0, maxZoom: 13 },
  detail: { minZoom: 12, maxZoom: 18 },
  fine: { minZoom: 19, maxZoom: 20 },
};

const TILE_PATH = /^\/map\/satellite\/(base|detail|fine)\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.webp$/;
const DATA_PATH = /^\/map\/satellite\/data\/(.+)$/;

/** A set id: lower-case words joined by dashes. */
const SET_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A run's stamp: `YYYYMMDD` and an optional suffix (`-r12`, `-local`). */
const STAMP = /^[0-9]{8}(-[a-z0-9]{1,24})?$/;
/** A cell receipt key, exactly as the builder writes it. */
const RECEIPT_KEY =
  /^satellite\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([0-9]{8}(?:-[a-z0-9]{1,24})?)\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.pmtiles\.receipt\.json$/;

const MANIFEST_SCHEMA = 1;
/** Seconds a tile may be kept by the edge and the browser: a day, as the basemap's. */
const TILE_TTL = 86400;
/** Seconds the manifest, and anything derived from it, may be kept. */
const MANIFEST_TTL = 300;

/** The image formats a set may be stored in, and their media types. */
const CONTENT_TYPES = { webp: 'image/webp', avif: 'image/avif' };

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

/** The archive key of one cell of a set entry. */
export function cellArchiveKey(entry, x, y) {
  return `satellite/${entry.id}/${entry.stamp}/${entry.cellZoom}/${x}/${y}.pmtiles`;
}

/**
 * Check a manifest document, refusing anything that is not exactly what the
 * builder writes: a wrong manifest silently serves the wrong imagery, or
 * none, for whole countries.
 */
export function parseSatelliteManifest(document) {
  if (document?.schema !== MANIFEST_SCHEMA) throw new Error('not a schema-1 satellite manifest');
  if (!Array.isArray(document.sets)) throw new Error('sets is not a list');
  const seen = new Set();
  const sets = document.sets.map((set) => {
    const where = `set ${set?.id}@${set?.stamp}`;
    if (typeof set?.id !== 'string' || !SET_ID.test(set.id)) throw new Error(`${where}: id`);
    if (typeof set.stamp !== 'string' || !STAMP.test(set.stamp)) throw new Error(`${where}: stamp`);
    if (seen.has(`${set.id}@${set.stamp}`)) throw new Error(`${where}: listed twice`);
    seen.add(`${set.id}@${set.stamp}`);
    if (
      !Array.isArray(set.tiers) ||
      set.tiers.length === 0 ||
      !set.tiers.every((tier) => Object.hasOwn(TIERS, tier))
    ) {
      throw new Error(`${where}: tiers`);
    }
    const { minZoom, maxZoom, cellZoom } = set;
    if (
      ![minZoom, maxZoom, cellZoom].every((v) => Number.isInteger(v) && v >= 0 && v <= 24) ||
      minZoom > maxZoom ||
      cellZoom > minZoom
    ) {
      throw new Error(`${where}: zooms (cellZoom ≤ minZoom ≤ maxZoom)`);
    }
    if (
      !set.tiers.some((tier) => TIERS[tier].minZoom <= maxZoom && minZoom <= TIERS[tier].maxZoom)
    ) {
      throw new Error(`${where}: no tier overlaps its zooms`);
    }
    if (
      !Array.isArray(set.sources) ||
      set.sources.length === 0 ||
      !set.sources.every((s) => typeof s === 'string' && SET_ID.test(s))
    ) {
      throw new Error(`${where}: sources`);
    }
    const bbox = set.bbox;
    if (
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
      !(bbox[0] < bbox[2] && bbox[1] < bbox[3])
    ) {
      throw new Error(`${where}: bbox`);
    }
    if (set.cells?.maxZoom !== cellZoom || typeof set.cells.bits !== 'string') {
      throw new Error(`${where}: cells is not a z${cellZoom} coverage tree`);
    }
    if (!Object.hasOwn(CONTENT_TYPES, set.format)) throw new Error(`${where}: format`);
    return {
      id: set.id,
      stamp: set.stamp,
      tiers: set.tiers,
      minZoom,
      maxZoom,
      cellZoom,
      sources: set.sources,
      vintage: set.vintage,
      bbox,
      cells: set.cells,
      contentType: CONTENT_TYPES[set.format],
      // Compact (5 B a node), decoded once per manifest: the planet's 19,174
      // WorldCover cells are a few thousand nodes.
      tree: compactCoverageTree(set.cells),
    };
  });
  const parsed = { document, sets };
  const bytes = satelliteManifestBytes(parsed, JSON.stringify(document).length);
  if (bytes > MEMORY_BUDGET.satellite) {
    throw new Error(
      `the satellite manifest needs ~${bytes} B in the isolate, over its ${MEMORY_BUDGET.satellite} B budget (budget.js)`,
    );
  }
  return parsed;
}

/**
 * What a parsed manifest holds in the isolate, by the same accounting as
 * `budget.js`: the document text (UTF-16) kept to answer `/manifest.json`, the
 * compact cell trees, and a kilobyte of object overhead a set.
 */
export function satelliteManifestBytes(parsed, documentLength) {
  let bytes = documentLength * 2;
  for (const set of parsed.sets) bytes += set.tree.bytes + 1024;
  return bytes;
}

const memory = { key: null, at: 0, value: null };

async function loadManifest(env, ctx) {
  const key = env.MAP_SATELLITE_MANIFEST;
  const now = Date.now();
  if (memory.key === key && memory.value && now - memory.at < 60_000) return memory.value;

  const cacheKey = new Request(
    `https://goway.internal/satellite-manifest/${encodeURIComponent(key)}`,
  );
  const cache = caches.default;
  let body = null;
  const hit = await cache.match(cacheKey);
  if (hit) body = await hit.text();
  if (!body) {
    const object = await env.MAP_TILES.get(key);
    if (!object) throw new Error(`the satellite manifest "${key}" is missing from the bucket`);
    body = await object.text();
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(body, { headers: { 'cache-control': `public, max-age=${MANIFEST_TTL}` } }),
      ),
    );
  }
  const value = { ...parseSatelliteManifest(JSON.parse(body)), body };
  // Released before the next parse is kept: one manifest at a time.
  memory.value = null;
  memory.key = key;
  memory.at = now;
  memory.value = value;
  return value;
}

function configured(env) {
  return Boolean(env.MAP_TILES && env.MAP_SATELLITE_MANIFEST);
}

/** Does this entry publish the cell holding tile (z, x, y)? Returns the cell, or null. */
function cellOf(entry, z, x, y) {
  if (z < entry.minZoom || z > entry.maxZoom) return null;
  const shift = z - entry.cellZoom;
  const cx = Math.floor(x / 2 ** shift);
  const cy = Math.floor(y / 2 ** shift);
  return compactCoverageAt(entry.tree, entry.cellZoom, cx, cy) === FULL ? { x: cx, y: cy } : null;
}

/** The sets, in priority order, that may hold tile (tier, z, x, y), with their archive keys. */
export function candidatesFor(manifest, tier, z, x, y) {
  const out = [];
  for (const entry of manifest.sets) {
    if (!entry.tiers.includes(tier)) continue;
    const cell = cellOf(entry, z, x, y);
    if (cell) out.push({ entry, key: cellArchiveKey(entry, cell.x, cell.y) });
  }
  return out;
}

/**
 * One archive's answer for one tile — `{ bytes, compression }` or `null` —
 * through the edge cache, in `tiles.js`'s entry form (the stored bytes,
 * opaque). Both answers are cached: an archive key is never rewritten.
 */
async function archiveTile(env, ctx, timings, key, z, x, y) {
  const cache = caches.default;
  const cacheRequest = new Request(
    `https://goway.internal/tiles/v2/satellite/${encodeURIComponent(key)}/${z}/${x}/${y}`,
  );
  const started = Date.now();
  const hit = await cache.match(cacheRequest);
  timings.cache += 1;
  timings.cacheMs += Date.now() - started;
  if (hit) return (await fromTileCacheEntry(hit)).tile;
  const tile = await readTile(env.MAP_TILES, key, ctx, timings, z, x, y);
  ctx.waitUntil(cache.put(cacheRequest, tileCacheEntry(tile, TILE_TTL, 404)));
  return tile;
}

/** `/map/satellite/<tier>/<z>/<x>/<y>.webp`. */
export async function serveSatelliteTile(url, request, env, ctx) {
  const match = TILE_PATH.exec(url.pathname);
  if (!match) return text(404, 'Not a satellite tile path.', 3600);
  const tier = match[1];
  const z = Number(match[2]);
  const x = Number(match[3]);
  const y = Number(match[4]);
  // Refused before storage is touched: outside the tier's zooms or the world.
  if (z < TIERS[tier].minZoom || z > TIERS[tier].maxZoom) {
    return text(
      404,
      `The ${tier} tier has zooms ${TIERS[tier].minZoom}–${TIERS[tier].maxZoom}.`,
      86400,
    );
  }
  const span = 2 ** z;
  if (x >= span || y >= span) return text(404, 'Tile coordinate outside the world.', 86400);
  if (!configured(env)) {
    return withMethod(
      request,
      text(404, 'Satellite imagery is not served by this deployment.', 300),
    );
  }

  let manifest;
  try {
    manifest = await loadManifest(env, ctx);
  } catch (error) {
    return text(502, `The satellite manifest could not be read: ${error.message}`, 0);
  }
  const timings = newTimings();
  for (const { entry, key } of candidatesFor(manifest, tier, z, x, y)) {
    let tile;
    try {
      tile = await archiveTile(env, ctx, timings, key, z, x, y);
    } catch (error) {
      return text(502, `The imagery archive could not be read: ${error.message}`, 0);
    }
    if (!tile) continue;
    // Images are stored as they are (`tileCompression: NONE`, the codec is the
    // compression): `tileResponse` sends them with no Content-Encoding, the
    // same bytes for every client (`check:worker-wire` holds it to that).
    const out = new Headers(headers(TILE_TTL, { 'content-type': entry.contentType }));
    out.set('server-timing', serverTiming(timings, 'tile'));
    return tileResponse(tile, request, out);
  }
  // Nothing published has it: the tier below shows through. Short-lived,
  // because the next manifest may publish it.
  return withMethod(request, text(404, 'No published imagery has this tile.', MANIFEST_TTL));
}

/**
 * `/map/satellite/coverage.json`: what the client needs to draw each source's
 * credit while it is on screen — the sets, their tiers, zooms, sources and
 * cells — and nothing about storage.
 */
export async function serveSatelliteCoverage(request, env, ctx) {
  const json = (body, status = 200, ttl = MANIFEST_TTL) =>
    withMethod(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: headers(ttl, { 'content-type': 'application/json' }),
      }),
    );
  if (!configured(env)) return json({ schema: 1, sets: [] }, 200, 300);
  let manifest;
  try {
    manifest = await loadManifest(env, ctx);
  } catch (error) {
    return text(503, `The satellite manifest could not be read: ${error.message}`, 0);
  }
  return json({
    schema: 1,
    generatedAt: manifest.document.generatedAt,
    sets: manifest.sets.map((set) => ({
      id: set.id,
      tiers: set.tiers,
      minZoom: set.minZoom,
      maxZoom: set.maxZoom,
      sources: set.sources,
      vintage: set.vintage,
      bbox: set.bbox,
      cells: set.cells,
    })),
    manifest: '/map/satellite/manifest.json',
  });
}

/** `/map/satellite/manifest.json`. */
export async function serveSatelliteManifest(request, env, ctx) {
  if (!configured(env))
    return withMethod(request, text(404, 'No satellite manifest is published.', 300));
  let manifest;
  try {
    manifest = await loadManifest(env, ctx);
  } catch (error) {
    return text(503, `The satellite manifest could not be read: ${error.message}`, 0);
  }
  return withMethod(
    request,
    new Response(manifest.body, {
      headers: headers(MANIFEST_TTL, { 'content-type': 'application/json' }),
    }),
  );
}

/**
 * `/map/satellite/data/<receipt key>`: a cell's receipt, when the CURRENT
 * manifest publishes that cell. The archives themselves are not offered here
 * (their tiles are, above); nothing else in the bucket is reachable.
 */
export async function serveSatelliteData(url, request, env, ctx) {
  const match = DATA_PATH.exec(url.pathname);
  const key = match ? match[1] : '';
  const parts = RECEIPT_KEY.exec(key);
  if (!parts) return text(404, 'Not a satellite receipt.', 3600);
  if (!configured(env)) return text(404, 'No satellite imagery is published.', 300);
  let manifest;
  try {
    manifest = await loadManifest(env, ctx);
  } catch (error) {
    return text(503, `The satellite manifest could not be read: ${error.message}`, 0);
  }
  const [, id, stamp, cz, cx, cy] = parts;
  const entry = manifest.sets.find((set) => set.id === id && set.stamp === stamp);
  const z = Number(cz);
  const published =
    entry !== undefined &&
    entry.cellZoom === z &&
    compactCoverageAt(entry.tree, z, Number(cx), Number(cy)) === FULL;
  if (!published) return text(404, 'Not a receipt the current manifest names.', 300);
  const object = await env.MAP_TILES.get(key);
  if (!object) return text(404, 'The receipt is missing from the bucket.', 60);
  return withMethod(
    request,
    new Response(object.body, {
      headers: headers(TILE_TTL, { 'content-type': 'application/json' }),
    }),
  );
}

/** Route a request under `/map/satellite/`. */
export async function serveSatellite(url, request, env, ctx) {
  if (url.pathname === '/map/satellite/coverage.json')
    return serveSatelliteCoverage(request, env, ctx);
  if (url.pathname === '/map/satellite/manifest.json')
    return serveSatelliteManifest(request, env, ctx);
  if (url.pathname.startsWith('/map/satellite/data/'))
    return serveSatelliteData(url, request, env, ctx);
  return serveSatelliteTile(url, request, env, ctx);
}

/** For tests and the development route: forget the per-isolate manifest. */
export function forgetSatelliteManifest() {
  memory.key = null;
  memory.at = 0;
  memory.value = null;
}

/** For the test that pins these to `lib/map/imagery.ts`. */
export function satelliteTiers() {
  return TIERS;
}
