import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { withDevTerrain } from '../dev-terrain.js';

test('Metro serves fine DEMs through the production adapter without forwarding browser identity', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = ((url: RequestInfo | URL, options?: RequestInit) => {
    if (!String(url).startsWith('https://tiles.mapterhorn.com/')) return original(url, options);
    calls.push({ url: String(url), options });
    return Promise.resolve(
      new Response(options?.method === 'HEAD' ? null : 'terrain', {
        headers: { 'content-type': 'image/webp' },
      }),
    );
  }) as typeof fetch;
  const config = withDevTerrain({ server: {} });
  const middleware = config.server.enhanceMiddleware(
    (_req: unknown, res: { end: (s: string) => void }) => res.end('Metro'),
    {},
  );
  const server = createServer((req, res) => middleware(req, res, () => {}));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await original(`${base}/map/terrain/16/33165/24475.webp`, {
      headers: { authorization: 'Bearer private', cookie: 'private=session' },
    });
    expect(await response.text()).toBe('terrain');
    expect(calls[0].url).toBe('https://tiles.mapterhorn.com/16/33165/24475.webp');
    expect(calls[0].options?.headers).toBeUndefined();
    expect((await original(`${base}/map/terrain/17/0/0.webp`)).status).toBe(404);
    expect(
      (await original(`${base}/map/terrain/16/33165/24475.webp`, { method: 'POST' })).status,
    ).toBe(405);
    expect(await (await original(`${base}/anything`)).text()).toBe('Metro');
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
