/**
 * The map proxy, exercised without a Workers runtime.
 *
 * ## Why this file exists
 *
 * `worker/index.js` is the only code in the web deployment that a build cannot
 * see. `tsc` does not read it, `expo export` does not bundle it, `map:style:check`
 * does not know it exists, and the first execution of every line in it happens
 * in production. That is the worst place to discover that a regex admits
 * `../../`, that an out-of-range tile forwards to a free upstream service, or
 * that the glyph fallback was defeated by the SPA fallback returning
 * `index.html` with a 200.
 *
 * None of that needs `workerd`. The handlers take `(url, request, env, ctx)`
 * and call `fetch`, `caches` and `env.ASSETS` — all four are injectable, so
 * the parts with edge cases are testable here and the only thing left for the
 * deploy to prove is that Cloudflare routes to them at all.
 *
 * What this canNOT prove, and the report must not claim it does:
 * `run_worker_first` actually selecting these paths; `_headers` being applied
 * to the asset half; and `cf: { cacheEverything }` doing anything. Those are
 * platform behaviours with no local surface.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import worker, { GLYPH_PATH, TILE_PATH, serveGlyphs, serveTile } from '../index.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const BUILD = 'https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf';

const env = { MAP_TILE_UPSTREAM: TILEJSON, MAP_GLYPH_UPSTREAM: GLYPHS };
const ctx = { waitUntil: () => {} };

let fetched = [];
const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;

/** Upstream responses, keyed by the URL the Worker asks for. */
let upstream = new Map();

