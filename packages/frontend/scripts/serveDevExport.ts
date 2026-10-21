/**
 * Serve an `expo export --platform web --dev` output on a free loopback port,
 * for the browser gates that drive the real app (`check-city3d-visible.ts`,
 * `check-dev-console.ts`).
 *
 * A file of the export is served as itself, an unknown path as the SPA's
 * `index.html` (as the production Worker answers it), and `respond` may answer
 * a path first — the city gate's synthetic tiles, which Web Workers fetch and
 * Playwright's routes therefore never see.
 */
import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  // MapLibre's worker is a module: a module script of any other type is refused.
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.pbf': 'application/x-protobuf',
  '.wasm': 'application/wasm',
};

export interface ServeDevExportOptions {
  /** Answer a path before the export does; `null` passes it on. */
  respond?: (pathname: string) => Response | Promise<Response> | null;
  /** Told every path requested (a gate's `--debug`). */
  log?: (pathname: string) => void;
}

export function serveDevExport(dir: string, { respond, log }: ServeDevExportOptions = {}) {
  const root = resolve(dir);
  const file = (path: string) => {
    const full = join(root, decodeURIComponent(path));
    return full.startsWith(root) && existsSync(full) && statSync(full).isFile() ? full : null;
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    websocket: { message() {} },
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      // A development build's runtime opens these and reloads the page while
      // they fail: accept them and say nothing.
      if ((pathname === '/hot' || pathname === '/message') && server.upgrade(request)) {
        return undefined;
      }
      log?.(pathname);
      const answered = respond?.(pathname);
      if (answered) return answered;
      const hit = file(pathname) ?? file(`${pathname}.html`) ?? join(root, 'index.html');
      return new Response(Bun.file(hit), {
        headers: { 'content-type': TYPES[extname(hit)] ?? 'application/octet-stream' },
      });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
