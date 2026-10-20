/**
 * Saved lists in the app: the fixture layer answers what the API answers (the
 * SDK parses every body with the contract's schemas, so drift fails here), and
 * the "is it saved?" questions of every heart on screen travel as one request.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  createGoWayClient,
  GoWayConflictError,
  GoWayGoneError,
  GoWayNotFoundError,
  GoWayUnauthorizedError,
  iterateGoWayPages,
  MAX_SAVED_LISTS_PER_USER,
  SAVED_LIST_CONFLICT_DETAIL,
  type GoWayClient,
  type SavedPlaces,
} from '@goway.to/sdk';

import { FIXTURE_PLACES, FIXTURE_WITHDRAWN_PLACE_IDS } from '@/lib/goway/fixtures';
import { createFixtureFetch, setFixtureFaults } from '@/lib/goway/mockTransport';
import { createHoldBatcher } from '@/lib/goway/savedHolds';
import { savedFailureMessage } from '@/features/saved/savedErrors';
import { SAVED_EN } from '@/lib/messages/saved';
import { formatMessage } from '@/lib/i18n';

import { defined } from '../../__tests__/defined';

function signedIn(): GoWayClient {
  return createGoWayClient({
    apiBaseUrl: 'https://api.goway.to',
    getAccessToken: () => 'token',
    fetch: createFixtureFetch(),
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

afterEach(() => setFixtureFaults({}));

const [A, B, C] = FIXTURE_PLACES.map((place) => place.id);

describe('the fixture lists answer as the API does', () => {
  test('are the signed-in person alone', async () => {
    const anonymous = createGoWayClient({
      apiBaseUrl: 'https://api.goway.to',
      fetch: createFixtureFetch(),
    });
    expect(await failureOf(anonymous.lists.list())).toBeInstanceOf(GoWayUnauthorizedError);
  });

  test('create, rename, save a place once, reorder, note, remove, delete', async () => {
    const goway = signedIn();
    const list = await goway.lists.create({ name: 'Want to go' });
    expect(list).toMatchObject({ itemCount: 0, visibility: 'private', isDefault: false });

    const first = await goway.lists.items.add(list.id, { placeId: defined(A), note: 'Morning' });
    const second = await goway.lists.items.add(list.id, { placeId: defined(B) });
    const again = await goway.lists.items.add(list.id, { placeId: defined(A) });
    expect(again).toEqual(first);
    expect(second.position).toBeGreaterThan(first.position);
    expect((await goway.lists.get(list.id)).coverPlaceIds).toEqual([defined(A), defined(B)]);

    await goway.lists.items.order(list.id, { itemIds: [second.id] });
    const ordered = await goway.lists.items.list(list.id);
    expect(ordered.items.map((item) => item.id)).toEqual([second.id, first.id]);

    const noted = await goway.lists.items.setNote(list.id, first.id, { note: 'Late' });
    expect(noted.note).toBe('Late');
    expect(
      (await goway.lists.items.setNote(list.id, first.id, { note: null })).note,
    ).toBeUndefined();

    await goway.lists.items.remove(list.id, second.id);
    expect((await goway.lists.get(list.id)).itemCount).toBe(1);
    await goway.lists.rename(list.id, { name: 'Coffee' });
    await goway.lists.delete(list.id);
    expect(await failureOf(goway.lists.get(list.id))).toBeInstanceOf(GoWayNotFoundError);
  });

  test('refuse a taken name with its reason, and a withdrawn place as gone', async () => {
    const goway = signedIn();
    const list = await goway.lists.create({ name: 'Brunch' });
    const clash = await failureOf(goway.lists.create({ name: 'BRUNCH' }));
    expect(clash).toBeInstanceOf(GoWayConflictError);
    expect((clash as GoWayConflictError).details?.[SAVED_LIST_CONFLICT_DETAIL]).toBe('name_taken');

    const withdrawn = defined([...FIXTURE_WITHDRAWN_PLACE_IDS][0]);
    expect(await failureOf(goway.lists.items.add(list.id, { placeId: withdrawn }))).toBeInstanceOf(
      GoWayGoneError,
    );
    expect(
      await failureOf(goway.lists.items.add(list.id, { placeId: 'gw_place_unknown' })),
    ).toBeInstanceOf(GoWayNotFoundError);
  });

  test('stop at the most lists a person may hold', async () => {
    const goway = signedIn();
    for (let index = 0; index < MAX_SAVED_LISTS_PER_USER; index += 1) {
      await goway.lists.create({ name: `List ${String(index)}` });
    }
    const over = await failureOf(goway.lists.create({ name: 'one too many' }));
    expect((over as GoWayConflictError).details?.[SAVED_LIST_CONFLICT_DETAIL]).toBe(
      'list_limit_reached',
    );
    // Each fixture request waits like a network one (90-280 ms), a hundred of them.
  }, 90_000);

  test('page lists with a cursor the SDK can walk', async () => {
    const goway = signedIn();
    for (let index = 0; index < 5; index += 1)
      await goway.lists.create({ name: `L${String(index)}` });
    const seen: string[] = [];
    for await (const list of iterateGoWayPages((cursor) =>
      goway.lists.list({ limit: 2, ...(cursor ? { cursor } : {}) }),
    )) {
      seen.push(list.name);
    }
    expect(seen).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
  });

  test('create the default list once, adopting a list named the same', async () => {
    const goway = signedIn();
    const first = await goway.lists.ensureDefault({ name: 'Saved' });
    const second = await goway.lists.ensureDefault({ name: 'Guardados' });
    expect(second.id).toBe(first.id);
    expect(first.isDefault).toBe(true);
  });

  test('say which lists hold a place', async () => {
    const goway = signedIn();
    const one = await goway.lists.create({ name: 'One' });
    const item = await goway.lists.items.add(one.id, { placeId: defined(C) });
    const held = await goway.lists.saved([defined(A), defined(C)]);
    expect(held.items).toEqual([
      { placeId: defined(C), lists: [{ listId: one.id, itemId: item.id }] },
    ]);
  });
});

describe('the hearts on screen share one request', () => {
  test('questions asked together leave as one, each answered for itself', async () => {
    const asked: string[][] = [];
    const ask = createHoldBatcher(async (ids): Promise<SavedPlaces> => {
      asked.push([...ids]);
      return { items: [{ placeId: 'p2', lists: [{ listId: 'l', itemId: 'i' }] }] };
    }, 1);
    const [p1, p2, p2again] = await Promise.all([ask('p1'), ask('p2'), ask('p2')]);
    expect(asked).toEqual([['p1', 'p2']]);
    expect(p1).toBeNull();
    expect(p2?.placeId).toBe('p2');
    expect(p2again).toBe(p2);
  });

  test('no more than fifty places go in one request', async () => {
    const sizes: number[] = [];
    const ask = createHoldBatcher(async (ids): Promise<SavedPlaces> => {
      sizes.push(ids.length);
      return { items: [] };
    }, 1);
    await Promise.all(Array.from({ length: 120 }, (_, index) => ask(`p${String(index)}`)));
    expect(sizes).toEqual([50, 50, 20]);
  });

  test('a failed request fails every question it carried, and the next window starts clean', async () => {
    let calls = 0;
    const ask = createHoldBatcher(async (): Promise<SavedPlaces> => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return { items: [] };
    }, 1);
    const failed = await Promise.allSettled([ask('p1'), ask('p2')]);
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(await ask('p1')).toBeNull();
  });
});

describe('what a failure says', () => {
  const say = (key: string, values?: Record<string, string | number>) =>
    formatMessage(SAVED_EN[key] ?? key, values);

  test('a conflict is told by its reason', async () => {
    const goway = signedIn();
    await goway.lists.create({ name: 'Taken' });
    const error = await failureOf(goway.lists.create({ name: 'taken' }));
    expect(savedFailureMessage(error, say)).toBe(SAVED_EN['saved.error.nameTaken']);
  });

  test('a withdrawn place and an unknown failure have their own sentences', async () => {
    const goway = signedIn();
    const list = await goway.lists.create({ name: 'Gone' });
    const gone = await failureOf(
      goway.lists.items.add(list.id, { placeId: defined([...FIXTURE_WITHDRAWN_PLACE_IDS][0]) }),
    );
    expect(savedFailureMessage(gone, say)).toBe(SAVED_EN['saved.error.gone']);
    expect(savedFailureMessage(new Error('boom'), say)).toBe(SAVED_EN['saved.error.generic']);
  });
});
