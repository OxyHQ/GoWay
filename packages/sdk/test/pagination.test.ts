import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  GoWayResponseError,
  iterateGoWayPages,
  type GoWayFetch,
} from '../src/index';
import { page, PLACE_WITH_DISTANCE } from './fixtures';
import { queryOf } from './helpers';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** A `fetch` double serving a fixed sequence of pages, recording each URL. */
function pagedFetch(pages: unknown[]): { fetch: GoWayFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: GoWayFetch = async (url) => {
    const body = pages[urls.length];
    urls.push(url);
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { fetch, urls };
}

describe('iterateGoWayPages', () => {
  it('walks every page of a real list with the same filters, then stops on a null cursor', async () => {
    const second = { ...PLACE_WITH_DISTANCE, id: 'gw_place_2' };
    const third = { ...PLACE_WITH_DISTANCE, id: 'gw_place_3' };
    const { fetch, urls } = pagedFetch([
      page([PLACE_WITH_DISTANCE], 'cursor_1'),
      page([second, third], 'cursor_2'),
      page([]),
    ]);
    const goway = createGoWayClient({ fetch });
    const query = {
      latitude: 41.38,
      longitude: 2.16,
      radiusMeters: 500,
      capabilities: ['payments.faircoin.accepted'],
    };

    const places = await collect(
      iterateGoWayPages((cursor) => goway.places.nearby({ ...query, cursor })),
    );

    expect(places.map((place) => place.id)).toEqual(['gw_place_01H8', 'gw_place_2', 'gw_place_3']);
    expect(urls).toHaveLength(3);
    expect(queryOf(urls[0]!)).not.toContain('cursor=');
    expect(queryOf(urls[1]!)).toContain('cursor=cursor_1');
    expect(queryOf(urls[2]!)).toContain('cursor=cursor_2');
    for (const url of urls) expect(url).toContain('capabilities=payments.faircoin.accepted');
  });

  it('throws when the server repeats a cursor, after yielding that page', async () => {
    const pages = [page([1], 'a'), page([2], 'b'), page([3], 'a')];
    const seen: number[] = [];
    let calls = 0;
    const walk = async () => {
      for await (const item of iterateGoWayPages(
        async () => pages[calls++]! as { items: number[]; nextCursor: string },
      )) {
        seen.push(item);
      }
    };
    await expect(walk()).rejects.toBeInstanceOf(GoWayResponseError);
    expect(seen).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });

  it('throws on a cursor that is neither a string nor null', async () => {
    const walk = iterateGoWayPages(async () => ({
      items: [],
      nextCursor: undefined as unknown as null,
    }));
    await expect(collect(walk)).rejects.toBeInstanceOf(GoWayResponseError);
  });

  it('requests nothing further once the consumer stops', async () => {
    let calls = 0;
    const walk = iterateGoWayPages(async (cursor) => {
      calls += 1;
      return { items: [cursor ?? 'first', 'more'], nextCursor: `c${calls}` };
    });
    for await (const item of walk) {
      if (item === 'first') break;
    }
    expect(calls).toBe(1);
  });
});
