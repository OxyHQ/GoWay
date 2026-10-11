/**
 * The client's live state and its honesty rules: dead reckoning only within
 * a short bound, stale things drawn faded at their last REAL fix, expired
 * things gone, nothing moved without a speed or two fixes, and ages measured
 * on the server's clock.
 */
import { describe, expect, test } from 'bun:test';
import type { LiveEntity, LiveSource } from '@goway.to/sdk/live';

import {
  derivedVelocity,
  extrapolationBoundSeconds,
  freshnessOf,
  headingOf,
  offsetMeters,
  positionAt,
  velocityOf,
} from '../motion';
import { BLEND_MS, LiveStore, type ShapeSource } from '../liveStore';
import { consistAlong, consistStraight, pointAlong, type TrackShape } from '../track';

const T0 = Date.parse('2026-10-11T12:00:00Z');
const ALL = new Set(['aircraft', 'transit', 'bikeshare', 'vessel'] as const);

function source(id: string, staleAfterSeconds: number, dropAfterSeconds: number): LiveSource {
  return {
    id,
    kind: 'aircraft',
    name: id,
    attribution: { label: id, href: 'https://example.org' },
    licence: { label: 'ODbL 1.0', href: 'https://example.org/l' },
    coverage: null,
    completeness: 'network',
    status: 'live',
    lastUpdatedAt: new Date(T0).toISOString(),
    pollIntervalSeconds: 10,
    staleAfterSeconds,
    dropAfterSeconds,
    entityCount: 1,
  };
}

function aircraft(overrides: Partial<Extract<LiveEntity, { kind: 'aircraft' }>> = {}): LiveEntity {
  return {
    kind: 'aircraft',
    id: 'adsb-lol:abc123',
    sourceId: 'adsb-lol',
    position: { latitude: 41.3, longitude: 2.1 },
    headingDegrees: 90,
    speedMetersPerSecond: 200,
    observedAt: new Date(T0).toISOString(),
    icao24: 'abc123',
    callsign: 'VLG12',
    registration: null,
    typeCode: 'A321',
    altitudeMeters: 900,
    altitudeReference: 'geometric',
    verticalRateMetersPerSecond: null,
    onGround: false,
    ...overrides,
  };
}

function train(
  id: string,
  latitude: number,
  longitude: number,
  at: number,
  track: { shapeId: string; alongMeters: number } | null = null,
  trackStatus: 'on_track' | 'off_track' | 'unknown' = track ? 'on_track' : 'unknown',
): LiveEntity {
  return {
    kind: 'transit',
    id: `renfe-cercanias:${id}`,
    sourceId: 'renfe-cercanias',
    position: { latitude, longitude },
    headingDegrees: null,
    speedMetersPerSecond: null,
    observedAt: new Date(at).toISOString(),
    mode: 'rail',
    operator: 'Renfe',
    line: 'R2N',
    headsign: null,
    vehicleLabel: null,
    lineColor: '#D0DF00',
    lineTextColor: '#FFFFFF',
    track: track ? { ...track, offsetMeters: 0 } : null,
    trackStatus,
    positionBasis: 'reported',
  };
}

const message = (entities: LiveEntity[], at = T0) => ({
  tile: '7/64/47',
  kind: entities[0]?.kind ?? ('aircraft' as const),
  at: new Date(at).toISOString(),
  entities,
});

