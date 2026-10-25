import { afterAll, describe, expect, test } from 'bun:test';
import { OxyServices } from '@oxy.so/core';
import { createGoWayClient, GoWayNotFoundError } from '@goway.to/sdk';

const requests: Array<{ authorization: string | null; cookie: string | null }> = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    requests.push({
      authorization: request.headers.get('authorization'),
      cookie: request.headers.get('cookie'),
    });
    return Response.json(
      { error: { code: 'not_found', message: 'Missing place' } },
      { status: 404 },
    );
  },
});
const baseURL = `http://127.0.0.1:${server.port}`;
const oxy = new OxyServices({ baseURL: 'https://identity.example', enableLogging: false });
const linked = oxy.createLinkedClient({ baseURL });
const client = createGoWayClient({ apiBaseUrl: baseURL, fetch: linked.fetchOptional });
const token = (sub: string) =>
  `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub, userId: sub, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.fixture`;
afterAll(() => {
  linked.dispose();
  oxy.dispose();
  server.stop(true);
});
describe('GoWay SDK with the shared optional-session fetch', () => {
  test('keeps public browsing anonymous and follows account changes without copying tokens', async () => {
    await expect(client.places.get('missing')).rejects.toBeInstanceOf(GoWayNotFoundError);
    const alice = token('alice');
    oxy.session.setAccessToken(alice);
    await expect(client.places.get('missing')).rejects.toBeInstanceOf(GoWayNotFoundError);
    const bob = token('bob');
    oxy.session.setAccessToken(bob);
    await expect(client.places.get('missing')).rejects.toBeInstanceOf(GoWayNotFoundError);
    oxy.session.clear();
    await expect(client.places.get('missing')).rejects.toBeInstanceOf(GoWayNotFoundError);
    expect(requests).toEqual([
      { authorization: null, cookie: null },
      { authorization: `Bearer ${alice}`, cookie: null },
      { authorization: `Bearer ${bob}`, cookie: null },
      { authorization: null, cookie: null },
    ]);
  });
});
