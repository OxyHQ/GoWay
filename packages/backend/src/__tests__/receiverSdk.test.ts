/** Consumer's real middleware + installed candidate SDK over HTTP.
 * Issuer authority is synthetic; no production credentials, product DB or effects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';

const previousOrigin = process.env.OXY_API_URL;
const previousDatabase = process.env.DATABASE_URL;
let issuer: Server;
let receiver: Server;
let receiverOrigin = '';
let active = true;
let validations = 0;
let admitted = 0;

function bearer(userId = 'receiver-owner', includeSession = true): string {
  const payload = { userId, ...(includeSession ? { sessionId: 'receiver-session' } : {}),
    exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic-issuer-boundary`;
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
function request(token?: string): Promise<Response> {
  return fetch(receiverOrigin + '/owned-fixture', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
beforeAll(async () => {
  issuer = createServer((req, res) => {
    if (!req.url?.startsWith('/session/validate/receiver-session')) { res.writeHead(404).end(); return; }
    validations += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ valid: active, user: { id: 'receiver-owner' },
      sessionId: 'receiver-session', expiresAt: new Date(Date.now() + 300000).toISOString(), lastActivity: new Date().toISOString() }));
  });
  process.env.OXY_API_URL = await listen(issuer);
  // Configuration syntax only: this test never opens a product database.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/receiver_fixture_unused';
  let middleware: RequestHandler;
  ({ requireAuth: middleware } = await import('../middleware/auth'));
  const app = express();
  app.get('/owned-fixture', middleware, (req, res) => {
    admitted += 1;
    res.json({ userId: req.userId });
  });
  receiver = createServer(app);
  receiverOrigin = await listen(receiver);
});
afterAll(async () => {
  try { await close(receiver); } finally {
    await close(issuer);
    if (previousOrigin === undefined) delete process.env.OXY_API_URL; else process.env.OXY_API_URL = previousOrigin;
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
  }
});
describe('candidate SDK receiver authority', () => {
  it('refuses missing and sessionless bearers before the protected handler', async () => {
    const before = admitted;
    expect((await request()).status).toBe(401);
    expect((await request(bearer('receiver-owner', false))).status).toBe(401);
    expect(admitted).toBe(before);
  });
  it('uses the live validated owner and rejects a conflicting token claim', async () => {
    active = true;
    const response = await request(bearer());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'receiver-owner' });
    const before = admitted;
    expect((await request(bearer('other-owner'))).status).toBe(401);
    expect(admitted).toBe(before);
  });
  it('revalidates on the next call and refuses revocation without a cached admit', async () => {
    active = true;
    expect((await request(bearer())).status).toBe(200);
    const before = admitted;
    const checks = validations;
    active = false;
    expect((await request(bearer())).status).toBe(401);
    expect(validations).toBe(checks + 1);
    expect(admitted).toBe(before);
  });
});
