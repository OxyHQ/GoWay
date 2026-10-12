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
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

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

const files: Handler = (request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  let file = normalize(join(root, path));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    const html = `${file.replace(/\/$/, '')}.html`;
    file = existsSync(html) ? html : join(root, 'index.html');
  }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
};

const tiles =
  withDevCityTiles({ server: {} }).server?.enhanceMiddleware?.(files, null) ??
  ((request, response) => files(request, response, () => {}));

createServer((request, response) =>
  tiles(request, response, () => files(request, response, () => {})),
).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
