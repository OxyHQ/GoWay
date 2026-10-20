import { describe, expect, it } from 'vitest';
import {
  GoWayConflictError,
  GoWayNotFoundError,
  GoWayResponseError,
  GoWayValidationError,
  SAVED_LIST_CONFLICT_DETAIL,
  createGoWayClient,
  iterateGoWayPages,
  type SavedList,
  type SavedListItem,
} from '../src/index';
import { errorBody, page } from './fixtures';
import { defined, fakeFetch, queryOf, rejection } from './helpers';

/** Saved lists as the SDK carries them: the calls, the inputs it checks before sending, and the responses it parses. */

function clientFor(body: unknown, status = 200) {
  const { fetch, calls } = fakeFetch(status, body);
  return { client: createGoWayClient({ fetch, getAccessToken: () => 'token' }), calls };
}

const LIST: SavedList = {
  id: 'l1',
  name: 'Want to go',
  visibility: 'private',
  isDefault: false,
  itemCount: 2,
  coverPlaceIds: ['gw_place_01H8', 'gw_place_01H9'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const ITEM: SavedListItem = {
  id: 'i1',
  listId: 'l1',
  placeId: 'gw_place_01H8',
  note: 'Sourdough before noon',
  position: 0,
  addedAt: '2026-10-01T00:00:00.000Z',
};

describe('lists', () => {
  it('lists yours with the page parameters', async () => {
    const { client, calls } = clientFor(page([LIST], 'abc'));
    const listed = await client.lists.list({ limit: 10 });
    expect(listed.items[0]?.coverPlaceIds).toHaveLength(2);
    expect(listed.nextCursor).toBe('abc');
    expect(calls[0]?.url.split('?')[0]).toBe('https://api.goway.to/api/v1/lists');
    expect(new URLSearchParams(queryOf(defined(calls[0]).url)).get('limit')).toBe('10');
  });

  it('creates a list with POST and the name as given', async () => {
    const { client, calls } = clientFor(LIST, 201);
    const created = await client.lists.create({ name: '  Want to go ' });
    expect(created.visibility).toBe('private');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(defined(defined(calls[0]).init.body))).toEqual({ name: 'Want to go' });
  });

  it('refuses a name that is empty or a field a list does not have, before sending', async () => {
    const { client, calls } = clientFor(LIST, 201);
    expect(await rejection(client.lists.create({ name: '   ' }))).toBeInstanceOf(
      GoWayValidationError,
    );
    expect(
      await rejection(
        client.lists.create({ name: 'x', visibility: 'public' } as unknown as { name: string }),
      ),
    ).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });

  it('ensures the default list with PUT', async () => {
    const { client, calls } = clientFor({ ...LIST, isDefault: true }, 201);
    const list = await client.lists.ensureDefault({ name: 'Saved' });
    expect(list.isDefault).toBe(true);
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/lists/default');
  });

  it('renames with PATCH and deletes with DELETE, escaping the id', async () => {
    const renamed = clientFor(LIST);
    await renamed.client.lists.rename('l 1', { name: 'Coffee' });
    expect(renamed.calls[0]?.init.method).toBe('PATCH');
    expect(renamed.calls[0]?.url).toBe('https://api.goway.to/api/v1/lists/l%201');

    const deleted = clientFor(null, 204);
    await expect(deleted.client.lists.delete('l1')).resolves.toBeUndefined();
    expect(deleted.calls[0]?.init.method).toBe('DELETE');
  });

  it('surfaces a conflict with its reason', async () => {
    const { client } = clientFor(
      errorBody('conflict', 'taken', { [SAVED_LIST_CONFLICT_DETAIL]: 'name_taken' }),
      409,
    );
    const error = await rejection(client.lists.create({ name: 'x' }));
    expect(error).toBeInstanceOf(GoWayConflictError);
    expect((error as GoWayConflictError).details).toEqual({ reason: 'name_taken' });
  });

  it('maps a list that is not yours to not found', async () => {
    const { client } = clientFor(errorBody('not_found', 'no such list'), 404);
    expect(await rejection(client.lists.get('l1'))).toBeInstanceOf(GoWayNotFoundError);
  });

  it('refuses a response that is not a list', async () => {
    const { client } = clientFor({ ...LIST, visibility: 'public' });
    expect(await rejection(client.lists.get('l1'))).toBeInstanceOf(GoWayResponseError);
  });
});

describe('list items', () => {
  it('pages the items and walks every page with iterateGoWayPages', async () => {
    const pages = [page([ITEM], 'next'), page([{ ...ITEM, id: 'i2', position: 1 }], null)];
    let served = 0;
    const cursors: (string | null)[] = [];
    const client = createGoWayClient({
      getAccessToken: () => 'token',
      fetch: async (url) => {
        cursors.push(new URLSearchParams(queryOf(url)).get('cursor'));
        const body = defined(pages[served]);
        served += 1;
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(body),
        };
      },
    });
    const ids: string[] = [];
    for await (const item of iterateGoWayPages((cursor) =>
      client.lists.items.list('l1', cursor === undefined ? {} : { cursor }),
    )) {
      ids.push(item.id);
    }
    expect(ids).toEqual(['i1', 'i2']);
    expect(cursors).toEqual([null, 'next']);
  });

  it('adds a place with a trimmed note', async () => {
    const { client, calls } = clientFor(ITEM, 201);
    const item = await client.lists.items.add('l1', { placeId: 'gw_place_01H8', note: ' hi ' });
    expect(item.position).toBe(0);
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/lists/l1/items');
    expect(JSON.parse(defined(defined(calls[0]).init.body))).toEqual({
      placeId: 'gw_place_01H8',
      note: 'hi',
    });
  });

  it('sets a note, clears it with null, and refuses a body that names nothing', async () => {
    const { client, calls } = clientFor(ITEM);
    await client.lists.items.setNote('l1', 'i1', { note: null });
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/lists/l1/items/i1');
    expect(JSON.parse(defined(defined(calls[0]).init.body))).toEqual({ note: null });
    expect(
      await rejection(client.lists.items.setNote('l1', 'i1', {} as unknown as { note: null })),
    ).toBeInstanceOf(GoWayValidationError);
  });

  it('orders with PUT, and refuses an item named twice before sending', async () => {
    const { client, calls } = clientFor(null, 204);
    await client.lists.items.order('l1', { itemIds: ['i2', 'i1'] });
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/lists/l1/items/order');
    expect(
      await rejection(client.lists.items.order('l1', { itemIds: ['i1', 'i1'] })),
    ).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(1);
  });

  it('removes with DELETE', async () => {
    const { client, calls } = clientFor(null, 204);
    await expect(client.lists.items.remove('l1', 'i1')).resolves.toBeUndefined();
    expect(calls[0]?.init.method).toBe('DELETE');
  });
});

describe('which lists hold a place', () => {
  it('sends the ids as one comma-joined parameter and parses the holds', async () => {
    const { client, calls } = clientFor({
      items: [{ placeId: 'p1', lists: [{ listId: 'l1', itemId: 'i1' }] }],
    });
    const saved = await client.lists.saved(['p1', 'p2']);
    expect(saved.items[0]?.lists[0]?.listId).toBe('l1');
    expect(new URLSearchParams(queryOf(defined(calls[0]).url)).get('placeIds')).toBe('p1,p2');
  });

  it('refuses no ids and more than fifty, before sending', async () => {
    const { client, calls } = clientFor({ items: [] });
    expect(await rejection(client.lists.saved([]))).toBeInstanceOf(GoWayValidationError);
    const many = Array.from({ length: 51 }, (_, index) => `p${String(index)}`);
    expect(await rejection(client.lists.saved(many))).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });
});
