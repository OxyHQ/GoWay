/**
 * `/map/contours/{z}/{x}/{y}.pbf` — contour lines, generated at the edge from
 * GoWay's own elevation tiles, and cached there for good
 * (`docs/MAP_STYLES.md` → Contours).
 *
 * ## Why here, and not in the browser or a batch job
 *
 * The Outdoors style wants contours and the OpenMapTiles schema has none. Three
 * places could make them:
 *
 *  - **The browser** (maplibre-contour's protocol in a web worker): every phone
 *    would download nine DEM tiles per contour tile and spend its own CPU and
 *    battery tracing isolines — and MapLibre Native has no protocol hook, so
 *    the native app and every integrator loading the style URL would have no
 *    contours at all.
 *  - **A planet batch** (contour vector tiles from the 356 GB DEM, z9–14): the
 *    same tiles for everyone, but a multi-day job, hundreds of GB stored, and a
 *    rebuild for every DEM update — for tiles most of which nobody looks at.
 *  - **Here, on demand**: the first request for a tile makes it (≈ nine DEM
 *    tiles fetched from the archive or the edge cache, decoded, traced,
 *    encoded), every later one is an edge-cache hit. One URL for web, native
 *    and integrators; zero work on the device; storage only for what is seen.
 *
 * The tracing is maplibre-contour's (`LocalDemManager`: the same marching
 * squares, neighbour stitching and vector-tile encoding its browser protocol
 * runs), handed GoWay's DEM through {@link createContourService}'s two seams:
 * where a DEM tile comes from (`serveTerrain`, so the archive-or-upstream rule
 * is the terrain route's own) and how a WebP is decoded (`webpDecode.js`, a
 * WebAssembly libwebp: a Worker has no image decoder).
 *
 * ## What a tile holds
 *
 * One source-layer, `contours`: lines with `ele` (metres) and `level` (1 on an
 * index contour, 0 otherwise), at the interval for its zoom
 * ({@link CONTOUR_LEVELS}). Contour tiles exist from z9 to z14; MapLibre
 * over-zooms z14 above it. The DEM stops at z12 (Copernicus GLO-30 worldwide),
 * so z13 and z14 trace the same data finer, which is what keeps a 10 m line
 * smooth at street zoom.
 */
import mlcontour from 'maplibre-contour';
import { MEMORY_BUDGET } from './budget.js';
import { CONTOUR_VERSION } from './contourVersion.js';

export { CONTOUR_VERSION };

/** `/map/contours/<version>/{z}/{x}/{y}.pbf`; only {@link CONTOUR_VERSION} is served. */
export const CONTOUR_PATH = /^\/map\/contours\/(v\d{1,3})\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.pbf$/;

/**
 * The contour interval per zoom, in metres: `[every line, every index line]`.
 * Chosen so a mountainside reads as terrain and not as a hatching at each
 * zoom: at z12 a 50 m line is about 12 px apart on a 30° slope.
 */
export const CONTOUR_LEVELS = {
  9: [200, 1000],
  10: [200, 1000],
  11: [100, 500],
  12: [50, 250],
  13: [20, 100],
  14: [10, 50],
};

/** The zooms contour tiles are made at (an object, not two numbers: see `index.js`'s export note). */
export const CONTOUR_ZOOMS = { min: 9, max: 14 };

/** The elevation tiles' own limits (`lib/map/style/relief.ts` → `RELIEF_DEM`). */
const DEM = { maxzoom: 12, encoding: 'terrarium', tileSize: 512 };

/** The tracer's options for every tile (the levels are {@link CONTOUR_LEVELS}). */
const TRACE = {
  overzoom: 1,
  elevationKey: 'ele',
  levelKey: 'level',
  contourLayer: 'contours',
  extent: 4096,
  buffer: 1,
};

/** The tracer, by package and version: a new release can trace differently. */
export const CONTOUR_TRACER = 'maplibre-contour@0.1.1';

/**
 * Everything a tile's bytes depend on besides the DEM — what
 * {@link CONTOUR_VERSION} stands for. The test fingerprints it.
 */
export const CONTOUR_PARAMETERS = { levels: CONTOUR_LEVELS, trace: TRACE, dem: DEM, tracer: CONTOUR_TRACER };

/**
 * What one entry of maplibre-contour's caches can hold: it keeps the WebP, the
 * decoded heights (512² Float32 = 1 MiB) and the traced tile, each in its own
 * cache of `cacheSize` entries. Bounded by {@link MEMORY_BUDGET}.contours — the
 * library's default of 100 (and the 64 this used) held ~200 MiB after one
 * reader panned the Alps, past the isolate's 128 MB, taking every map route in
 * the isolate down with it.
 */
export const CONTOUR_ENTRY_BYTES = Math.ceil(1.8 * 1024 * 1024);

/** Entries per cache: a tile's 3×3 DEM neighbourhood (9) fits, the isolate does too. */
export const CONTOUR_CACHE_ENTRIES = Math.floor(MEMORY_BUDGET.contours / CONTOUR_ENTRY_BYTES);

/** A day at the edge for a miss, a year for a tile: contours change only with the DEM archive. */
const CONTOUR_TTL_SECONDS = 31_536_000;

