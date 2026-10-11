/**
 * A sample → what the map draws. An estimate is styled as one and never
 * given a 3D model; a reported vehicle on its track gets its consist.
 */
import { describe, expect, test } from 'bun:test';
import type { LiveEntity } from '@goway.to/sdk/live';

import type { LiveSample } from '../liveStore';
import { pointOf } from '../points';

const SHAPE = {
  coordinates: [
    [-73.99, 40.75],
    [-73.98, 40.76],
  ] as [number, number][],
  alongMeters: [0, 1400],
  lengthMeters: 1400,
};

function sample(positionBasis: 'reported' | 'estimated'): LiveSample {
  const entity: LiveEntity = {
    kind: 'transit',
    id: 'mta-subway:1',
    sourceId: 'mta-subway',
    position: { latitude: 40.755, longitude: -73.985 },
    headingDegrees: null,
    speedMetersPerSecond: null,
    observedAt: '2026-10-11T12:00:00Z',
    mode: 'subway',
    operator: 'MTA',
    line: '1',
    headsign: null,
    vehicleLabel: null,
    lineColor: '#EE352E',
    lineTextColor: '#FFFFFF',
    track: { shapeId: '1..S03R', alongMeters: 700, offsetMeters: 0 },
    trackStatus: 'on_track',
    positionBasis,
  };
  return {
    entity,
    latitude: 40.755,
    longitude: -73.985,
    heading: 37,
    freshness: 'fresh',
    opacity: 1,
    ageSeconds: 5,
    moving: false,
    onTrack: { shape: SHAPE, along: 700 },
    approximate: false,
    estimated: positionBasis === 'estimated',
  };
}

describe('pointOf', () => {
  test('an estimated train is drawn flat, in the estimated style, with no 3D model', () => {
    const point = pointOf(sample('estimated'), null);
    expect(point.estimated).toBe(true);
    expect(point.model).toBeUndefined();
    expect(point.parts).toBeUndefined();
    expect(point.tint).toBe('#EE352E');
    // Still to scale: ten 51-ft cars.
    expect(point.length).toBeGreaterThan(150);
  });

  test('a reported train on its track gets its model and one part per car', () => {
    const point = pointOf(sample('reported'), null);
    expect(point.estimated).toBeUndefined();
    expect(point.model).toBe('mta-subway-a');
    expect(point.parts).toHaveLength(10);
  });
});
