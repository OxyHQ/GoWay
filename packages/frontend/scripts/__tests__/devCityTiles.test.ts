import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { withDevCityTiles } from '../dev-city-tiles.js';

const originalFetch = globalThis.fetch;
const archive = process.env.GOWAY_CITY_TILES_ARCHIVE;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (archive === undefined) delete process.env.GOWAY_CITY_TILES_ARCHIVE;
  else process.env.GOWAY_CITY_TILES_ARCHIVE = archive;
});

describe('one development origin for the city map', () => {
  test('public city data shares Metro without forwarding credentials or compressed headers', async () => {
    delete process.env.GOWAY_CITY_TILES_ARCHIVE;
    const calls: { url: string; options: RequestInit | undefined }[] = [];
    globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
      if (!String(url).startsWith('https://goway.to/')) return originalFetch(url, options);
      calls.push({ url: String(url), options });
      return Promise.resolve(
        new Response('decoded tile', {
          headers: {
            'content-type': 'application/vnd.mapbox-vector-tile',
            'content-encoding': 'gzip',
            'content-length': '999',
          },
        }),
      );
    }) as typeof fetch;
    let previousCalled = false;
    const config = withDevCityTiles({
      server: {
        enhanceMiddleware: (inner: unknown) => {
          previousCalled = true;
          return inner;
        },
      },
    });
    const inner = (_req: IncomingMessage, res: ServerResponse) => res.end('Metro');
    const middleware = config.server.enhanceMiddleware(inner, {});
    const server = createServer((req, res) => middleware(req, res, () => {}));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await originalFetch(`${origin}/map/city-roads/15/16580/12237.pbf`, {
        headers: { cookie: 'private=session', authorization: 'Bearer private' },
      });
      expect(await response.text()).toBe('decoded tile');
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('content-length')).not.toBe('999');
      expect(calls[0].url).toBe('https://goway.to/map/city-roads/15/16580/12237.pbf');
      expect(calls[0].options?.headers).toBeUndefined();
      expect(await (await originalFetch(`${origin}/landmarks/sagrada-familia.glb`)).text()).toBe(
        'Metro',
      );
      expect(
        (await originalFetch(`${origin}/map/city/coverage.json`, { method: 'POST' })).status,
      ).toBe(405);
      expect(calls).toHaveLength(1);
      expect(previousCalled).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
