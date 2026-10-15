/**
 * Raster SETS at the edge: per-cell PMTiles archives in R2, chosen per tile
 * by a manifest — the one implementation behind the satellite imagery
 * (`satellite.js`, `docs/MAP_SATELLITE.md`) and GoWay's own terrain
 * (`terrain.js`, `docs/MAP_TERRAIN_GLOBE.md` → "The archive").
 *
 * ## The model
 *
 * A family's rasters are published as SETS: one source (or a composite) at
 * one vintage, built for one or more zoom TIERS, cut into CELLS — the tiles
 * of one web-mercator zoom (`cellZoom`) — with one archive per cell:
 *
 *     <family>/<set>/<stamp>/<cellZoom>/<x>/<y>.pmtiles          (+ .receipt.json)
 *
 * The manifest lists the sets in PRIORITY order, each with the cells it holds
 * as a coverage tree (`coverageTree.js`), so the archive for a tile is
 * computed, not listed: a planet of cells is a few kilobytes of manifest. A
 * set rebuilt in part (a failed job, a new survey over one province) is a
 * second entry with the new stamp, listed first and holding only the cells it
 * rebuilt; the builder takes those cells out of the older entry
 * (`scripts/build-satellite-manifest.ts`), so a cell is answered by one stamp.
 *
 * ## One tile
 *
 * Every set built for the tier whose zooms include `z`, in manifest order,
 * whose cell holding the tile is published, is asked for it; the first that
 * has it answers. A tile wholly outside a set's footprint is simply absent
 * from its archive — the next set answers instead, or none (what then is the
 * family's: the tier below for imagery, the fallback terrain for terrain).
 * Each archive's answer for a tile, a tile or "absent", is cached at the edge
 * under the archive's key: archives are never overwritten, so that answer is
 * a fact.
 *
 * ## Off until configured
 *
 * The family's manifest variable names the manifest's key in `MAP_TILES`.
 * Unset, no set answers, the coverage document lists no sets, and no request
 * touches storage.
 *
 * ## The credit
 *
 * `<prefix>/coverage.json` tells the client which sets exist, which sources
 * each is made of and which cells it covers, so the map draws each source's
 * credit exactly while that source is on screen. `<prefix>/manifest.json` and
 * every receipt it names are public: what each archive was built from, with
 * which tool and when.
 */

import { compactCoverageAt, compactCoverageTree, FULL } from './coverageTree.js';
import {
  fromTileCacheEntry,
  newTimings,
  readTile,
  serverTiming,
  tileCacheEntry,
  tileResponse,
} from './tiles.js';

/** A set id: lower-case words joined by dashes. */
const SET_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A run's stamp: `YYYYMMDD` and an optional suffix (`-r12`, `-local`). */
const STAMP = /^[0-9]{8}(-[a-z0-9]{1,24})?$/;

const MANIFEST_SCHEMA = 1;
/** Seconds a tile may be kept by the edge and the browser: a day, as the basemap's. */
export const SET_TILE_TTL = 86400;
/** Seconds the manifest, and anything derived from it, may be kept. */
export const SET_MANIFEST_TTL = 300;

/** The image formats a set may be stored in, and their media types. */
const CONTENT_TYPES = { webp: 'image/webp', avif: 'image/avif' };

