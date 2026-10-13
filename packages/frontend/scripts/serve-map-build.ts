/**
 * Serve a PRODUCTION web export of the map, with the city and road archives,
 * so the benchmark (`scripts/bench-map.ts`) measures what users run — React in
 * production mode, minified bundles, no development HUD — instead of the dev
 * server (`docs/MAP_PERFORMANCE.md` → "The benchmark").
 *
 *   EXPO_PUBLIC_GOWAY_FIXTURES=1 bunx expo export --platform web --output-dir dist-bench
 *   GOWAY_CITY_TILES_ARCHIVE=… bun scripts/serve-map-build.ts --dir=dist-bench --port=8119
 *
 * The tiles are answered by the same middleware the dev server uses
 * (`dev-city-tiles.js`, and through it the Worker's own PMTiles reader); every
 * other path is a file of the export, and an unknown one is the SPA's
 * `index.html`, as the production Worker answers it.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const { withDevCityTiles } = require('./dev-city-tiles') as {
  withDevCityTiles: (config: object) => {
    server?: {
      enhanceMiddleware?: (
        middleware: Handler,
        server: unknown,
      ) => (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
    };
  };
};

type Handler = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pbf': 'application/x-protobuf',
  '.glb': 'model/gltf-binary',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const root = normalize(arg('dir', 'dist'));
const port = Number(arg('port', '8119'));
/**
 * `--upstream=https://goway.to`: every `/map/…` and `/landmarks/…` path the
 * export does not hold (terrain, the city coverage, city and road tiles) is
 * fetched from that origin — production's own answers, archives or none —
 * so a local export can be looked at exactly as goway.to would draw it.
 */
const upstream = arg('upstream', '').replace(/\/$/, '');
const UPSTREAM_PATH = /^\/(map|landmarks)\//;

async function proxy(path: string, search: string, response: ServerResponse): Promise<void> {
  try {
    const answer = await fetch(`${upstream}${path}${search}`);
    const headers: Record<string, string> = { 'access-control-allow-origin': '*' };
    for (const name of ['content-type', 'cache-control']) {
      const value = answer.headers.get(name);
      if (value) headers[name] = value;
    }
    response.writeHead(answer.status, headers);
    response.end(Buffer.from(await answer.arrayBuffer()));
  } catch (cause) {
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end(`upstream: ${String(cause)}`);
  }
}

/**
 * `/map/contours/…`, made HERE by the production Worker's own module
 * (`worker/contours.js`) from the elevation tiles `--upstream` serves, decoded
 * by the same WebAssembly libwebp — so a local export draws the contours
 * goway.to will, before the route is deployed.
 */
let contourService: { tile(z: number, x: number, y: number): Promise<Uint8Array> } | null = null;
async function contours(path: string, response: ServerResponse): Promise<void> {
  try {
    const { contourTileOf, createContourService } = await import('../worker/contours.js');
    const tile = contourTileOf(path);
    if (!tile) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not a contour tile GoWay makes (z9–14).');
      return;
    }
    if (!contourService) {
      const { default: decode, init } = await import('@jsquash/webp/decode.js');
      const wasm = await WebAssembly.compile(
        readFileSync(require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')),
      );
      await init(wasm);
      contourService = createContourService({
        fetchDem: async (z: number, x: number, y: number) => {
          const answer = await fetch(`${upstream}/map/terrain/${z}/${x}/${y}.webp`);
          if (answer.status === 404) return null;
          if (!answer.ok) throw new Error(`elevation tile ${z}/${x}/${y}: HTTP ${answer.status}`);
          return new Uint8Array(await answer.arrayBuffer());
        },
        decode: async (bytes: Uint8Array) => {
          const image = await decode(bytes.slice().buffer);
          return { width: image.width, height: image.height, data: image.data };
        },
      });
    }
    const bytes = await contourService.tile(tile.z, tile.x, tile.y);
    response.writeHead(200, {
      'content-type': 'application/x-protobuf',
      'access-control-allow-origin': '*',
    });
    response.end(Buffer.from(bytes));
  } catch (cause) {
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end(`contours: ${String(cause)}`);
  }
}

const files: Handler = (request, response) => {
  const [rawPath, query = ''] = (request.url ?? '/').split('?');
  const path = decodeURIComponent(rawPath);
  let file = normalize(join(root, path));
  // Inside the export, never a sibling directory that merely shares its prefix.
  const inside = file === root || file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  const held = inside && existsSync(file) && !statSync(file).isDirectory();
  if (upstream && path.startsWith('/map/contours/')) {
    void contours(path, response);
    return;
  }
  if (!held && upstream && UPSTREAM_PATH.test(path)) {
    void proxy(rawPath, query ? `?${query}` : '', response);
    return;
  }
  if (!held) {
    const html = `${file.replace(/\/$/, '')}.html`;
    file = inside && existsSync(html) ? html : join(root, 'index.html');
  }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
};

const tiles =
  withDevCityTiles({ server: {} }).server?.enhanceMiddleware?.(files, null) ??
  ((request, response) => files(request, response, () => {}));

createServer((request, response) =>
  tiles(request, response, () => files(request, response, () => {})),
).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://localhost:${port}`));
