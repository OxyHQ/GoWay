/**
 * The pairing half of duplicate detection — the part that has to survive a
 * country's worth of identically named pharmacies.
 */

import { describe, expect, test } from 'bun:test';
import { DUPLICATE_PROXIMITY_METERS, distanceMetres, pairsWithin } from '../duplicates';

const BARCELONA = { latitude: 41.385_1, longitude: 2.173_4 };

/** A place `metres` north of Barcelona. */
function north(id: string, metres: number) {
  return { id, latitude: BARCELONA.latitude + metres / 111_320, longitude: BARCELONA.longitude };
}

describe('distanceMetres', () => {
  test('measures a known distance rather than a coordinate difference', () => {
    // Barcelona to Madrid, ~505 km — the same independently checkable distance
    // `places-geo.realdb.test.ts` uses to prove the ordinate order.
    const madrid = { id: 'madrid', latitude: 40.4168, longitude: -3.7038 };
    const barcelona = { id: 'barcelona', ...BARCELONA };
    expect(distanceMetres(barcelona, madrid) / 1000).toBeCloseTo(505, 0);
  });
});

describe('pairsWithin', () => {
  test('pairs two places inside the radius and not two outside it', () => {
    expect(pairsWithin([north('a', 0), north('b', 40)], DUPLICATE_PROXIMITY_METERS)).toEqual([
      ['a', 'b'],
    ]);
    expect(pairsWithin([north('a', 0), north('b', 400)], DUPLICATE_PROXIMITY_METERS)).toEqual([]);
  });

  test('puts a pair in canonical id order whichever side it started from', () => {
    expect(pairsWithin([north('z', 0), north('a', 10)], DUPLICATE_PROXIMITY_METERS)).toEqual([
      ['a', 'z'],
    ]);
  });

  test('reports each pair once', () => {
    const pairs = pairsWithin([north('a', 0), north('b', 10), north('c', 20)], DUPLICATE_PROXIMITY_METERS);
    expect(pairs.sort()).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });

  test('a country of identically named places costs its local density, not its size', () => {
    // Twenty thousand `farmacia` spread over Spain: the self-join this replaces
    // is four hundred million pairs. Two of them are actually within 75 m.
    const group = Array.from({ length: 20_000 }, (_, index) => ({
      id: `p${index}`,
      latitude: 36 + (index * 7) / 111_320 / 10,
      longitude: -9 + index * 0.0007,
    }));
    group.push({ id: 'twin-a', latitude: 41.3, longitude: 2.1 });
    group.push({ id: 'twin-b', latitude: 41.3 + 20 / 111_320, longitude: 2.1 });

    const started = Date.now();
    const pairs = pairsWithin(group, DUPLICATE_PROXIMITY_METERS);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pairs).toContainEqual(['twin-a', 'twin-b']);
  });

  test('ignores longitude separation that latitude alone would admit', () => {
    const pairs = pairsWithin(
      [
        { id: 'a', latitude: 41.3851, longitude: 2.1734 },
        { id: 'b', latitude: 41.3851, longitude: 2.9 },
      ],
      DUPLICATE_PROXIMITY_METERS,
    );
    expect(pairs).toEqual([]);
  });
});
