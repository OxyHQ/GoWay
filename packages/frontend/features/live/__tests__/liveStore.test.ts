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
import { BLEND_MS, LiveStore } from '../liveStore';

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

function train(id: string, latitude: number, longitude: number, at: number): LiveEntity {
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

  test('never predicts a thing with no speed: it walks between its real fixes', () => {
    let now = T0;
    const store = new LiveStore(() => now);
    store.applySnapshot(message([train('1', 41.3, 2.1, T0)]));
    now = T0 + 5000;
    expect(store.sample(ALL)[0]?.moving).toBe(false);
    expect(store.sample(ALL)[0]?.latitude).toBe(41.3);
    // The next real fix, 20 s later and ~111 m north.
    store.applySnapshot(message([train('1', 41.301, 2.1, T0 + 20_000)], T0 + 20_000));
    now += 10_000; // half the 20 s between the two fixes
    const halfway = store.sample(ALL)[0];
    expect(halfway?.moving).toBe(true);
    expect(halfway?.latitude).toBeCloseTo(41.3005, 5);
    expect(halfway?.heading).toBeCloseTo(0, 0); // north: the course between the fixes
    now += 10_000;
    const arrived = store.sample(ALL)[0];
    expect(arrived?.latitude).toBeCloseTo(41.301, 6);
    // ...and stops there: nothing past the latest real fix.
    now += 15_000;
    expect(store.sample(ALL)[0]?.latitude).toBeCloseTo(41.301, 6);
    expect(store.sample(ALL)[0]?.moving).toBe(false);
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