beforeEach(() => {
  fetched = [];
  upstream = new Map();
  globalThis.fetch = mock(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    fetched.push(url);
    if (url === TILEJSON) {
      return new Response(JSON.stringify({ tiles: [BUILD] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const canned = upstream.get(url);
    if (canned) return canned();
    return new Response('nope', { status: 404 });
  });
  // `caches.default` does not exist outside workerd. A miss-always cache is
  // the honest stand-in: it exercises the resolve path every time, which is
  // the path with the parsing in it.
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.caches = realCaches;
});

/** An asset pipeline that has the listed paths and SPA-falls-back otherwise. */
function assetsWith(paths) {
  return {
    async fetch(request) {
      // Percent-decoded, because Workers Assets matches a request for
      // `/map/fonts/Inter%20Regular/0-255.pbf` against a file whose name
      // contains a literal space. A stub that skipped this would pass while
      // the deployment 404'd every glyph range in the product.
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      if (paths.has(pathname)) {
        return new Response(paths.get(pathname), {
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      // THE TRAP. `not_found_handling = "single-page-application"` answers a
      // path it does not have with 200 and the app shell, never a 404.
      return new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  };
}

describe('the tile path regex', () => {
  test('admits a well-formed coordinate and nothing else', () => {
    expect(TILE_PATH.test('/map/tiles/12/2048/1361.pbf')).toBe(true);
    expect(TILE_PATH.test('/map/tiles/0/0/0.pbf')).toBe(true);
  });

  test('refuses anything that is not three integers', () => {
    for (const path of [
      '/map/tiles/../../etc/passwd',
      '/map/tiles/12/2048/1361.pbf/../..',
      '/map/tiles/12/2048/-1.pbf',
      '/map/tiles/12/2048/1361.json',
      '/map/tiles/12/2048/1361',
      '/map/tiles/a/b/c.pbf',
      '/map/tiles/12/20.5/1361.pbf',
      '/map/tiles//2048/1361.pbf',
    ]) {
      expect(TILE_PATH.test(path)).toBe(false);
    }
  });
});

describe('serveTile', () => {
  const call = (pathname) =>
    serveTile(
      new URL(`https://goway.to${pathname}`),
      new Request(`https://goway.to${pathname}`),
      env,
      ctx,
    );

  test('resolves the date-stamped build and fetches the right tile', async () => {
    upstream.set(
      'https://tiles.openfreemap.org/planet/20260913_164504_pt/12/2048/1361.pbf',
      () => new Response('tile-bytes', { headers: { 'content-type': 'application/x-protobuf' } }),
    );
    const response = await call('/map/tiles/12/2048/1361.pbf');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('tile-bytes');
    expect(fetched).toEqual([
      TILEJSON,
      'https://tiles.openfreemap.org/planet/20260913_164504_pt/12/2048/1361.pbf',
    ]);
  });

  test('sets the headers that make the tile usable from another origin', async () => {
    upstream.set(
      'https://tiles.openfreemap.org/planet/20260913_164504_pt/12/2048/1361.pbf',
      () => new Response('tile-bytes'),
    );
    const response = await call('/map/tiles/12/2048/1361.pbf');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.get('cache-control')).toContain('max-age=86400');
  });

  test('keeps content-encoding, because a gzipped tile forwarded without it is unparseable', async () => {
    upstream.set(
      'https://tiles.openfreemap.org/planet/20260913_164504_pt/12/2048/1361.pbf',
      () =>
        new Response('tile-bytes', {
          headers: { 'content-encoding': 'gzip', 'content-type': 'application/x-protobuf' },
        }),
    );
    const response = await call('/map/tiles/12/2048/1361.pbf');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-type')).toBe('application/x-protobuf');
  });

  test('strips the headers that would name the vendor or fight our freshness', async () => {
    upstream.set(
      'https://tiles.openfreemap.org/planet/20260913_164504_pt/12/2048/1361.pbf',
      () =>
        new Response('tile-bytes', {
          headers: {
            'x-ofm-debug': 'latest planet',
            age: '80185',
            expires: 'Sun, 20 Sep 2026 10:26:36 GMT',
            nel: '{"report_to":"cf-nel"}',
          },
        }),
    );
    const response = await call('/map/tiles/12/2048/1361.pbf');
    for (const header of ['x-ofm-debug', 'age', 'expires', 'nel']) {
      expect(response.headers.get(header)).toBeNull();
    }
  });

  test('refuses a zoom above the planet build WITHOUT asking upstream', async () => {
    // The point is the second assertion: forwarding it would be using a free
    // service to generate misses on behalf of a stranger.
    const response = await call('/map/tiles/18/100000/100000.pbf');
    expect(response.status).toBe(404);
    expect(fetched).toEqual([]);
  });

  test('refuses a coordinate outside the world at that zoom, without asking upstream', async () => {
    const response = await call('/map/tiles/2/9/0.pbf');
    expect(response.status).toBe(404);
    expect(fetched).toEqual([]);
  });

  test('forwards an upstream 404 as a 404 — an empty ocean tile is normal, not an error', async () => {
    const response = await call('/map/tiles/4/0/0.pbf');
    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('answers 503 rather than substituting a hardcoded upstream of its own', async () => {
    const response = await serveTile(
      new URL('https://goway.to/map/tiles/4/8/5.pbf'),
      new Request('https://goway.to/map/tiles/4/8/5.pbf'),
      { MAP_GLYPH_UPSTREAM: GLYPHS },
      ctx,
    );
    expect(response.status).toBe(503);
    expect(fetched).toEqual([]);
  });

  test('answers 502 when the upstream index cannot be read', async () => {
    globalThis.fetch = mock(async () => new Response('down', { status: 500 }));
    const response = await call('/map/tiles/4/8/5.pbf');
    expect(response.status).toBe(502);
  });
});

describe('serveGlyphs', () => {
  const call = (pathname, assets) =>
    serveGlyphs(new URL(`https://goway.to${pathname}`), new Request(`https://goway.to${pathname}`), {
      ...env,
      ASSETS: assets,
    });

  test('serves a committed Inter range from the asset pipeline, never upstream', async () => {
    const assets = assetsWith(new Map([['/map/fonts/Inter Regular/0-255.pbf', 'inter-bytes']]));
    const response = await call('/map/fonts/Inter%20Regular/0-255.pbf', assets);
    expect(await response.text()).toBe('inter-bytes');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(fetched).toEqual([]);
  });

  test('is NOT fooled by the SPA fallback answering a missing range with index.html', async () => {
    // Without the content-type check this test gets `<!doctype html>` back and
    // hands it to MapLibre labelled as a glyph range.
    upstream.set(
      'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/19968-20223.pbf',
      () => new Response('noto-cjk-bytes'),
    );
    const assets = assetsWith(new Map());
    const response = await call('/map/fonts/Inter%20Regular/19968-20223.pbf', assets);
    expect(await response.text()).toBe('noto-cjk-bytes');
  });

  test('maps each Inter weight onto a Noto weight that actually exists upstream', async () => {
    // `Noto Sans Medium` and `Noto Sans SemiBold` both 404 at the upstream —
    // that absence is most of why GoWay generates its own glyphs at all.
    const assets = assetsWith(new Map());
    upstream.set(
      'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Bold/19968-20223.pbf',
      () => new Response('noto-bold'),
    );
    const response = await call('/map/fonts/Inter%20SemiBold/19968-20223.pbf', assets);
    expect(await response.text()).toBe('noto-bold');
    expect(fetched[0]).toContain('Noto%20Sans%20Bold');
  });

  test('refuses a fontstack that is not ours, without asking upstream', async () => {
    const assets = assetsWith(new Map());
    const response = await call('/map/fonts/Comic%20Sans/0-255.pbf', assets);
    expect(response.status).toBe(404);
    expect(fetched).toEqual([]);
  });

  test('refuses a range that is not a 256-codepoint block', async () => {
    const assets = assetsWith(new Map());
    for (const range of ['0-100', '5-260', '100-355']) {
      const response = await call(`/map/fonts/Inter%20Regular/${range}.pbf`, assets);
      expect(response.status).toBe(404);
    }
    expect(fetched).toEqual([]);
  });

  test('the glyph regex refuses a fontstack containing a path separator', () => {
    expect(GLYPH_PATH.test('/map/fonts/a/b/0-255.pbf')).toBe(false);
    expect(GLYPH_PATH.test('/map/fonts/Inter Regular/0-255.pbf')).toBe(true);
  });
});

describe('the entry point', () => {
  const assets = assetsWith(new Map([['/index.html', 'shell']]));

  test('answers a preflight so a cross-origin embed can fetch a tile', async () => {
    const response = await worker.fetch(
      new Request('https://goway.to/map/tiles/4/8/5.pbf', {
        method: 'OPTIONS',
        headers: { origin: 'https://homiio.com' },
      }),
      { ...env, ASSETS: assets },
      ctx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });

  test('refuses a write method rather than proxying it', async () => {
    const response = await worker.fetch(
      new Request('https://goway.to/map/tiles/4/8/5.pbf', { method: 'POST' }),
      { ...env, ASSETS: assets },
      ctx,
    );
    expect(response.status).toBe(405);
    expect(fetched).toEqual([]);
  });

  test('hands anything it does not claim straight to the asset pipeline', async () => {
    const response = await worker.fetch(
      new Request('https://goway.to/index.html'),
      { ...env, ASSETS: assets },
      ctx,
    );
    expect(await response.text()).toBe('shell');
    expect(fetched).toEqual([]);
  });
});