export function setHeaders(cacheSeconds, extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': `public, max-age=${cacheSeconds}`,
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

export function setText(status, body, cacheSeconds) {
  return new Response(body, {
    status,
    headers: setHeaders(cacheSeconds, { 'content-type': 'text/plain; charset=utf-8' }),
  });
}

export function withMethod(request, response) {
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

/**
 * One family of raster sets.
 *
 * @param {object} family
 * @param {string} family.name - the family's key prefix and word (`satellite`, `terrain`)
 * @param {string} family.prefix - its route (`/map/satellite`)
 * @param {string} family.manifestVariable - the env variable naming the manifest's key
 * @param {Record<string, {minZoom: number, maxZoom: number}>} family.tiers
 * @param {number} family.budgetBytes - the parsed manifest's line in `budget.js`
 */
export function createRasterSets(family) {
  const { name, prefix, manifestVariable, tiers, budgetBytes } = family;
  const receiptKey = new RegExp(
    `^${name}\\/([a-z0-9]+(?:-[a-z0-9]+)*)\\/([0-9]{8}(?:-[a-z0-9]{1,24})?)\\/(\\d{1,2})\\/(\\d{1,9})\\/(\\d{1,9})\\.pmtiles\\.receipt\\.json$`,
  );
  const dataPrefix = `${prefix}/data/`;

  /** The archive key of one cell of a set entry. */
  function cellArchiveKey(entry, x, y) {
    return `${name}/${entry.id}/${entry.stamp}/${entry.cellZoom}/${x}/${y}.pmtiles`;
  }

  /**
   * What a parsed manifest holds in the isolate, by the same accounting as
   * `budget.js`: the document text (UTF-16) kept to answer `/manifest.json`,
   * the compact cell trees, and a kilobyte of object overhead a set.
   */
  function manifestBytes(parsed, documentLength) {
    let bytes = documentLength * 2;
    for (const set of parsed.sets) bytes += set.tree.bytes + 1024;
    return bytes;
  }

  /**
   * Check a manifest document, refusing anything that is not exactly what the
   * builder writes: a wrong manifest silently serves the wrong rasters, or
   * none, for whole countries.
   */
  function parseManifest(document) {
    if (document?.schema !== MANIFEST_SCHEMA) throw new Error(`not a schema-1 ${name} manifest`);
    if (!Array.isArray(document.sets)) throw new Error('sets is not a list');
    const seen = new Set();
    const sets = document.sets.map((set) => {
      const where = `set ${set?.id}@${set?.stamp}`;
      if (typeof set?.id !== 'string' || !SET_ID.test(set.id)) throw new Error(`${where}: id`);
      if (typeof set.stamp !== 'string' || !STAMP.test(set.stamp))
        throw new Error(`${where}: stamp`);
      if (seen.has(`${set.id}@${set.stamp}`)) throw new Error(`${where}: listed twice`);
      seen.add(`${set.id}@${set.stamp}`);
      if (
        !Array.isArray(set.tiers) ||
        set.tiers.length === 0 ||
        !set.tiers.every((tier) => Object.hasOwn(tiers, tier))
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
        !set.tiers.some((tier) => tiers[tier].minZoom <= maxZoom && minZoom <= tiers[tier].maxZoom)
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
    const bytes = manifestBytes(parsed, JSON.stringify(document).length);
    if (bytes > budgetBytes) {
      throw new Error(
        `the ${name} manifest needs ~${bytes} B in the isolate, over its ${budgetBytes} B budget (budget.js)`,
      );
    }
    return parsed;
  }

  const memory = { key: null, at: 0, value: null };

  async function loadManifest(env, ctx) {
    const key = env[manifestVariable];
    const now = Date.now();
    if (memory.key === key && memory.value && now - memory.at < 60_000) return memory.value;

    const cacheKey = new Request(
      `https://goway.internal/${name}-manifest/${encodeURIComponent(key)}`,
    );
    const cache = caches.default;
    let body = null;
    const hit = await cache.match(cacheKey);
    if (hit) body = await hit.text();
    if (!body) {
      const object = await env.MAP_TILES.get(key);
      if (!object) throw new Error(`the ${name} manifest "${key}" is missing from the bucket`);
      body = await object.text();
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(body, {
            headers: { 'cache-control': `public, max-age=${SET_MANIFEST_TTL}` },
          }),
        ),
      );
    }
    const value = { ...parseManifest(JSON.parse(body)), body };
    // Released before the next parse is kept: one manifest at a time.
    memory.value = null;
    memory.key = key;
    memory.at = now;
    memory.value = value;
    return value;
  }

  function configured(env) {
    return Boolean(env.MAP_TILES && env[manifestVariable]);
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
  function candidatesFor(manifest, tier, z, x, y) {
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
      `https://goway.internal/tiles/v2/${name}/${encodeURIComponent(key)}/${z}/${x}/${y}`,
    );
    const started = Date.now();
    const hit = await cache.match(cacheRequest);
    timings.cache += 1;
    timings.cacheMs += Date.now() - started;
    if (hit) return (await fromTileCacheEntry(hit)).tile;
    const tile = await readTile(env.MAP_TILES, key, ctx, timings, z, x, y);
    ctx.waitUntil(cache.put(cacheRequest, tileCacheEntry(tile, SET_TILE_TTL, 404)));
    return tile;
  }

  /**
   * The published tile (tier, z, x, y) as a response, or `null` when no set
   * has it (or none is configured): the caller decides what that means. A
   * storage or manifest failure is a 502, never a silent `null`.
   */
  async function setTile(request, env, ctx, tier, z, x, y) {
    if (!configured(env)) return null;
    let manifest;
    try {
      manifest = await loadManifest(env, ctx);
    } catch (error) {
      return setText(502, `The ${name} manifest could not be read: ${error.message}`, 0);
    }
    const timings = newTimings();
    for (const { entry, key } of candidatesFor(manifest, tier, z, x, y)) {
      let tile;
      try {
        tile = await archiveTile(env, ctx, timings, key, z, x, y);
      } catch (error) {
        return setText(502, `The ${name} archive could not be read: ${error.message}`, 0);
      }
      if (!tile) continue;
      // Images are stored as they are (`tileCompression: NONE`, the codec is the
      // compression): `tileResponse` sends them with no Content-Encoding, the
      // same bytes for every client (`check:worker-wire` holds it to that).
      const out = new Headers(setHeaders(SET_TILE_TTL, { 'content-type': entry.contentType }));
      out.set('server-timing', serverTiming(timings, 'tile'));
      return tileResponse(tile, request, out);
    }
    return null;
  }

  /**
   * `<prefix>/coverage.json`: what the client needs to draw each source's
   * credit while it is on screen — the sets, their tiers, zooms, sources and
   * cells — and nothing about storage.
   */
  async function serveCoverage(request, env, ctx) {
    const json = (body, status = 200, ttl = SET_MANIFEST_TTL) =>
      withMethod(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: setHeaders(ttl, { 'content-type': 'application/json' }),
        }),
      );
    if (!configured(env)) return json({ schema: 1, sets: [] }, 200, 300);
    let manifest;
    try {
      manifest = await loadManifest(env, ctx);
    } catch (error) {
      return setText(503, `The ${name} manifest could not be read: ${error.message}`, 0);
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
      manifest: `${prefix}/manifest.json`,
    });
  }

  /** `<prefix>/manifest.json`. */
  async function serveManifest(request, env, ctx) {
    if (!configured(env))
      return withMethod(request, setText(404, `No ${name} manifest is published.`, 300));
    let manifest;
    try {
      manifest = await loadManifest(env, ctx);
    } catch (error) {
      return setText(503, `The ${name} manifest could not be read: ${error.message}`, 0);
    }
    return withMethod(
      request,
      new Response(manifest.body, {
        headers: setHeaders(SET_MANIFEST_TTL, { 'content-type': 'application/json' }),
      }),
    );
  }

  /**
   * `<prefix>/data/<receipt key>`: a cell's receipt, when the CURRENT manifest
   * publishes that cell. The archives themselves are not offered here (their
   * tiles are); nothing else in the bucket is reachable.
   */
  async function serveData(url, request, env, ctx) {
    const key = url.pathname.startsWith(dataPrefix) ? url.pathname.slice(dataPrefix.length) : '';
    const parts = receiptKey.exec(key);
    if (!parts) return setText(404, `Not a ${name} receipt.`, 3600);
    if (!configured(env)) return setText(404, `No ${name} sets are published.`, 300);
    let manifest;
    try {
      manifest = await loadManifest(env, ctx);
    } catch (error) {
      return setText(503, `The ${name} manifest could not be read: ${error.message}`, 0);
    }
    const [, id, stamp, cz, cx, cy] = parts;
    const entry = manifest.sets.find((set) => set.id === id && set.stamp === stamp);
    const z = Number(cz);
    const published =
      entry !== undefined &&
      entry.cellZoom === z &&
      compactCoverageAt(entry.tree, z, Number(cx), Number(cy)) === FULL;
    if (!published) return setText(404, 'Not a receipt the current manifest names.', 300);
    const object = await env.MAP_TILES.get(key);
    if (!object) return setText(404, 'The receipt is missing from the bucket.', 60);
    return withMethod(
      request,
      new Response(object.body, {
        headers: setHeaders(SET_TILE_TTL, { 'content-type': 'application/json' }),
      }),
    );
  }

  /** The documents under the prefix (`coverage.json`, `manifest.json`, `data/…`), or `null` for anything else. */
  function serveDocument(url, request, env, ctx) {
    if (url.pathname === `${prefix}/coverage.json`) return serveCoverage(request, env, ctx);
    if (url.pathname === `${prefix}/manifest.json`) return serveManifest(request, env, ctx);
    if (url.pathname.startsWith(dataPrefix)) return serveData(url, request, env, ctx);
    return null;
  }

  /** For tests and the development route: forget the per-isolate manifest. */
  function forgetManifest() {
    memory.key = null;
    memory.at = 0;
    memory.value = null;
  }

  return {
    cellArchiveKey,
    parseManifest,
    manifestBytes,
    candidatesFor,
    configured,
    setTile,
    serveDocument,
    forgetManifest,
  };
}