describe('motion', () => {
  test('a reported speed and course become a velocity; nothing else does', () => {
    const v = velocityOf(100, 90);
    expect(v?.east).toBeCloseTo(100, 6);
    expect(v?.north).toBeCloseTo(0, 6);
    expect(velocityOf(null, 90)).toBeNull();
    expect(velocityOf(100, null)).toBeNull();
    expect(headingOf(v)).toBeCloseTo(90, 6);
  });

  test('two fixes give a velocity only when they honestly can', () => {
    const a = { latitude: 41.3, longitude: 2.1, at: T0 };
    const b = { latitude: 41.301, longitude: 2.1, at: T0 + 20_000 }; // ~111 m north in 20 s
    expect(derivedVelocity('transit', a, b)?.north).toBeCloseTo(5.56, 1);
    expect(derivedVelocity('transit', a, { ...b, at: T0 + 1000 })).toBeNull(); // re-sent
    expect(derivedVelocity('transit', a, { ...b, at: T0 + 600_000 })).toBeNull(); // too far apart
    expect(
      derivedVelocity('transit', a, { latitude: 42.3, longitude: 2.1, at: T0 + 20_000 }),
    ).toBeNull(); // 111 km in 20 s
    expect(derivedVelocity('transit', a, { ...a, at: T0 + 20_000 })).toBeNull(); // standing still
  });

  test('dead reckoning stops at the bound, and a stale thing sits at its fix', () => {
    const fix = { latitude: 41.3, longitude: 2.1, at: T0 };
    const east = { east: 100, north: 0 };
    const bound = extrapolationBoundSeconds('aircraft', 45);
    expect(bound).toBe(20);
    const at5 = positionAt(fix, east, T0 + 5000, bound, 'fresh');
    expect(offsetMeters(fix, at5).east).toBeCloseTo(500, 0);
    const at25 = positionAt(fix, east, T0 + 25_000, bound, 'fresh');
    expect(offsetMeters(fix, at25).east).toBeCloseTo(2000, 0); // held at 20 s
    expect(positionAt(fix, east, T0 + 40_000, bound, 'stale')).toEqual({
      latitude: 41.3,
      longitude: 2.1,
    });
    expect(extrapolationBoundSeconds('bikeshare', 1800)).toBe(0);
  });

  test('freshness by age', () => {
    expect(freshnessOf(10, 30, 90)).toBe('fresh');
    expect(freshnessOf(31, 30, 90)).toBe('stale');
    expect(freshnessOf(91, 30, 90)).toBe('expired');
  });
});

describe('LiveStore', () => {
  test('measures ages on the server clock, not the device clock', () => {
    // The device is two minutes behind the server.
    let device = T0 - 120_000;
    const store = new LiveStore(() => device);
    store.setSources([source('adsb-lol', 30, 90)]);
    store.applySnapshot(message([aircraft()], T0 + 5000));
    const [sample] = store.sample(ALL);
    expect(sample?.ageSeconds).toBeCloseTo(5, 3);
    expect(sample?.freshness).toBe('fresh');
    device += 30_000;
    expect(store.sample(ALL)[0]?.freshness).toBe('stale');
  });

  test('moves a fresh aircraft along its course, fades it when stale, drops it when expired', () => {
    let now = T0;
    const store = new LiveStore(() => now);
    store.setSources([source('adsb-lol', 30, 90)]);
    store.applySnapshot(message([aircraft()]));
    now = T0 + 10_000;
    const moving = store.sample(ALL)[0];
    expect(moving?.moving).toBe(true);
    expect(
      offsetMeters(
        { latitude: 41.3, longitude: 2.1, at: 0 },
        moving ?? { latitude: 0, longitude: 0 },
      ).east,
    ).toBeCloseTo(2000, -1);
    now = T0 + 31_000 + BLEND_MS;
    store.sample(ALL); // the transition to stale starts an ease back
    now += BLEND_MS;
    const stale = store.sample(ALL)[0];
    expect(stale?.freshness).toBe('stale');
    expect(stale?.opacity).toBeLessThan(0.5);
    expect(stale?.latitude).toBeCloseTo(41.3, 6);
    expect(stale?.longitude).toBeCloseTo(2.1, 6);
    expect(stale?.moving).toBe(false);
    now = T0 + 91_000;
    expect(store.sample(ALL)).toEqual([]);
    expect(store.size).toBe(0);
  });

  test('a train off any known track stays exactly where reported, marked approximate', () => {
    let now = T0;
    const store = new LiveStore(() => now);
    store.applySnapshot(message([train('1', 41.3, 2.1, T0, null, 'off_track')]));
    store.applySnapshot(
      message([train('1', 41.301, 2.1, T0 + 20_000, null, 'off_track')], T0 + 20_000),
    );
    now += 10_000;
    const sample = store.sample(ALL)[0];
    // No straight line between the two reports: that path was never published.
    expect(sample?.latitude).toBe(41.301);
    expect(sample?.moving).toBe(false);
    expect(sample?.approximate).toBe(true);
  });

  test('a snapshot is authoritative for its room; a remove only removes from its own room', () => {
    const store = new LiveStore(() => T0);
    store.applySnapshot(message([train('a', 41.3, 2.1, T0), train('b', 41.31, 2.11, T0)]));
    store.applySnapshot(message([train('a', 41.3, 2.1, T0)]));
    expect(store.get('renfe-cercanias:b')).toBeUndefined();
    // `a` moved to another room: its new room's upsert arrived first.
    store.applyDelta({
      tile: '7/64/48',
      kind: 'transit',
      at: new Date(T0).toISOString(),
      upserts: [train('a', 40.9, 2.1, T0 + 1)],
      removes: [],
    });
    store.applyDelta({
      tile: '7/64/47',
      kind: 'transit',
      at: new Date(T0).toISOString(),
      upserts: [],
      removes: ['renfe-cercanias:a'],
    });
    expect(store.get('renfe-cercanias:a')?.position.latitude).toBe(40.9);
    // Leaving a room drops what it held.
    store.retain(['7/64/47'], ['transit']);
    expect(store.size).toBe(0);
  });

  test('ignores an older fix arriving after a newer one', () => {
    const store = new LiveStore(() => T0);
    store.applySnapshot(message([train('a', 41.31, 2.1, T0)]));
    store.applyDelta({
      tile: '7/64/47',
      kind: 'transit',
      at: new Date(T0).toISOString(),
      upserts: [train('a', 41.3, 2.1, T0 - 20_000)],
      removes: [],
    });
    expect(store.get('renfe-cercanias:a')?.position.latitude).toBe(41.31);
  });

  test('samples only the kinds that are on', () => {
    const store = new LiveStore(() => T0);
    store.applySnapshot(message([aircraft()]));
    expect(store.sample(new Set(['transit']))).toEqual([]);
    expect(store.sample(new Set(['aircraft']))).toHaveLength(1);
  });

  test('eases a correction instead of jumping', () => {
    let now = T0;
    const store = new LiveStore(() => now);
    store.setSources([source('adsb-lol', 30, 90)]);
    store.applySnapshot(message([aircraft()]));
    now = T0 + 10_000;
    const predicted = store.sample(ALL)[0];
    // The new fix lands 1 km short of the prediction.
    store.applyDelta({
      tile: '7/64/47',
      kind: 'aircraft',
      at: new Date(now).toISOString(),
      upserts: [
        aircraft({
          position: { latitude: 41.3, longitude: 2.112 },
          observedAt: new Date(now).toISOString(),
        }),
      ],
      removes: [],
    });
    const rightAfter = store.sample(ALL)[0];
    expect(rightAfter?.longitude).toBeCloseTo(predicted?.longitude ?? 0, 4);
    now += BLEND_MS;
    // On the new fix's own track: 0.9 s of 200 m/s east past it.
    const settled = store.sample(ALL)[0];
    expect(
      offsetMeters(
        { latitude: 41.3, longitude: 2.112, at: 0 },
        settled ?? { latitude: 0, longitude: 0 },
      ).east,
    ).toBeCloseTo(180, 0);
  });
});

