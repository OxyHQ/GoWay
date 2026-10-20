/**
 * Saved place lists, end to end: the real router over a real PostGIS.
 *
 *  - every route is the caller's own: another person's list, item and saves are
 *    `404` to read, rename, add to, reorder, annotate, remove and delete, and
 *    never appear in a lookup;
 *  - lists and items page with fingerprinted keyset cursors that survive
 *    changes between pages, and a cursor from another list is `bad_request`;
 *  - the default list is created once, even when several devices ask at once;
 *  - a place is in a list once, must exist and be published, and the limits are
 *    `conflict` with their reason;
 *  - reorder is transactional and renumbers; deleting a list takes its items;
 *  - saving writes no place revision, and a merge carries saves to the survivor.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  MAX_SAVED_LIST_ITEMS,
  MAX_SAVED_LISTS_PER_USER,
  type Place,
  type SavedList,
  type SavedListItem,
  type SavedListItemPage,
  type SavedListPage,
  type SavedPlaces,
} from '@goway/contracts';
import {
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  SUITE_SETUP_TIMEOUT_MS,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { createPlace, type PlaceActor } from '../../db/places/placesRepository';
import { deleteSavedDataOf, moveSavedItemsToSurvivor } from '../../db/places/savedPlacesRepository';
import { defined } from '../../__tests__/defined';
import {
  fakeRequireAuth,
  serve,
  session,
  type ErrorBody,
  type TestApi,
} from '../../__tests__/httpHarness';
import { apiAuthor } from '../../__tests__/placesFixtures';
import { createSavedListsRouter } from '../savedLists';

const CONTRIBUTOR: PlaceActor = {
  author: apiAuthor('person-contributor'),
  assertedVerification: 'community_reported',
};
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const ANA = session('person-ana');
const BEN = session('person-ben');

let suite: SuiteDatabase | null = null;
let api: TestApi;
let places: Place[] = [];

async function makePlaces(count: number): Promise<Place[]> {
  const made: Place[] = [];
  for (let index = 0; index < count; index += 1) {
    made.push(
      await createPlace(
        requireSuite(suite).db,
        { name: `Saved test place ${String(index)}`, location: GRACIA },
        CONTRIBUTOR,
      ),
    );
  }
  return made;
}

function place(index: number): Place {
  return defined(places[index], `place ${String(index)}`);
}

async function createList(who: Record<string, string>, name: string): Promise<SavedList> {
  const { status, body } = await api.call<SavedList>('POST', '/lists', who, { name });
  expect(status).toBe(201);
  return body;
}

async function save(
  who: Record<string, string>,
  listId: string,
  placeId: string,
  note?: string,
): Promise<SavedListItem> {
  const { status, body } = await api.call<SavedListItem>(
    'POST',
    `/lists/${listId}/items`,
    who,
    note === undefined ? { placeId } : { placeId, note },
  );
  expect(status).toBe(201);
  return body;
}

async function itemsOf(who: Record<string, string>, listId: string): Promise<SavedListItem[]> {
  const { status, body } = await api.call<SavedListItemPage>(
    'GET',
    `/lists/${listId}/items?limit=100`,
    who,
  );
  expect(status).toBe(200);
  return body.items;
}

async function count(table: string, where = 'true'): Promise<number> {
  const rows = await requireSuite(suite).client.unsafe<{ n: string }[]>(
    `select count(*)::text as n from ${table} where ${where}`,
  );
  return Number(defined(rows[0]).n);
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(createSavedListsRouter({ requireAuth: fakeRequireAuth }));
  places = await makePlaces(8);
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('who may use saved lists', () => {
  it('requires a session on every route', async () => {
    for (const [method, path, body] of [
      ['GET', '/lists'],
      ['POST', '/lists', { name: 'x' }],
      ['PUT', '/lists/default', { name: 'Saved' }],
      ['GET', '/lists/l1'],
      ['PATCH', '/lists/l1', { name: 'x' }],
      ['DELETE', '/lists/l1'],
      ['GET', '/lists/l1/items'],
      ['POST', '/lists/l1/items', { placeId: 'p' }],
      ['PUT', '/lists/l1/items/order', { itemIds: ['i'] }],
      ['PATCH', '/lists/l1/items/i1', { note: null }],
      ['DELETE', '/lists/l1/items/i1'],
      ['GET', '/saved-places?placeIds=p'],
    ] as const) {
      const { status } = await api.call<ErrorBody>(method, path, {}, body);
      expect([method, path, status]).toEqual([method, path, 401]);
    }
  });

  it('refuses a session switched into an organization: a list is personal', async () => {
    const { status, body } = await api.call<ErrorBody>(
      'POST',
      '/lists',
      session('org-cafe', 'person-ana'),
      { name: 'Team picks' },
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
    expect((await api.call('GET', '/lists', session('org-cafe', 'person-ana'))).status).toBe(403);
  });
});

describe('ownership', () => {
  it("never reads or touches another person's list, item or saves", async () => {
    const list = await createList(ANA, 'Ana private');
    const item = await save(ANA, list.id, place(0).id, 'secret note');
    const bensOwn = await createList(BEN, 'Ben own');

    // Every read and every write answers not_found, never forbidden, and says nothing about the list.
    const attempts: [string, string, unknown?][] = [
      ['GET', `/lists/${list.id}`],
      ['PATCH', `/lists/${list.id}`, { name: 'Stolen' }],
      ['GET', `/lists/${list.id}/items`],
      ['POST', `/lists/${list.id}/items`, { placeId: place(1).id }],
      ['PUT', `/lists/${list.id}/items/order`, { itemIds: [item.id] }],
      ['PATCH', `/lists/${list.id}/items/${item.id}`, { note: 'mine now' }],
      ['DELETE', `/lists/${list.id}/items/${item.id}`],
      ['DELETE', `/lists/${list.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const { status, body: answer } = await api.call<ErrorBody>(method, path, BEN, body);
      expect([method, path, status, answer.error.code]).toEqual([method, path, 404, 'not_found']);
    }

    // A real removed place gives Ben the same answer on Ana's list as a missing one.
    const missingPlace = await api.call<ErrorBody>('POST', `/lists/${list.id}/items`, BEN, {
      placeId: 'gw_place_nope',
    });
    expect(missingPlace.status).toBe(404);

    // Ben's own list cannot be addressed through Ana's item either.
    const crossed = await api.call<ErrorBody>(
      'DELETE',
      `/lists/${bensOwn.id}/items/${item.id}`,
      BEN,
    );
    expect(crossed.status).toBe(404);

    // Nothing of Ana's changed.
    expect((await api.call<SavedList>('GET', `/lists/${list.id}`, ANA)).body).toMatchObject({
      name: 'Ana private',
      itemCount: 1,
    });
    expect(await itemsOf(ANA, list.id)).toEqual([expect.objectContaining({ note: 'secret note' })]);

    // Ben's lists and lookups hold none of it.
    const bensLists = (await api.call<SavedListPage>('GET', '/lists', BEN)).body.items;
    expect(bensLists.map((l) => l.id)).toEqual([bensOwn.id]);
    const lookup = await api.call<SavedPlaces>('GET', `/saved-places?placeIds=${place(0).id}`, BEN);
    expect(lookup.body).toEqual({ items: [] });
  });
});

describe('lists', () => {
  it('creates, reads, renames and deletes a list, taking its items with it', async () => {
    const list = await createList(ANA, 'Want to go');
    expect(list).toMatchObject({
      name: 'Want to go',
      visibility: 'private',
      isDefault: false,
      itemCount: 0,
      coverPlaceIds: [],
    });
    await save(ANA, list.id, place(0).id);
    await save(ANA, list.id, place(1).id);
    const read = (await api.call<SavedList>('GET', `/lists/${list.id}`, ANA)).body;
    expect(read.itemCount).toBe(2);
    expect(read.coverPlaceIds).toEqual([place(0).id, place(1).id]);

    const renamed = await api.call<SavedList>('PATCH', `/lists/${list.id}`, ANA, {
      name: '  Coffee, ranked ',
    });
    expect(renamed.body.name).toBe('Coffee, ranked');

    const before = await count('saved_place_list_items', `list_id = '${list.id}'`);
    expect(before).toBe(2);
    expect((await api.call('DELETE', `/lists/${list.id}`, ANA)).status).toBe(204);
    expect(await count('saved_place_list_items', `list_id = '${list.id}'`)).toBe(0);
    expect((await api.call('GET', `/lists/${list.id}`, ANA)).status).toBe(404);
    expect((await api.call('DELETE', `/lists/${list.id}`, ANA)).status).toBe(404);
  });

  it('covers at most four places', async () => {
    const list = await createList(ANA, 'Cover test');
    for (let index = 0; index < 6; index += 1) await save(ANA, list.id, place(index).id);
    const read = (await api.call<SavedList>('GET', `/lists/${list.id}`, ANA)).body;
    expect(read.itemCount).toBe(6);
    expect(read.coverPlaceIds).toEqual([0, 1, 2, 3].map((index) => place(index).id));
  });

  it('refuses a name another of your lists has, in any case, but not another person its name', async () => {
    const list = await createList(ANA, 'Brunch');
    const clash = await api.call<ErrorBody>('POST', '/lists', ANA, { name: ' brunch ' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details).toMatchObject({ reason: 'name_taken' });
    const other = await createList(ANA, 'Dinner');
    const rename = await api.call<ErrorBody>('PATCH', `/lists/${other.id}`, ANA, {
      name: 'BRUNCH',
    });
    expect(rename.status).toBe(409);
    // Renaming a list to its own name in another case is allowed.
    expect(
      (await api.call<SavedList>('PATCH', `/lists/${list.id}`, ANA, { name: 'BRUNCH' })).status,
    ).toBe(200);
    expect((await api.call('POST', '/lists', BEN, { name: 'Brunch' })).status).toBe(201);
  });

  it('refuses a body with an unknown field or an empty name', async () => {
    expect(
      (await api.call('POST', '/lists', ANA, { name: 'x', visibility: 'public' })).status,
    ).toBe(422);
    expect((await api.call('POST', '/lists', ANA, { name: '   ' })).status).toBe(422);
    expect((await api.call('POST', '/lists', ANA, { name: 'x'.repeat(81) })).status).toBe(422);
  });

  it('stops at the most lists a person may hold', async () => {
    const carl = session('person-carl');
    const held = await count('saved_place_lists', `owner_oxy_user_id = 'person-carl'`);
    for (let index = held; index < MAX_SAVED_LISTS_PER_USER; index += 1) {
      await requireSuite(suite).client.unsafe(
        `insert into saved_place_lists (id, owner_oxy_user_id, name) values (gen_random_uuid()::text, 'person-carl', 'filler ${String(index)}')`,
      );
    }
    const over = await api.call<ErrorBody>('POST', '/lists', carl, { name: 'one too many' });
    expect(over.status).toBe(409);
    expect(over.body.error.details).toMatchObject({
      reason: 'list_limit_reached',
      max: MAX_SAVED_LISTS_PER_USER,
    });
    // The default list is a list too.
    expect((await api.call('PUT', '/lists/default', carl, { name: 'Saved' })).status).toBe(409);
  });
});

describe('the default list', () => {
  it('is created once, then returned', async () => {
    const dana = session('person-dana');
    const first = await api.call<SavedList>('PUT', '/lists/default', dana, { name: 'Saved' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: 'Saved', isDefault: true });
    const again = await api.call<SavedList>('PUT', '/lists/default', dana, { name: 'Guardados' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.name).toBe('Saved');
  });

  it('is one list even when several devices ask at once', async () => {
    const erin = session('person-erin');
    const answers = await Promise.all(
      Array.from({ length: 6 }, () =>
        api.call<SavedList>('PUT', '/lists/default', erin, { name: 'Saved' }),
      ),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(answers.map((a) => a.body.id)).size).toBe(1);
    expect(await count('saved_place_lists', `owner_oxy_user_id = 'person-erin'`)).toBe(1);
  });

  it('adopts a list the person already named the same, and is recreated after deletion', async () => {
    const fay = session('person-fay');
    const byHand = await createList(fay, 'Saved');
    const ensured = await api.call<SavedList>('PUT', '/lists/default', fay, { name: 'saved' });
    expect(ensured.status).toBe(200);
    expect(ensured.body).toMatchObject({ id: byHand.id, isDefault: true });

    await api.call('DELETE', `/lists/${byHand.id}`, fay);
    const fresh = await api.call<SavedList>('PUT', '/lists/default', fay, { name: 'Saved' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(byHand.id);
  });
});

describe('saving a place', () => {
  it('adds at the end, once: saving it again answers the existing item', async () => {
    const list = await createList(ANA, 'Dedupe');
    const first = await save(ANA, list.id, place(0).id, 'first note');
    const second = await save(ANA, list.id, place(1).id);
    expect(second.position).toBeGreaterThan(first.position);

    const again = await api.call<SavedListItem>('POST', `/lists/${list.id}/items`, ANA, {
      placeId: place(0).id,
      note: 'ignored',
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first);
    expect((await itemsOf(ANA, list.id)).map((i) => i.placeId)).toEqual([place(0).id, place(1).id]);
  });

  it('needs a real, published place', async () => {
    const list = await createList(ANA, 'Real places');
    const missing = await api.call<ErrorBody>('POST', `/lists/${list.id}/items`, ANA, {
      placeId: 'gw_place_does_not_exist',
    });
    expect(missing.status).toBe(404);

    const [withdrawn] = await makePlaces(1);
    await requireSuite(suite).client.unsafe(
      `update places set status = 'removed' where id = '${defined(withdrawn).id}'`,
    );
    const gone = await api.call<ErrorBody>('POST', `/lists/${list.id}/items`, ANA, {
      placeId: defined(withdrawn).id,
    });
    expect(gone.status).toBe(410);
    expect(await itemsOf(ANA, list.id)).toEqual([]);
  });

  it('stops at the most places a list may hold', async () => {
    const gus = session('person-gus');
    const list = await createList(gus, 'Full');
    // Fill to the limit directly: filler places, then one item per place.
    await requireSuite(suite).client.unsafe(
      `insert into places (id, name, latitude, longitude)
       select 'gw_place_fill_' || g, 'Filler ' || g, 41.4, 2.16 from generate_series(1, ${String(MAX_SAVED_LIST_ITEMS)}) g`,
    );
    await requireSuite(suite).client.unsafe(
      `insert into saved_place_list_items (id, list_id, place_id, position)
       select gen_random_uuid()::text, '${list.id}', id, row_number() over (order by id) - 1
       from places where id like 'gw_place_fill_%'`,
    );
    expect(await count('saved_place_list_items', `list_id = '${list.id}'`)).toBe(
      MAX_SAVED_LIST_ITEMS,
    );

    const [extra] = await makePlaces(1);
    const over = await api.call<ErrorBody>('POST', `/lists/${list.id}/items`, gus, {
      placeId: defined(extra).id,
    });
    expect(over.status).toBe(409);
    expect(over.body.error.details).toMatchObject({
      reason: 'item_limit_reached',
      max: MAX_SAVED_LIST_ITEMS,
    });
  });

  it('records no place revision and touches nothing public', async () => {
    const before = await count('place_revisions');
    const list = await createList(ANA, 'No history');
    const item = await save(ANA, list.id, place(2).id, 'private words');
    await api.call('PATCH', `/lists/${list.id}/items/${item.id}`, ANA, { note: null });
    await api.call('DELETE', `/lists/${list.id}/items/${item.id}`, ANA);
    expect(await count('place_revisions')).toBe(before);
  });
});

describe('notes and order', () => {
  it('sets, rewrites and clears a note', async () => {
    const list = await createList(ANA, 'Notes');
    const item = await save(ANA, list.id, place(0).id);
    expect(item.note).toBeUndefined();
    const path = `/lists/${list.id}/items/${item.id}`;
    expect(
      (await api.call<SavedListItem>('PATCH', path, ANA, { note: '  Sourdough  ' })).body.note,
    ).toBe('Sourdough');
    const cleared = await api.call<SavedListItem>('PATCH', path, ANA, { note: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.note).toBeUndefined();
    expect((await api.call('PATCH', path, ANA, {})).status).toBe(400);
    expect((await api.call('PATCH', path, ANA, { note: 'x'.repeat(501) })).status).toBe(422);
  });

  it('puts the named items first, keeps the rest in order, and renumbers', async () => {
    const list = await createList(ANA, 'Order');
    const items: SavedListItem[] = [];
    for (let index = 0; index < 5; index += 1)
      items.push(await save(ANA, list.id, place(index).id));
    const [a, b, c, d, e] = items.map((item) => item.id);

    // Removing leaves a gap; reorder closes it.
    await api.call('DELETE', `/lists/${list.id}/items/${defined(b)}`, ANA);
    const order = await api.call('PUT', `/lists/${list.id}/items/order`, ANA, {
      itemIds: [defined(e), defined(c)],
    });
    expect(order.status).toBe(204);
    const after = await itemsOf(ANA, list.id);
    expect(after.map((item) => item.id)).toEqual([e, c, a, d]);
    expect(after.map((item) => item.position)).toEqual([0, 1, 2, 3]);
  });

  it('refuses an order naming an item that is not in the list, or one twice, and changes nothing', async () => {
    const list = await createList(ANA, 'Order refused');
    const first = await save(ANA, list.id, place(0).id);
    const second = await save(ANA, list.id, place(1).id);
    const other = await createList(ANA, 'Other list');
    const foreign = await save(ANA, other.id, place(0).id);

    const unknown = await api.call<ErrorBody>('PUT', `/lists/${list.id}/items/order`, ANA, {
      itemIds: [second.id, foreign.id],
    });
    expect(unknown.status).toBe(422);
    const twice = await api.call('PUT', `/lists/${list.id}/items/order`, ANA, {
      itemIds: [second.id, second.id],
    });
    expect(twice.status).toBe(422);
    expect((await itemsOf(ANA, list.id)).map((item) => item.id)).toEqual([first.id, second.id]);
  });
});

describe('pagination', () => {
  it('pages lists oldest first with a cursor, and loses none when one is added between pages', async () => {
    const hal = session('person-hal');
    const made: SavedList[] = [];
    for (let index = 0; index < 5; index += 1)
      made.push(await createList(hal, `List ${String(index)}`));

    const first = await api.call<SavedListPage>('GET', '/lists?limit=2', hal);
    expect(first.body.items.map((l) => l.id)).toEqual([made[0], made[1]].map((l) => defined(l).id));
    const cursor = defined(first.body.nextCursor);

    const late = await createList(hal, 'Added between pages');
    const second = await api.call<SavedListPage>('GET', `/lists?limit=2&cursor=${cursor}`, hal);
    expect(second.body.items.map((l) => l.id)).toEqual(
      [made[2], made[3]].map((l) => defined(l).id),
    );
    const third = await api.call<SavedListPage>(
      'GET',
      `/lists?limit=10&cursor=${defined(second.body.nextCursor)}`,
      hal,
    );
    expect(third.body.items.map((l) => l.id)).toEqual([defined(made[4]).id, late.id]);
    expect(third.body.nextCursor).toBeNull();
  });

  it('pages items in order, and refuses a cursor from another list or another endpoint', async () => {
    const list = await createList(ANA, 'Paged items');
    const other = await createList(ANA, 'Other paged items');
    for (let index = 0; index < 5; index += 1) await save(ANA, list.id, place(index).id);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const page: { status: number; body: SavedListItemPage } = await api.call<SavedListItemPage>(
        'GET',
        `/lists/${list.id}/items${query}`,
        ANA,
      );
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((item) => item.placeId));
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([0, 1, 2, 3, 4].map((index) => place(index).id));

    const firstPage = await api.call<SavedListItemPage>(
      'GET',
      `/lists/${list.id}/items?limit=2`,
      ANA,
    );
    const issued = defined(firstPage.body.nextCursor);
    const replayed = await api.call<ErrorBody>(
      'GET',
      `/lists/${other.id}/items?cursor=${issued}`,
      ANA,
    );
    expect(replayed.status).toBe(400);
    expect(replayed.body.error.code).toBe('bad_request');
    expect((await api.call('GET', `/lists?cursor=${issued}`, ANA)).status).toBe(400);
  });

  it('refuses a limit outside the range', async () => {
    expect((await api.call('GET', '/lists?limit=0', ANA)).status).toBe(422);
    expect((await api.call('GET', '/lists?limit=101', ANA)).status).toBe(422);
  });
});

describe('which lists hold a place', () => {
  it('answers the places asked about that you saved, in the order asked, with their lists', async () => {
    const ivy = session('person-ivy');
    const one = await createList(ivy, 'One');
    const two = await createList(ivy, 'Two');
    const inOne = await save(ivy, one.id, place(3).id);
    const inTwo = await save(ivy, two.id, place(3).id);
    await save(ivy, two.id, place(4).id);

    const { status, body } = await api.call<SavedPlaces>(
      'GET',
      `/saved-places?placeIds=${place(5).id},${place(4).id},${place(3).id}`,
      ivy,
    );
    expect(status).toBe(200);
    expect(body.items.map((entry) => entry.placeId)).toEqual([place(4).id, place(3).id]);
    expect(body.items[1]?.lists).toEqual([
      { listId: one.id, itemId: inOne.id },
      { listId: two.id, itemId: inTwo.id },
    ]);
  });

  it('needs at least one id and at most fifty', async () => {
    expect((await api.call('GET', '/saved-places', ANA)).status).toBe(422);
    const many = Array.from({ length: 51 }, (_, index) => `p${String(index)}`).join(',');
    expect((await api.call('GET', `/saved-places?placeIds=${many}`, ANA)).status).toBe(422);
  });
});

describe('what happens to saves around the place and the person', () => {
  it('follows a merge to the survivor, dropping the entry in a list that already held it', async () => {
    const [survivor, absorbed] = await makePlaces(2);
    const jo = session('person-jo');
    const both = await createList(jo, 'Both');
    const onlyAbsorbed = await createList(jo, 'Only absorbed');
    await save(jo, both.id, defined(survivor).id);
    await save(jo, both.id, defined(absorbed).id);
    const moving = await save(jo, onlyAbsorbed.id, defined(absorbed).id, 'keep my note');

    const moved = await requireSuite(suite).db.transaction((tx) =>
      moveSavedItemsToSurvivor(tx, defined(survivor).id, defined(absorbed).id),
    );
    expect(moved).toBe(1);
    expect((await itemsOf(jo, both.id)).map((item) => item.placeId)).toEqual([
      defined(survivor).id,
    ]);
    expect(await itemsOf(jo, onlyAbsorbed.id)).toEqual([
      expect.objectContaining({
        id: moving.id,
        placeId: defined(survivor).id,
        note: 'keep my note',
      }),
    ]);
  });

  it('erases everything a person saved and nothing of anybody else', async () => {
    const kim = session('person-kim');
    const mine = await createList(kim, 'Kim one');
    await save(kim, mine.id, place(0).id);
    const theirs = await createList(BEN, 'Ben survives');
    await save(BEN, theirs.id, place(0).id);

    expect(await deleteSavedDataOf(requireSuite(suite).db, 'person-kim')).toBe(1);
    expect(await count('saved_place_lists', `owner_oxy_user_id = 'person-kim'`)).toBe(0);
    expect(await count('saved_place_list_items', `list_id = '${mine.id}'`)).toBe(0);
    expect(await itemsOf(BEN, theirs.id)).toHaveLength(1);
  });
});
