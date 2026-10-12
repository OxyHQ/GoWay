/**
 * The `/live` namespace over a real Socket.IO server and client.
 *
 * Pinned: a signed-out client may subscribe (the map is public) while the
 * default namespace still refuses it; a subscription joins the rooms the
 * SERVER derives from the box and is answered with the rooms and one snapshot
 * per room; deltas reach a room's members and nobody else; too-wide, invalid
 * and too-fast subscriptions are answered without changing rooms; the
 * connection cap refuses the next handshake.
 */

import '../../__tests__/testEnv';
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  LIVE_SOCKET_EVENTS,
  type LiveDelta,
  type LiveEntity,
  type LiveSnapshot,
  type LiveSourcePage,
  type LiveSubscriptionState,
  liveDeltaSchema,
  liveSnapshotSchema,
  liveSourcePageSchema,
  liveSubscriptionStateSchema,
  liveTileOf,
} from '@goway/contracts';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { type LivePolicy, parseLiveConfig } from '../../config/live';
import { attachRealtime } from '../../realtime';
import { createLiveService, type LiveService } from '../index';
import type { LivePollResult, LiveSourceDefinition } from '../types';
import { TokenBucket } from '../socket';

const NOW = Date.now();

const BARCELONA_BOX = { west: 2.05, south: 41.32, east: 2.25, north: 41.47 };
const NEW_YORK_BOX = { west: -74.05, south: 40.68, east: -73.9, north: 40.8 };

function vehicle(id: string, latitude: number, longitude: number): LiveEntity {
  return {
    kind: 'transit',
    id: `renfe-cercanias:${id}`,
    sourceId: 'renfe-cercanias',
    position: { latitude, longitude },
    headingDegrees: null,
    speedMetersPerSecond: null,
    observedAt: new Date(NOW - 1000).toISOString(),
    mode: 'rail',
    operator: 'Renfe',
    line: 'R2N',
    headsign: null,
    vehicleLabel: '28436',
    lineColor: null,
    lineTextColor: null,
    track: null,
    trackStatus: 'unknown',
    positionBasis: 'reported',
  };
}

interface Running {
  http: HttpServer;
  origin: string;
  live: LiveService;
  feed: { result: LivePollResult };
  clients: ClientSocket[];
}

let running: Running | null = null;

async function start(limits: Partial<LivePolicy> = {}): Promise<Running> {
  const feed = { result: { entities: [vehicle('1', 41.39, 2.17)], rejected: 0 } as LivePollResult };
  const config = {
    ...parseLiveConfig({ LIVE_SOURCES: 'renfe-cercanias' }, ['renfe-cercanias']),
    ...limits,
  };
  const live = createLiveService({
    config,
    logger: { info: () => {}, warn: () => {} },
    // The real catalogue entry, with its adapter replaced by a fake feed.
    fetch: async () => {
      throw new Error('unused');
    },
  });
  if (!live) throw new Error('live service not built');
  // Swap the adapter: the catalogue's definition is the subject, the network is not.
  const states = (
    live.hub as unknown as {
      states: {
        adapter: { poll: () => Promise<LivePollResult> };
        definition: LiveSourceDefinition;
      }[];
    }
  ).states;
  for (const state of states) state.adapter = { poll: async () => feed.result };

  const http = createServer();
  attachRealtime(http, { live });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const { port } = http.address() as AddressInfo;
  running = { http, origin: `http://127.0.0.1:${port}`, live, feed, clients: [] };
  return running;
}

afterEach(async () => {
  if (!running) return;
  for (const client of running.clients) client.close();
  running.live.stop();
  await new Promise<void>((resolve) => running?.http.close(() => resolve()));
  running = null;
});

function client(server: Running, namespace = '/live'): ClientSocket {
  const socket = connect(`${server.origin}${namespace}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  server.clients.push(socket);
  return socket;
}

function next<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event}`)), 3000);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function collect<T>(socket: ClientSocket, event: string): T[] {
  const out: T[] = [];
  socket.on(event, (payload: T) => out.push(payload));
  return out;
}

