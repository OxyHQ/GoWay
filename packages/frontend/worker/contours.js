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

export const CONTOUR_PATH = /^\/map\/contours\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.pbf$/;

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
    cacheSize: 64,
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
    /** The contour tile's MVT bytes; empty where nothing crosses a level. */
    async tile(z, x, y) {
      const levels = CONTOUR_LEVELS[z];
      if (!levels) return new Uint8Array(0);
      const result = await manager.fetchContourTile(
        z,
        x,
        y,
        {
          levels,
          overzoom: 1,
          elevationKey: 'ele',
          levelKey: 'level',
          contourLayer: 'contours',
          extent: 4096,
          buffer: 1,
        },
        new AbortController(),
      );
      return new Uint8Array(result.arrayBuffer);
    },
  };
}

/** Parse a contour path into a tile, or `null` when it is not one GoWay makes. */
export function contourTileOf(pathname) {
  const match = CONTOUR_PATH.exec(pathname);
  if (!match) return null;
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (z < CONTOUR_ZOOMS.min || z > CONTOUR_ZOOMS.max) return null;
  const span = 2 ** z;
  if (x >= span || y >= span) return null;
  return { z, x, y };
}

/**
 * The route. `service` is made once per isolate by `index.js` (its DEM seam
 * is the terrain route); the edge cache keys on the DEM archive, so a new
 * archive is a new set of contour tiles and an old one is never served for it.
 */
export async function serveContours(url, request, env, ctx, service, headersFor) {
  const tile = contourTileOf(url.pathname);
  if (!tile) {
    return new Response('Not a contour tile GoWay makes (z9–14).', {
      status: 404,
      headers: { ...headersFor(0), 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const archive = env.MAP_TERRAIN_ARCHIVE || 'upstream';
  const cacheKey = new Request(
    `https://goway.internal/map/contours/${encodeURIComponent(archive)}/${tile.z}/${tile.x}/${tile.y}.pbf`,
  );
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
