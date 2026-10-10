import { describe, expect, it } from 'vitest';
import {
  GoWayValidationError,
  MAX_PLACE_BATCH_SIZE,
  createGoWayClient,
  placeMatchesCapabilityFilter,
  type PlaceCapability,
} from '../src/index';
import { CLAIM, PLACE, page } from './fixtures';
import { fakeFetch, queryOf, rejection } from './helpers';

/**
 * What an integrating product (Mercaria, FairCoin, Moovo…) leans on: reading
 * the places it stores ids of in one request, its claim on one place, a text
 * capability filter, and an update that clears a field on purpose.
 */

function clientFor(body: unknown, status = 200) {
  const { fetch, calls } = fakeFetch(status, body);
  return {
    client: createGoWayClient({ fetch, getAccessToken: () => 'token', locale: 'ES' }),
    calls,
  };
}

const BATCH = {
  items: [PLACE],
  gone: [{ id: 'gw_merged', mergedInto: 'gw_place_01H8' }, { id: 'gw_removed' }],
  missing: ['gw_never'],
};

describe('places.getMany', () => {
  it('reads several places in one request, repeats collapsed, in the client locale', async () => {
    const { client, calls } = clientFor(BATCH);
    const batch = await client.places.getMany([
      'gw_place_01H8',
      'gw_merged',
      'gw_place_01H8',
      'gw_removed',
      'gw_never',
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.url.split('?')[0]).toBe('https://api.goway.to/api/v1/places');
    // Sorted on the wire, so the same question is the same URL to a cache.
    expect(decodeURIComponent(queryOf(calls[0]?.url ?? ''))).toBe(
      'ids=gw_merged,gw_never,gw_place_01H8,gw_removed&locale=es',
    );

    expect(batch.items.map((place) => place.id)).toEqual(['gw_place_01H8']);
    expect(batch.gone).toEqual([
      { id: 'gw_merged', mergedInto: 'gw_place_01H8' },
      { id: 'gw_removed' },
    ]);
    expect(batch.missing).toEqual(['gw_never']);
  });

  it("answers in the caller's order, whatever order the lists arrive in", async () => {
    const { client } = clientFor({
      items: [
        { ...PLACE, id: 'gw_b' },
        { ...PLACE, id: 'gw_a' },
      ],
      gone: [{ id: 'gw_d' }, { id: 'gw_c' }],
      missing: ['gw_f', 'gw_e'],
    });
    const batch = await client.places.getMany(['gw_e', 'gw_c', 'gw_a', 'gw_f', 'gw_d', 'gw_b']);
    expect(batch.items.map((place) => place.id)).toEqual(['gw_a', 'gw_b']);
    expect(batch.gone.map((gone) => gone.id)).toEqual(['gw_c', 'gw_d']);
    expect(batch.missing).toEqual(['gw_e', 'gw_f']);
  });

  it(`refuses an empty list and more than ${String(MAX_PLACE_BATCH_SIZE)} ids before sending`, async () => {
    const { client, calls } = clientFor(BATCH);
    const tooMany = Array.from(
      { length: MAX_PLACE_BATCH_SIZE + 1 },
      (_unused, index) => `gw_${String(index)}`,
    );
    for (const ids of [[], tooMany]) {
      const error = await rejection(client.places.getMany(ids));
      expect(error).toBeInstanceOf(GoWayValidationError);
      expect(error.message).toContain('query.ids');
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a batch answer that is not one', async () => {
    const { client } = clientFor({ items: [PLACE] });
    const error = await rejection(client.places.getMany(['gw_place_01H8']));
    expect(error.message).toContain('response.gone');
  });
});

describe('claims.list with placeId', () => {
  it("sends the place, so a dashboard reads the account's claim on it alone", async () => {
    const { client, calls } = clientFor(page([CLAIM]));
    const claims = await client.claims.list({ oxyAccountId: 'org_1', placeId: 'gw_place_01H8' });
    expect(claims.items).toHaveLength(1);
    expect(queryOf(calls[0]?.url ?? '')).toContain('placeId=gw_place_01H8');
  });
});

describe('a text capability filter', () => {
  it('is sent as key:value and refused when the key refuses the value', async () => {
    const { client, calls } = clientFor(page([]));
    await client.places.nearby({
      latitude: 41.39,
      longitude: 2.17,
      radiusMeters: 500,
      capabilities: ['commerce.mercaria.store:loc_7f3a'],
    });
    expect(calls[0]?.url).toContain('capabilities=commerce.mercaria.store%3Aloc_7f3a');

    for (const filter of [
      'brand.wikidata:acme',
      'commerce.mercaria.store:',
      'commerce.mercaria.store:a,b',
    ]) {
      const error = await rejection(
        client.places.nearby({
          latitude: 41.39,
          longitude: 2.17,
          radiusMeters: 500,
          capabilities: [filter],
        }),
      );
      expect(error).toBeInstanceOf(GoWayValidationError);
    }
  });

  it('matches exactly against the strongest assertion, client-side too', () => {
    const link = (
      value: string,
      verification: PlaceCapability['verification'],
    ): PlaceCapability => ({
      namespace: 'commerce.mercaria',
      capability: 'store',
      key: 'commerce.mercaria.store',
      value,
      verification,
      observedAt: '2026-10-01T00:00:00.000Z',
    });
    const place = {
      capabilities: [link('loc_b', 'community_reported'), link('loc_a', 'business_asserted')],
    };
    expect(placeMatchesCapabilityFilter(place, 'commerce.mercaria.store:loc_a')).toBe(true);
    expect(placeMatchesCapabilityFilter(place, 'commerce.mercaria.store:loc_b')).toBe(false);
    expect(placeMatchesCapabilityFilter(place, 'commerce.mercaria.store:loc')).toBe(false);
  });
});

describe('places.update as a merge patch', () => {
  it('sends null for a cleared part and leaves out the parts it does not name', async () => {
    const { client, calls } = clientFor(PLACE);
    await client.places.update('gw_place_01H8', {
      contact: { phone: null, website: 'https://example.org' },
      address: { houseNumber: null, countryCode: 'es' },
      openingHours: null,
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contact: { phone: null, website: 'https://example.org' },
      address: { houseNumber: null, countryCode: 'ES' },
      openingHours: null,
    });
  });

  it('refuses null where a place cannot be without the field', async () => {
    const { client, calls } = clientFor(PLACE);
    // @ts-expect-error — `name` is not nullable, and the type says so too.
    const error = await rejection(client.places.update('gw_place_01H8', { name: null }));
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });
});