// ---------------------------------------------------------------------------
// Along a published track
// ---------------------------------------------------------------------------

/** A shape: a line `[lon, lat]` with its running length (equirectangular, as the server measures). */
function shapeOf(points: [number, number][]): TrackShape {
  const along = [0];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] as [number, number];
    const [x1, y1] = points[i] as [number, number];
    const dx = (x1 - x0) * Math.cos((((y0 + y1) / 2) * Math.PI) / 180) * 111_195;
    const dy = (y1 - y0) * 111_195;
    along.push((along[i - 1] as number) + Math.hypot(dx, dy));
  }
  return { coordinates: points, alongMeters: along, lengthMeters: along.at(-1) as number };
}

// An L: ~834 m east, then ~1112 m north. A straight line between a point on
// each leg cuts the corner; the track does not.
const ELL = shapeOf([
  [2.1, 41.4],
  [2.11, 41.4],
  [2.11, 41.41],
]);
// A branch: the same trunk east, then a second branch turning SOUTH.
const BRANCH = shapeOf([
  [2.1, 41.4],
  [2.11, 41.4],
  [2.11, 41.39],
]);
const SHAPES: ShapeSource = {
  get: (_source, id) => ({ ell: ELL, branch: BRANCH })[id as 'ell' | 'branch'],
};

