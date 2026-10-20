/**
 * `GET /transit/nearby` over a real socket: the query the SDK sends, the
 * contract the answer keeps, the errors and what they never echo.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nearbyTransitSchema } from '@goway/contracts';
import express, { Router } from 'express';
import { errorHandler, unknownRouteHandler } from '../../http/errorHandler';
import type { LiveService } from '../../live';
import { TransitService } from '../../live/transit/service';
import type { LiveFetch, LiveSourceDefinition } from '../../live/types';
import { archiveFiles, zip } from '../../live/__tests__/transitFixtures';
import { createTransitRouter } from '../transit';

const NOW = Date.parse('2026-10-20T09:50:00Z');
const ZIP_URL = 'https://gtfs.example/test.zip';
const archive = zip(archiveFiles());

const definition: LiveSourceDefinition = {
  id: 'test-bus',
  kind: 'transit',
  name: 'Buses — Test Transit',
  attribution: { label: 'Font: Test Transit', href: 'https://transit.example' },
  licence: { label: 'Test licence', href: 'https://transit.example/licence' },
  coverage: { west: 2.0, south: 41.2, east: 2.4, north: 41.6 },
  completeness: 'network',
  licenceCheck: {
    verifiedOn: '2026-10-20',
    source: 'https://transit.example/licence',
    quote: 'free and open reuse, including commercial',
  },
  defaultUrl: 'https://rt.example/feed',
  requiresKey: false,
  pollIntervalSeconds: 30,
  staleAfterSeconds: 120,
  dropAfterSeconds: 300,
  staticGtfs: { zip: ZIP_URL },
  departures: {},
  create: () => {
    throw new Error('not polled here');
  },
};

const fetchArchive: LiveFetch = async () => ({
  status: 200,
  headers: { get: () => null },
  arrayBuffer: async () =>
    archive.buffer.slice(
      archive.byteOffset,
      archive.byteOffset + archive.byteLength,
    ) as ArrayBuffer,
});

const transit = new TransitService({
  sources: [
    {
      definition,
      settings: { url: definition.defaultUrl, userAgent: 'test', maxRegionsPerPoll: 1 },
    },
  ],
  fetch: fetchArchive,
  now: () => NOW,
});

// biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary JSON
type Json = any;

let server: Server;
let origin: string;
let offline: Server;
let offlineOrigin: string;

function listen(live: LiveService | null): Promise<{ server: Server; origin: string }> {
  const app = express();
  const v1: Router = Router();
  v1.use(createTransitRouter(live));
  app.use('/api/v1', v1);
  app.use(unknownRouteHandler);
  app.use(errorHandler);
  const listening = app.listen(0);
  return new Promise((resolve) =>
    listening.once('listening', () =>
      resolve({
        server: listening,
        origin: `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`,
      }),
    ),
  );
}

beforeAll(async () => {
  ({ server, origin } = await listen({ transit } as unknown as LiveService));
  ({ server: offline, origin: offlineOrigin } = await listen(null));
});
afterAll(async () => {
  for (const s of [server, offline]) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function get(path: string, base = origin) {
  const response = await fetch(`${base}/api/v1${path}`);
  return {
    status: response.status,
    text: await response.clone().text(),
    body: (await response.json()) as Json,
    headers: response.headers,
  };
}

describe('GET /transit/nearby', () => {
  it('answers the contract: stops with lines and departures, and every operator credit', async () => {
    const answer = await get('/transit/nearby?latitude=41.39&longitude=2.17');
    expect(answer.status).toBe(200);
    expect(nearbyTransitSchema.safeParse(answer.body).success).toBe(true);
    expect(answer.body.stops).toHaveLength(1);
    expect(answer.body.stops[0].departures.map((d: Json) => d.basis)).toEqual([
      'scheduled',
      'scheduled',
    ]);
    expect(answer.body.operators[0]).toMatchObject({
      id: 'test-bus',
      attribution: { label: 'Font: Test Transit' },
      licence: { label: 'Test licence' },
      realtime: 'none',
    });
    // Browsers may reuse it briefly; a shared cache may not hold a neighbourhood.
    expect(answer.headers.get('cache-control')).toBe('private, max-age=15');
  });

  it('takes the bounds the SDK sends', async () => {
    const answer = await get(
      '/transit/nearby?latitude=41.39&longitude=2.17&radiusMeters=100&maxStops=1&maxDepartures=1',
    );
    expect(answer.body.stops[0].departures).toHaveLength(1);
  });

  it('answers an empty list, not an error, where no operator covers the point', async () => {
    const answer = await get('/transit/nearby?latitude=48.8566&longitude=2.3522');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ stops: [], operators: [] });
  });

  it('refuses values outside the bounds as validation_failed, without echoing them', async () => {
    for (const query of [
      'latitude=91.123456&longitude=2.17',
      'latitude=41.39&longitude=2.17&radiusMeters=5000',
      'latitude=41.39&longitude=2.17&maxStops=0',
      'latitude=41.39&longitude=2.17&maxDepartures=99',
      'latitude=abc&longitude=2.17',
    ]) {
      const answer = await get(`/transit/nearby?${query}`);
      expect(answer.status).toBe(422);
      expect(answer.body.error.code).toBe('validation_failed');
      expect(answer.text).not.toContain('91.123456');
      expect(answer.text).not.toContain('5000');
    }
  });

  it('refuses an unknown parameter and a repeated one as bad_request, a missing coordinate as validation_failed', async () => {
    expect((await get('/transit/nearby?longitude=2.17')).status).toBe(422);
    for (const query of [
      'latitude=41.39&longitude=2.17&operator=x',
      'latitude=41.39&latitude=41.4&longitude=2.17',
    ]) {
      const answer = await get(`/transit/nearby?${query}`);
      expect(answer.status).toBe(400);
      expect(answer.body.error.code).toBe('bad_request');
    }
  });

  it('is service_unavailable on a deployment with no live layer', async () => {
    const answer = await get('/transit/nearby?latitude=41.39&longitude=2.17', offlineOrigin);
    expect(answer.status).toBe(503);
    expect(answer.body.error.code).toBe('service_unavailable');
  });
});