/**
 * The contour maker, with its two seams injected so tests and the local
 * server run the same code as the edge.
 *
 * @param {object} deps
 * @param {(z: number, x: number, y: number) => Promise<Uint8Array | null>} deps.fetchDem
 *   the Terrarium WebP for a DEM tile, or `null` where the DEM has none (sea)
 * @param {(bytes: Uint8Array) => Promise<{ width: number, height: number, data: Uint8Array | Uint8ClampedArray }>} deps.decode
 *   RGBA pixels of a WebP
 */
export function createContourService({ fetchDem, decode }) {
  const manager = new mlcontour.LocalDemManager({
    demUrlPattern: 'dem://{z}/{x}/{y}',
    cacheSize: CONTOUR_CACHE_ENTRIES,
    encoding: DEM.encoding,
    maxzoom: DEM.maxzoom,
    timeoutMs: 20_000,
    // The DEM bytes, as the manager's fetch would hand them over.
    getTile: async (url) => {
      const [z, x, y] = url.slice('dem://'.length).split('/').map(Number);
      const bytes = await fetchDem(z, x, y);
      return { data: new Blob(bytes ? [bytes] : []) };
    },
    // No DEM there (open sea) is sea level, at the DEM's own size: the
    // tracer stitches a tile to its neighbours by the middle tile's width.
    decodeImage: async (blob, encoding) => {
      if (blob.size === 0) {
        return {
          width: DEM.tileSize,
          height: DEM.tileSize,
          data: new Float32Array(DEM.tileSize ** 2),
        };
      }
      const image = await decode(new Uint8Array(await blob.arrayBuffer()));
      return mlcontour.decodeParsedImage(image.width, image.height, encoding, image.data);
    },
  });

  return {
    /** Entries each of the manager's three caches holds now (the budget's test seam). */
    held() {
      return [manager.tileCache.size(), manager.parsedCache.size(), manager.contourCache.size()];
    },
    /** The contour tile's MVT bytes; empty where nothing crosses a level. */
    async tile(z, x, y) {
      const levels = CONTOUR_LEVELS[z];
      if (!levels) return new Uint8Array(0);
      const result = await manager.fetchContourTile(
        z,
        x,
        y,
        { levels, ...TRACE },
        new AbortController(),
      );
      return new Uint8Array(result.arrayBuffer);
    },
  };
}

/** Parse a contour path into a tile, or `null` when it is not one GoWay makes. */
export function contourTileOf(pathname) {
  const match = CONTOUR_PATH.exec(pathname);
  if (!match || match[1] !== CONTOUR_VERSION) return null;
  const z = Number(match[2]);
  const x = Number(match[3]);
  const y = Number(match[4]);
  if (z < CONTOUR_ZOOMS.min || z > CONTOUR_ZOOMS.max) return null;
  const span = 2 ** z;
  if (x >= span || y >= span) return null;
  return { z, x, y };
}

/**
 * Where the DEM a contour tile is traced from lives, for the cache key: GoWay's
 * own elevation archive in R2, by its key (keys are dated and never
 * overwritten, so a new archive is a new key). `null` when this deployment has
 * none — and then no contour is made at all: tracing from the upstream proxy
 * would let any client fan nine fetches out to a public endpoint per miss.
 */
export function contourDemSource(env) {
  return env.MAP_TILES && env.MAP_TERRAIN_ARCHIVE ? `r2/${env.MAP_TERRAIN_ARCHIVE}` : null;
}

/** The edge cache's key for a tile: the version, the DEM it was traced from, the tile. */
export function contourCacheKey(tile, demSource) {
  return `https://goway.internal/map/contours/${CONTOUR_VERSION}/${encodeURIComponent(demSource)}/${tile.z}/${tile.x}/${tile.y}.pbf`;
}

/**
 * The route. `service` is made per isolate and per DEM archive by `index.js`
 * (its DEM seam is the terrain route's R2 reader); the edge cache keys on the
 * contour version and the DEM archive, so neither a new tracer nor a new
 * archive is ever answered with an old tile.
 */
export async function serveContours(url, request, env, ctx, service, headersFor) {
  const tile = contourTileOf(url.pathname);
  if (!tile) {
    return new Response(`Not a contour tile GoWay makes (${CONTOUR_VERSION}, z9–14).`, {
      status: 404,
      headers: { ...headersFor(0), 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const demSource = contourDemSource(env);
  if (!demSource) {
    return new Response(
      "Contours are traced only from GoWay's own elevation archive in R2 (MAP_TILES + " +
        'MAP_TERRAIN_ARCHIVE), which this deployment does not have.',
      {
        status: 503,
        headers: { ...headersFor(0), 'content-type': 'text/plain; charset=utf-8' },
      },
    );
  }
  const cacheKey = new Request(contourCacheKey(tile, demSource));
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const hit = cache ? await cache.match(cacheKey) : undefined;
  if (hit) {
    return request.method === 'HEAD'
      ? new Response(null, { status: hit.status, headers: hit.headers })
      : hit;
  }
  let bytes;
  try {
    bytes = await service.tile(tile.z, tile.x, tile.y);
  } catch (error) {
    return new Response(`Contours could not be made: ${error?.message ?? error}`, {
      status: 502,
      headers: { ...headersFor(0), 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const headers = new Headers(headersFor(CONTOUR_TTL_SECONDS));
  headers.set('content-type', 'application/x-protobuf');
  headers.set('content-length', String(bytes.length));
  const response = new Response(bytes, { headers });
  if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return request.method === 'HEAD' ? new Response(null, { headers }) : response;
}
