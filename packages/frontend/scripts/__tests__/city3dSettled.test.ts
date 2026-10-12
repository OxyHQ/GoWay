/** When the visibility gate counts a view as settled (`scripts/city3dSettled.ts`). */
import { describe, expect, test } from 'bun:test';

import { type PublishedStats, unsettled } from '../city3dSettled';

const city = { tilesWanted: 16, tilesLoaded: 16, tilesPending: 0, uploadsQueued: 0 };
const streets = { tilesWanted: 4, tilesSettled: 4, pending: 0 };
const landmarks = {
  loaded: true,
  held: ['sagrada-familia'],
  drawn: ['sagrada-familia'],
  failed: [] as string[],
};
const all: PublishedStats = { city, streets, landmarks };
const wants = { streets: true, landmark: 'sagrada-familia' };

describe('unsettled', () => {
  test('settled when the city, the streets and the landmark are all in', () => {
    expect(unsettled(all, wants)).toBeNull();
    expect(unsettled({ city }, { streets: false, landmark: null })).toBeNull();
  });

  test('the city: wanted, loaded, nothing pending or queued', () => {
    expect(unsettled({ ...all, city: undefined }, wants)).toBe('city: no stats');
    expect(unsettled({ ...all, city: { ...city, tilesWanted: 0, tilesLoaded: 0 } }, wants)).toMatch(
      /wants no tiles/,
    );
    expect(unsettled({ ...all, city: { ...city, tilesPending: 1 } }, wants)).toMatch(/pending/);
    expect(unsettled({ ...all, city: { ...city, uploadsQueued: 2 } }, wants)).toMatch(/upload/);
    expect(unsettled({ ...all, city: { ...city, tilesLoaded: 15 } }, wants)).toMatch(/15\/16/);
  });

  test('the streets: every wanted tile answered — one drawn tile is not enough', () => {
    // What CI read for minutes: two of four tiles drawn, two still pending.
    expect(
      unsettled({ ...all, streets: { tilesWanted: 4, tilesSettled: 2, pending: 2 } }, wants),
    ).toMatch(/2 pending/);
    expect(
      unsettled({ ...all, streets: { tilesWanted: 4, tilesSettled: 3, pending: 0 } }, wants),
    ).toMatch(/3\/4/);
    // A build that does not publish the settled count cannot pass as settled.
    expect(unsettled({ ...all, streets: { pending: 0 } }, wants)).toMatch(/no settled count/);
    expect(unsettled({ ...all, streets: undefined }, wants)).toBe('streets: no stats');
    expect(unsettled({ ...all, streets: undefined }, { ...wants, streets: false })).toBeNull();
  });

  test('the landmark: read, held and drawn — or failed, which settles too', () => {
    expect(unsettled({ ...all, landmarks: undefined }, wants)).toMatch(/registry/);
    expect(unsettled({ ...all, landmarks: { ...landmarks, held: [] } }, wants)).toMatch(/not held/);
    expect(unsettled({ ...all, landmarks: { ...landmarks, drawn: [] } }, wants)).toMatch(
      /not drawn/,
    );
    expect(
      unsettled(
        { ...all, landmarks: { ...landmarks, drawn: [], failed: ['sagrada-familia'] } },
        wants,
      ),
    ).toBeNull();
    expect(unsettled({ ...all, landmarks: undefined }, { ...wants, landmark: null })).toBeNull();
  });
});
