import { describe, expect, test } from 'bun:test';
import type { Route } from '@goway.to/sdk';

import { ARRIVAL_METRES, guidanceAt, OFF_ROUTE_MIN_METRES, projectOnto } from '../guidance';
import type { RouteStep } from '../maneuvers';

// ~111 m per 0.001° of latitude. North 600 m, then east ~600 m, at the equator.
const LINE: [number, number][] = [
  [0, 0],
  [0, 0.003],
  [0, 0.006],
  [0.003, 0.006],
  [0.006, 0.006],
];
const route = { geometry: { type: 'LineString', coordinates: LINE } } as Pick<Route, 'geometry'>;

function step(index: number, geometryIndex: number, type: string): RouteStep {
  return {
    index,
    legIndex: 0,
    firstOfLeg: index === 0,
    maneuver: {
      type,
      instruction: type,
      distanceMeters: 0,
      durationSeconds: 0,
      coordinate: { latitude: LINE[geometryIndex][1], longitude: LINE[geometryIndex][0] },
      geometryIndex,
    },
    range: [geometryIndex, geometryIndex],
    exact: true,
  };
}

const STEPS: RouteStep[] = [step(0, 0, 'depart'), step(1, 2, 'turn-right'), step(2, 4, 'arrive')];

const at = (longitude: number, latitude: number, accuracy: number | null = 5) => ({
  longitude,
  latitude,
  accuracy,
});

describe('projectOnto', () => {
  test('puts a point on the line at its distance along it', () => {
    const projection = projectOnto(LINE, at(0, 0.003));
    expect(projection?.offset).toBeCloseTo(0, 3);
    expect(projection?.along).toBeCloseTo(333.6, 0);
  });

  test('measures how far from the line the point is', () => {
    const projection = projectOnto(LINE, at(0.0005, 0.001));
    expect(projection?.offset).toBeCloseTo(55.6, 0);
  });

  test('has nothing to project onto without a line', () => {
    expect(projectOnto([[0, 0]], at(0, 0))).toBeNull();
  });
});

describe('guidanceAt', () => {
  test('names the first maneuver ahead, with the distance ALONG the line', () => {
    const guidance = guidanceAt(route, STEPS, at(0, 0.001));
    expect(guidance?.next.maneuver.type).toBe('turn-right');
    // 0.005° of latitude still to go to the corner.
    expect(guidance?.distanceToNext).toBeCloseTo(556, -1);
    expect(guidance?.offRoute).toBe(false);
  });

  test('moves on to the next maneuver once the last one is behind', () => {
    const guidance = guidanceAt(route, STEPS, at(0.001, 0.006));
    expect(guidance?.next.maneuver.type).toBe('arrive');
  });

  test('says "then" only when the next maneuver follows soon', () => {
    // 600 m between the corner and the arrival is not "then".
    expect(guidanceAt(route, STEPS, at(0, 0.005))?.then).toBeNull();
    // A second turn at the same junction is.
    const close: RouteStep[] = [
      STEPS[0],
      STEPS[1],
      step(2, 2, 'turn-left'),
      { ...STEPS[2], index: 3 },
    ];
    expect(guidanceAt(route, close, at(0, 0.005))?.then?.maneuver.type).toBe('turn-left');
  });

  test('is off route only beyond what the device’s own uncertainty explains', () => {
    const away = at(0.0006, 0.002, 5); // ~67 m east of the line
    expect(guidanceAt(route, STEPS, away)?.offRoute).toBe(true);
    expect(guidanceAt(route, STEPS, at(0.0006, 0.002, 80))?.offRoute).toBe(false);
    expect(guidanceAt(route, STEPS, at(0.0002, 0.002, 5))?.offRoute).toBe(false);
    expect(OFF_ROUTE_MIN_METRES).toBeGreaterThan(0);
  });

  test('has arrived within reach of the end', () => {
    const near = at(0.006 - (ARRIVAL_METRES - 5) / 111_320, 0.006);
    expect(guidanceAt(route, STEPS, near)?.arrived).toBe(true);
    expect(guidanceAt(route, STEPS, at(0, 0.001))?.arrived).toBe(false);
  });

  test('has nothing to say without steps', () => {
    expect(guidanceAt(route, [], at(0, 0))).toBeNull();
  });
});
