import { describe, expect, it } from 'vitest';
import { createGoWayClient, GoWayUnavailableError } from '../src/index';
import {
  LIVE_SOCKET_EVENTS,
  LIVE_SOCKET_NAMESPACE,
  liveSubscription,
  liveTileOf,
  liveTilesFor,
  parseLiveDelta,
  parseLiveSnapshot,
  parseLiveSources,
  parseLiveSubscriptionState,
} from '../src/live';
import { fakeFetch, rejection } from './helpers';

const source = {
  id: 'renfe-cercanias',
  kind: 'transit',
  name: 'Trains — Renfe Cercanías and Rodalies',
  attribution: { label: 'Origen de los datos: Renfe Operadora', href: 'https://data.renfe.com' },
  licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
  coverage: { west: -9.6, south: 35.8, east: 4.6, north: 44 },
  completeness: 'network',
  status: 'live',
  lastUpdatedAt: '2026-10-11T12:00:00.000Z',
  pollIntervalSeconds: 20,
  staleAfterSeconds: 120,
  dropAfterSeconds: 600,
  entityCount: 50,
};

const train = {
  kind: 'transit',
  id: 'renfe-cercanias:28436',
  sourceId: 'renfe-cercanias',
  position: { latitude: 41.39, longitude: 2.17 },
  headingDegrees: null,
  speedMetersPerSecond: null,
  observedAt: '2026-10-11T11:59:57.000Z',
  mode: 'rail',
  operator: 'Renfe',
  line: 'R2N',
  headsign: null,
  vehicleLabel: '28436',
  lineColor: '#D0DF00',
  lineTextColor: '#FFFFFF',
  track: { shapeId: '51_R2N', alongMeters: 1200.5, offsetMeters: 0.1 },
  trackStatus: 'on_track',
  positionBasis: 'reported',
};

describe('goway.live.sources', () => {
  it('reads the feeds and their terms', async () => {
    const { fetch, calls } = fakeFetch(200, { items: [source], nextCursor: null });
    const page = await createGoWayClient({ fetch }).live.sources();
    expect(page.items[0]?.attribution.label).toBe('Origen de los datos: Renfe Operadora');
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/live/sources');
  });

  it('maps a deployment without live to GoWayUnavailableError', async () => {
    const { fetch } = fakeFetch(503, {
      error: { code: 'service_unavailable', message: 'The live layer is not available.' },
    });
    const error = await rejection(createGoWayClient({ fetch }).live.sources());
    expect(error).toBeInstanceOf(GoWayUnavailableError);
  });
});

describe('goway.live.shape', () => {
  it('reads an operator shape by source and id', async () => {
    const { fetch, calls } = fakeFetch(200, {
      sourceId: 'renfe-cercanias',
      id: '51_R2N',
      coordinates: [
        [2.1, 41.3],
        [2.2, 41.4],
      ],
      alongMeters: [0, 13_500],
      lengthMeters: 13_500,
    });
    const shape = await createGoWayClient({ fetch }).live.shape('renfe-cercanias', '51_R2N');
    expect(shape.lengthMeters).toBe(13_500);
    expect(calls[0]?.url).toBe(
      'https://api.goway.to/api/v1/live/sources/renfe-cercanias/shapes/51_R2N',
    );
  });
});

describe('@goway.to/sdk/live', () => {
  it('names the namespace and events', () => {
    expect(LIVE_SOCKET_NAMESPACE).toBe('/live');
    expect(LIVE_SOCKET_EVENTS.delta).toBe('live:delta');
  });

  it('parses messages, and answers null for anything else', () => {
    expect(
      parseLiveSnapshot({
        tile: '7/64/47',
        kind: 'transit',
        at: '2026-10-11T12:00:00Z',
        entities: [train],
      })?.entities,
    ).toHaveLength(1);
    expect(
      parseLiveDelta({
        tile: '7/64/47',
        kind: 'transit',
        at: '2026-10-11T12:00:00Z',
        upserts: [],
        removes: ['renfe-cercanias:1'],
      })?.removes,
    ).toEqual(['renfe-cercanias:1']);
    expect(parseLiveSources({ items: [source], nextCursor: null })?.items).toHaveLength(1);
    expect(
      parseLiveSubscriptionState({
        state: 'ok',
        tiles: ['7/64/47'],
        kinds: ['transit'],
        retryAfterSeconds: null,
      })?.state,
    ).toBe('ok');
    for (const junk of [
      null,
      'x',
      {},
      { tile: '9/1/1', kind: 'transit', at: 'now', entities: [] },
      {
        tile: '7/64/47',
        kind: 'transit',
        at: '2026-10-11T12:00:00Z',
        entities: [{ ...train, position: { latitude: 200, longitude: 0 } }],
      },
    ]) {
      expect(parseLiveSnapshot(junk)).toBeNull();
    }
  });

  it('checks a subscription before it is sent', () => {
    expect(
      liveSubscription({
        west: 2.05,
        south: 41.32,
        east: 2.25,
        north: 41.47,
        zoom: 12,
        kinds: ['aircraft'],
      }).kinds,
    ).toEqual(['aircraft']);
    expect(() =>
      liveSubscription({ west: 2, south: 42, east: 3, north: 41, zoom: 12, kinds: ['aircraft'] }),
    ).toThrow(TypeError);
  });

  it('computes the same rooms the server does', () => {
    expect(liveTileOf({ latitude: 41.39, longitude: 2.17 })).toBe('7/64/47');
    expect(liveTilesFor({ west: 2.05, south: 41.32, east: 2.25, north: 41.47 })).toEqual([
      '7/64/47',
    ]);
  });
});
