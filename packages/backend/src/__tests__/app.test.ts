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
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';

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
  it('answers an unmatched route with { error: { code: not_found } }', async () => {
    const response = await fetch(`${origin}/no/such/route`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: 'No route matches this request.' },
    });
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