describe('the track', () => {
  test('asks to load a line only for a vehicle inside the shape area', () => {
    const asked: [string, boolean | undefined][] = [];
    const store = new LiveStore(() => T0, {
      get: (_source, id, load) => {
        asked.push([id, load]);
        return undefined;
      },
    });
    store.applySnapshot(
      message([train('1', 41.4, 2.105, T0, { shapeId: 'ell', alongMeters: 417 })]),
    );
    store.sample(ALL);
    store.setShapeArea({ west: 2.0, south: 41.3, east: 2.2, north: 41.5 });
    store.sample(ALL);
    store.setShapeArea({ west: -74.1, south: 40.6, east: -73.8, north: 40.9 });
    store.sample(ALL);
    expect(asked).toEqual([
      ['ell', false],
      ['ell', true],
      ['ell', false],
    ]);
  });

  test('reads position and heading at a distance, clamped to the line', () => {
    expect(pointAlong(ELL, 0)).toMatchObject({ latitude: 41.4, longitude: 2.1 });
    expect(pointAlong(ELL, 417).heading).toBeCloseTo(90, 0); // east
    expect(pointAlong(ELL, 1000).heading).toBeCloseTo(0, 0); // north, after the corner
    expect(pointAlong(ELL, 99_999)).toMatchObject({ latitude: 41.41, longitude: 2.11 });
  });

  test('lays a consist along the curve, each car on the line and turned to it', () => {
    // A 3-car train centred on the corner.
    const cars = consistAlong(ELL, 834, 3, 20, 1);
    expect(cars[0]?.heading).toBeCloseTo(0, 0); // the leading car is round the corner
    expect(cars[2]?.heading).toBeCloseTo(90, 0); // the last is still on the east leg
    expect(cars[2]?.latitude).toBeCloseTo(41.4, 6);
    // Off a track, the same cars in a straight line along the heading.
    const straight = consistStraight({ latitude: 41.4, longitude: 2.1 }, 90, 3, 20, 1);
    expect(straight.every((car) => Math.abs(car.latitude - 41.4) < 1e-9)).toBe(true);
    expect(straight[0]?.longitude).toBeGreaterThan(straight[2]?.longitude ?? 0);
  });

  test('walks a train ALONG its track between fixes — round the corner, never across it', () => {
    let now = T0;
    const store = new LiveStore(() => now, SHAPES);
    store.applySnapshot(
      message([train('1', 41.4, 2.105, T0, { shapeId: 'ell', alongMeters: 417 })]),
    );
    expect(store.sample(ALL)[0]).toMatchObject({ approximate: false, moving: false });
    // The next fix is on the north leg, 1,300 m along, 30 s later.
    store.applySnapshot(
      message(
        [train('1', 41.4042, 2.11, T0 + 30_000, { shapeId: 'ell', alongMeters: 1300 })],
        T0 + 30_000,
      ),
    );
    now += 15_000; // half the walk
    const half = store.sample(ALL)[0];
    expect(half?.onTrack?.along).toBeCloseTo(858.5, 0);
    // On the line at that distance: just past the corner, on the north leg —
    // where a straight line between the fixes would be ~200 m inside the L.
    expect(half?.longitude).toBeCloseTo(2.11, 6);
    expect(half?.heading).toBeCloseTo(0, 0);
    now += 15_000;
    expect(store.sample(ALL)[0]?.onTrack?.along).toBeCloseTo(1300, 3);
    now += 20_000;
    expect(store.sample(ALL)[0]?.onTrack?.along).toBeCloseTo(1300, 3); // and stops at the fix
  });

  test('follows its own branch at a junction', () => {
    let now = T0;
    const store = new LiveStore(() => now, SHAPES);
    store.applySnapshot(
      message([train('1', 41.4, 2.105, T0, { shapeId: 'branch', alongMeters: 417 })]),
    );
    store.applySnapshot(
      message(
        [train('1', 41.396, 2.11, T0 + 30_000, { shapeId: 'branch', alongMeters: 1280 })],
        T0 + 30_000,
      ),
    );
    now += 25_000;
    const sample = store.sample(ALL)[0];
    expect(sample?.latitude).toBeLessThan(41.4); // south, on its branch
    expect(sample?.heading).toBeCloseTo(180, 0);
  });

  test('a new shape is a jump, not a walk', () => {
    let now = T0;
    const store = new LiveStore(() => now, SHAPES);
    store.applySnapshot(
      message([train('1', 41.4, 2.105, T0, { shapeId: 'ell', alongMeters: 417 })]),
    );
    store.applySnapshot(
      message(
        [train('1', 41.396, 2.11, T0 + 30_000, { shapeId: 'branch', alongMeters: 1280 })],
        T0 + 30_000,
      ),
    );
    now += 1;
    expect(store.sample(ALL)[0]?.onTrack?.along).toBeCloseTo(1280, 3);
  });
});
