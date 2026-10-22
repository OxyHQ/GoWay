/**
 * The camera HTTP surface, over a real socket, with an in-memory store, a fake
 * upstream and no database: the query shapes the SDK sends, the paging, the
 * provider terms on every camera, and the rule that a picture is served only
 * for a provider whose licence allows it.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CameraObservation } from '@goway/contracts';
import type { CameraProviderDefinition } from '../../cameras/types';
import { SnapshotRelay } from '../../cameras/relay';
import { cameraIdOf } from '../../cameras/normalise';
import { errorHandler, unknownRouteHandler } from '../../http/errorHandler';
import { createCamerasRouter, type CamerasStore } from '../cameras';
import type { CameraRow } from '../../cameras/view';

const provider = (
  id: string,
  redistribution: CameraProviderDefinition['redistribution'],
): CameraProviderDefinition => ({
  id,
  name: `${id} cameras`,
  attribution: { label: `Source: ${id}`, href: 'https://example.org/credit' },
  licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
  licenceCheck: {
    verifiedOn: '2026-10-22',
    quote: 'free to share and adapt, even commercially',
    source: 'https://example.org/terms',
  },
  defaultUrl: 'https://example.org/cameras',
  requiresKey: false,
  pollIntervalSeconds: 600,
  staleAfterSeconds: 1200,
  dropAfterSeconds: 7200,
  coverage: null,
  redistribution,
  create: () => {
    throw new Error('not used');
  },
});
const PROVIDERS = [provider('open-roads', 'relay'), provider('listed-only', 'catalogue-only')];
const NOW = new Date('2026-10-22T12:00:00Z');

const row = (
  providerId: string,
  sourceId: string,
  longitude: number,
  frameAt: string | null,
): CameraRow => ({
  id: cameraIdOf(providerId, sourceId),
  providerId,
  sourceId,
  name: `Camera ${sourceId}`,
  kind: 'traffic',
  latitude: 41,
  longitude,
  geo: null,
  heading: null,
  roadName: null,
  mediaKind: 'snapshot',
  mediaRefreshSeconds: 60,
  mediaWidth: null,
  mediaHeight: null,
  upstreamUrl: `https://cams.example.org/${sourceId}.jpg`,
  lastFrameAt: frameAt ? new Date(frameAt) : null,
  lastSeenAt: NOW,
  retiredAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const ROWS = [
  row('open-roads', 'a', 2, '2026-10-22T11:59:00Z'),
  row('open-roads', 'b', 2.1, '2026-10-22T11:30:00Z'),
  row('open-roads', 'c', 2.2, '2026-10-22T08:00:00Z'),
  row('open-roads', 'd', 2.3, null),
  row('listed-only', 'e', 2.4, null),
  row('retired-provider', 'f', 2.5, null),
];
const observation = (minute: number): CameraObservation => ({
  cameraId: ROWS[0]?.id ?? '',
  from: new Date(Date.UTC(2026, 9, 22, 11, minute - 1)).toISOString(),
  to: new Date(Date.UTC(2026, 9, 22, 11, minute)).toISOString(),
  counts: { car: minute },
  present: {},
  flowPerMinute: minute,
  congestion: 'free',
  health: 'ok',
});

/** Postgres's own text for a `timestamptz`, which is what a real cursor position carries. */
const pgText = (iso: string) => iso.replace('T', ' ').replace('.000Z', '+00');
const fromPgText = (text: string) => Date.parse(text.replace(' ', 'T').replace('+00', 'Z'));

const touches: [string, Date][] = [];
const store: CamerasStore = {
  list: ({ box, kind, providerIds }, { limit, after }) =>
    Promise.resolve(
      ROWS.filter(
        (r) =>
          providerIds.includes(r.providerId) &&
          (after === undefined || r.id > after) &&
          r.longitude >= box.west &&
          r.longitude <= box.east &&
          (kind === undefined || r.kind === kind),
      ).slice(0, limit),
    ),
  get: (id) => Promise.resolve(ROWS.find((r) => r.id === id) ?? null),
  counts: () => Promise.resolve(new Map([['open-roads', 4]])),
  observations: (cameraId, _filter, { limit, after }) =>
    Promise.resolve(
      [5, 4, 3, 2, 1]
        .map(observation)
        .filter((o) => o.cameraId === cameraId)
        .map((item) => ({ item, position: [pgText(item.to), cameraId] as [string, string] }))
        .filter((paged) => after === undefined || Date.parse(paged.item.to) < fromPgText(after[0]))
        .slice(0, limit),
    ),
  touchFrame: (cameraId, at) => {
    touches.push([cameraId, at]);
    return Promise.resolve();
  },
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
let upstreamCalls = 0;
const relay = new SnapshotRelay({
  fetch: async () => {
    upstreamCalls++;
    return new Response(JPEG, {
      headers: { 'content-type': 'image/jpeg', 'last-modified': 'Thu, 22 Oct 2026 11:59:30 GMT' },
    });
  },
  now: () => NOW.getTime(),
  resolve: async () => ['93.184.216.34'],
});

// biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary JSON
type Json = any;
let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  const v1: Router = Router();
  v1.use(createCamerasRouter({ store, providers: PROVIDERS, relay, now: () => NOW }));
  app.use('/api/v1', v1);
  app.use(unknownRouteHandler);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, { headers });
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    headers: response.headers,
    body: type.includes('json') ? ((await response.json()) as Json) : await response.arrayBuffer(),
  };
}

