/**
 * The application, exercised over a real socket.
 *
 * `createApp()` opens no connections and registers no signal handlers, which is
 * what makes this possible without a database or the process bootstrap. What is
 * asserted here is the ERROR ENVELOPE and the middleware order — the two things
 * an SDK consumer sees and that nothing else in the suite covers.
 *
 * `./testEnv` FIRST, and the order is load-bearing: `src/config` parses at module
 * load, so the environment has to exist before `../app` is evaluated. Its
 * DATABASE_URL is a syntactically valid URL pointing at nothing — no test in this
 * file opens a connection, which is exactly what the `GET /health` case below
 * relies on.
 */

import './testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';
import { API_OPERATIONS, apiErrorBodySchema, GOWAY_API_BASE_PATH } from '@goway/contracts';
import { createApp } from '../app';
import { createGoWayRateLimit } from '../middleware/auth';

/** A value each path parameter accepts, so a request reaches the route rather than failing its shape. */
const SAMPLE_PATH_VALUES: Readonly<Record<string, string>> = {
  placeId: 'place-1',
  key: 'payments.faircoin.accepted',
  sceneId: 'scene-1',
  sessionId: 'session-1',
  assetId: 'asset-1',
};

let server: Server;
let origin: string;

beforeAll(async () => {
  // Port 0: the OS picks a free one. A fixed port makes the suite fail when
  // anything else on the machine happens to hold it.
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the error envelope', () => {
  it('answers an unmatched route with { error: { code: unknown_route } }', async () => {
    // Not `not_found`: a client that sees this is on the wrong API version, and
    // must not conclude that a resource it holds an id for is gone.
    const response = await fetch(`${origin}/no/such/route`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'unknown_route', message: 'No route matches this request.' },
    });
  });

  it('answers a rate-limited request with the JSON envelope, not plain text', async () => {
    const limited = express();
    limited.use(createGoWayRateLimit({ anonymousMax: 1 }), (_request, response) => {
      response.json({ ok: true });
    });
    const limitedServer = limited.listen(0);
    try {
      await new Promise<void>((resolve) => limitedServer.once('listening', () => resolve()));
      const { port } = limitedServer.address() as AddressInfo;
      await fetch(`http://127.0.0.1:${String(port)}/x`);
      const response = await fetch(`http://127.0.0.1:${String(port)}/x`);

      expect(response.status).toBe(429);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = apiErrorBodySchema.parse(await response.json());
      expect(body.error.code).toBe('rate_limited');
      expect(body.error.details?.retryAfterSeconds).toEqual(expect.any(Number));
    } finally {
      await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
    }
  });

  it('classifies malformed JSON as bad_request, not a 500', async () => {
    // A 500 here would tell an integrator that GoWay broke when their payload
    // did — and invite the retry that service_unavailable is reserved for.
    const response = await fetch(`${origin}/api/anything`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('classifies an oversized body as payload_too_large', async () => {
    const response = await fetch(`${origin}/api/anything`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
  });
});

describe('security middleware', () => {
  it('sets helmet headers and hides the framework', async () => {
    const response = await fetch(`${origin}/no/such/route`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('does not reflect an arbitrary Origin', async () => {
    // The whole point of createOxyCors over a hand-rolled allowlist: an
    // echoed-back attacker origin with credentials is the classic CORS bug.
    const response = await fetch(`${origin}/no/such/route`, {
      headers: { origin: 'https://attacker.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).not.toBe(
      'https://attacker.example',
    );
  });

  it('allows a configured app origin', async () => {
    const response = await fetch(`${origin}/no/such/route`, {
      headers: { origin: 'http://localhost:8081' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:8081');
  });
});

describe('GET /health', () => {
  it('reports the database as down when nothing is connected', async () => {
    // `connectPostgres()` was never called, so the pool does not exist. The
    // route must say so rather than report healthy — a probe that answers 200
    // while the process cannot serve a single Places request is worse than no
    // probe.
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'degraded',
      service: 'goway-backend',
      database: 'down',
    });
  });
});

describe('the route registry', () => {
  it('serves the committed OpenAPI document, byte for byte in content', async () => {
    const response = await fetch(`${origin}${GOWAY_API_BASE_PATH}/openapi.json`);
    expect(response.status).toBe(200);
    const committed: unknown = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'contracts', 'openapi.json'), 'utf8'),
    );
    expect(await response.json()).toEqual(committed);
  });

  it('mounts every operation the contract registry publishes', async () => {
    // The registry is what the OpenAPI document and the SDK are built from; a
    // path in it that this app does not route is a published operation that
    // answers `unknown_route`. Whatever else each request answers — 401, 422,
    // 503 with no database — it must not be that.
    const unrouted: string[] = [];
    for (const operation of API_OPERATIONS) {
      const path = operation.path.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => SAMPLE_PATH_VALUES[name] ?? 'x');
      const response = await fetch(`${origin}${GOWAY_API_BASE_PATH}${path}`, {
        method: operation.method.toUpperCase(),
        ...(operation.method === 'get' || operation.method === 'delete'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      });
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (body?.error?.code === 'unknown_route') unrouted.push(`${operation.method.toUpperCase()} ${operation.path}`);
    }
    expect(unrouted).toEqual([]);
    expect(API_OPERATIONS.length).toBeGreaterThan(20);
  });
});