describe('the /live namespace', () => {
  it('lets a signed-out client in, and keeps the default namespace closed', async () => {
    const server = await start();
    const visitor = client(server);
    const sources = await next<LiveSourcePage>(visitor, LIVE_SOCKET_EVENTS.sources);
    expect(liveSourcePageSchema.parse(sources).items.map((source) => source.id)).toEqual([
      'renfe-cercanias',
    ]);

    const anonymousDefault = client(server, '/');
    const error = await next<Error>(anonymousDefault, 'connect_error');
    expect(error).toBeInstanceOf(Error);
  });

  it('answers a subscription with its rooms, then a snapshot per room, then deltas', async () => {
    const server = await start();
    const visitor = client(server);
    await next(visitor, 'connect');
    const answer = next<LiveSubscriptionState>(visitor, LIVE_SOCKET_EVENTS.subscription);
    const snapshot = next<LiveSnapshot>(visitor, LIVE_SOCKET_EVENTS.snapshot);
    visitor.emit(LIVE_SOCKET_EVENTS.subscribe, {
      ...BARCELONA_BOX,
      zoom: 12,
      kinds: ['transit', 'aircraft'],
    });
    expect(liveSubscriptionStateSchema.parse(await answer)).toEqual({
      state: 'ok',
      tiles: [liveTileOf({ latitude: 41.39, longitude: 2.17 })],
      kinds: ['transit', 'aircraft'],
      retryAfterSeconds: null,
    });
    // Nothing polled yet: an empty, authoritative snapshot.
    expect(liveSnapshotSchema.parse(await snapshot).entities).toEqual([]);

    const delta = next<LiveDelta>(visitor, LIVE_SOCKET_EVENTS.delta);
    await server.live.hub.tick();
    const received = liveDeltaSchema.parse(await delta);
    expect(received.upserts.map((entity) => entity.id)).toEqual(['renfe-cercanias:1']);
    expect(received.tile).toBe('7/64/47');
  });

  it('sends a room only to its members', async () => {
    const server = await start();
    const barcelona = client(server);
    const newYork = client(server);
    await Promise.all([next(barcelona, 'connect'), next(newYork, 'connect')]);
    const nyDeltas = collect<LiveDelta>(newYork, LIVE_SOCKET_EVENTS.delta);
    const bcnAnswer = next(barcelona, LIVE_SOCKET_EVENTS.subscription);
    const nyAnswer = next(newYork, LIVE_SOCKET_EVENTS.subscription);
    barcelona.emit(LIVE_SOCKET_EVENTS.subscribe, {
      ...BARCELONA_BOX,
      zoom: 12,
      kinds: ['transit'],
    });
    newYork.emit(LIVE_SOCKET_EVENTS.subscribe, { ...NEW_YORK_BOX, zoom: 12, kinds: ['transit'] });
    await Promise.all([bcnAnswer, nyAnswer]);
    const delta = next<LiveDelta>(barcelona, LIVE_SOCKET_EVENTS.delta);
    await server.live.hub.tick();
    await delta;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(nyDeltas).toEqual([]);
  });

  it('refuses a too-wide or malformed subscription without joining anything', async () => {
    const server = await start();
    const visitor = client(server);
    await next(visitor, 'connect');
    let answer = next<LiveSubscriptionState>(visitor, LIVE_SOCKET_EVENTS.subscription);
    visitor.emit(LIVE_SOCKET_EVENTS.subscribe, {
      west: -30,
      south: 20,
      east: 30,
      north: 60,
      zoom: 3,
      kinds: ['transit'],
    });
    expect(await answer).toMatchObject({ state: 'too_wide', tiles: [], kinds: [] });

    for (const junk of [
      null,
      'hello',
      { ...BARCELONA_BOX },
      { ...BARCELONA_BOX, zoom: 12, kinds: ['ufo'] },
      { ...BARCELONA_BOX, zoom: 12, kinds: ['transit'], userId: 'x' },
      { ...BARCELONA_BOX, south: 50, zoom: 12, kinds: ['transit'] },
    ]) {
      answer = next<LiveSubscriptionState>(visitor, LIVE_SOCKET_EVENTS.subscription);
      visitor.emit(LIVE_SOCKET_EVENTS.subscribe, junk);
      expect(await answer).toMatchObject({ state: 'invalid', tiles: [] });
    }
  });

  it('rate-limits subscriptions and keeps the rooms it had', async () => {
    const server = await start({ subscribeBurst: 2, subscribePerMinute: 6 });
    const visitor = client(server);
    await next(visitor, 'connect');
    const answers = collect<LiveSubscriptionState>(visitor, LIVE_SOCKET_EVENTS.subscription);
    for (let index = 0; index < 3; index++) {
      visitor.emit(LIVE_SOCKET_EVENTS.subscribe, {
        ...BARCELONA_BOX,
        zoom: 12,
        kinds: ['transit'],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(answers.map((answer) => answer.state)).toEqual(['ok', 'ok', 'rate_limited']);
    expect(answers[2]).toMatchObject({ tiles: ['7/64/47'], retryAfterSeconds: 10 });
  });

  it('refuses the handshake beyond the connection cap', async () => {
    const server = await start({ maxConnections: 1 });
    const first = client(server);
    await next(first, 'connect');
    const second = client(server);
    const error = await next<Error>(second, 'connect_error');
    expect(error.message).toBe('live_capacity');
  });
});

describe('the subscription bucket', () => {
  it('refills at its rate', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1, () => now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([0, 0, 1]);
    now = 1000;
    expect(bucket.take()).toBe(0);
  });
});

describe('live configuration', () => {
  it('lists nothing by default and refuses unknown sources and malformed URLs', () => {
    expect(parseLiveConfig({}, ['adsb-lol'])).toMatchObject({ sources: [] });
    expect(() => parseLiveConfig({ LIVE_SOURCES: 'adsb-lol,nope' }, ['adsb-lol'])).toThrow(
      /unknown source "nope"/,
    );
    expect(() =>
      parseLiveConfig({ LIVE_SOURCES: 'adsb-lol', LIVE_SOURCE_ADSB_LOL_URL: 'https://x/?key=1' }, [
        'adsb-lol',
      ]),
    ).toThrow(/LIVE_SOURCE_ADSB_LOL_URL/);
    const parsed = parseLiveConfig(
      {
        LIVE_SOURCES: ' adsb-lol, adsb-lol ',
        LIVE_SOURCE_ADSB_LOL_URL: 'https://mirror.example/',
        LIVE_SOURCE_ADSB_LOL_KEY: ' k ',
      },
      ['adsb-lol'],
    );
    expect(parsed).toMatchObject({
      sources: ['adsb-lol'],
      settings: { 'adsb-lol': { url: 'https://mirror.example', key: 'k' } },
    });
  });

  it('is on exactly when a source is listed: no switch, and the retired one is ignored', () => {
    const logger = { info: () => {}, warn: () => {} };
    expect(createLiveService({ config: parseLiveConfig({}, []), logger })).toBeNull();
    expect(
      createLiveService({ config: parseLiveConfig({ LIVE_ENABLED: '1' }, []), logger }),
    ).toBeNull();
    const listed = createLiveService({
      config: parseLiveConfig({ LIVE_ENABLED: 'false', LIVE_SOURCES: 'renfe-cercanias' }, [
        'renfe-cercanias',
      ]),
      logger,
    });
    expect(listed).not.toBeNull();
    listed?.stop();
  });
});