const BOX = 'west=1&south=40&east=3&north=42';
const idOf = (providerId: string, sourceId: string) => cameraIdOf(providerId, sourceId);

describe('GET /cameras', () => {
  it('lists the cameras in a box with their provider terms, and only providers the registry knows', async () => {
    const { status, body } = await get(`/cameras?${BOX}`);
    expect(status).toBe(200);
    expect(body.items.map((c: Json) => c.id)).toEqual(
      ['a', 'b', 'c', 'd'].map((s) => idOf('open-roads', s)).concat(idOf('listed-only', 'e')),
    );
    expect(body.nextCursor).toBeNull();
    expect(body.items[0].attribution).toEqual({
      label: 'Source: open-roads',
      href: 'https://example.org/credit',
    });
    expect(body.items[0].licence.label).toBe('CC BY 4.0');
    // Never the operator's URL.
    expect(JSON.stringify(body)).not.toContain('cams.example.org');
  });

  it('works out status from the frame age against the provider windows', async () => {
    const { body } = await get(`/cameras?${BOX}`);
    expect(body.items.slice(0, 4).map((c: Json) => c.status)).toEqual([
      'live', // 1 min
      'stale', // 30 min > 20 min
      'offline', // 4 h > 2 h
      'unknown', // never seen
    ]);
  });

  it('pages with an opaque cursor that cannot be replayed on another filter', async () => {
    const first = await get(`/cameras?${BOX}&limit=2`);
    expect(first.body.items).toHaveLength(2);
    expect(typeof first.body.nextCursor).toBe('string');
    const next = await get(`/cameras?${BOX}&limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items.map((c: Json) => c.id)).toEqual([
      idOf('open-roads', 'c'),
      idOf('open-roads', 'd'),
    ]);
    const replay = await get(
      `/cameras?west=1&south=40&east=3&north=43&limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('bad_request');
  });

  it('refuses a box that is missing or upside down', async () => {
    expect((await get('/cameras')).status).toBe(422);
    expect((await get('/cameras?west=1&south=43&east=3&north=40')).status).toBe(422);
  });
});

describe('GET /cameras/{id}', () => {
  it('answers one camera, and not_found for an unknown one or one whose provider is gone', async () => {
    const found = await get(`/cameras/${idOf('open-roads', 'a')}`);
    expect(found.status).toBe(200);
    expect(found.body.name).toBe('Camera a');
    expect((await get('/cameras/open-roads.zzz')).status).toBe(404);
    expect((await get(`/cameras/${idOf('retired-provider', 'f')}`)).status).toBe(404);
  });
});

describe('GET /cameras/{id}/snapshot', () => {
  it("serves GoWay's copy with caching headers, and answers a revalidation with 304", async () => {
    const id = idOf('open-roads', 'a');
    const first = await get(`/cameras/${id}/snapshot`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/jpeg');
    expect(first.headers.get('last-modified')).toBe('Thu, 22 Oct 2026 11:59:30 GMT');
    expect(first.headers.get('cache-control')).toBe('public, max-age=30');
    expect(new Uint8Array(first.body as ArrayBuffer)).toEqual(JPEG);
    const etag = first.headers.get('etag') ?? '';
    const again = await get(`/cameras/${id}/snapshot`, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(upstreamCalls).toBe(1); // both from the one copy
  });

  it('records the camera frame time, once a minute at most', async () => {
    const id = idOf('open-roads', 'a');
    await get(`/cameras/${id}/snapshot`);
    await get(`/cameras/${id}/snapshot`);
    expect(touches.filter(([camera]) => camera === id)).toHaveLength(1);
    expect(touches[0]?.[1].toISOString()).toBe('2026-10-22T11:59:30.000Z');
  });

  it('serves no picture for a provider that is catalogue-only', async () => {
    const { status, body } = await get(`/cameras/${idOf('listed-only', 'e')}/snapshot`);
    expect(status).toBe(404);
    expect(body.error.message).toContain('does not serve a picture');
  });
});

describe('GET /cameras/{id}/observations', () => {
  it('pages newest first and refuses an unknown camera', async () => {
    const id = idOf('open-roads', 'a');
    const first = await get(`/cameras/${id}/observations?limit=2`);
    expect(first.body.items.map((o: Json) => o.counts.car)).toEqual([5, 4]);
    const next = await get(`/cameras/${id}/observations?limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items.map((o: Json) => o.counts.car)).toEqual([3, 2]);
    expect((await get('/cameras/open-roads.zzz/observations')).status).toBe(404);
  });
});

describe('GET /camera-providers', () => {
  it('lists the providers with their terms, whether GoWay serves their pictures, and counts', async () => {
    const { body } = await get('/camera-providers');
    expect(body.items.map((p: Json) => [p.id, p.redistribution, p.cameraCount])).toEqual([
      ['open-roads', 'relay', 4],
      ['listed-only', 'catalogue-only', 0],
    ]);
  });
});
