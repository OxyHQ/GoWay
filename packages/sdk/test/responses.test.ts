import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  GoWayResponseError,
  placeDisplayName,
  placeHasCapability,
  type GoWayError,
} from '../src/index';
import { CLAIM, page, PLACE, PLACE_WITH_DISTANCE, ROUTE_RESPONSE, SEARCH_RESULTS } from './fixtures';
import { fakeFetch, rejection } from './helpers';

/**
 * Responses are parsed by the CONTRACT's own schemas: these tests hold the SDK
 * to what that means for a consumer — leaked keys stripped, drift reported as
 * `GoWayResponseError` with a path and never a value, open sets left open.
 */

async function getPlace(body: unknown) {
  const { fetch } = fakeFetch(200, body);
  return createGoWayClient({ fetch }).places.get('gw_place_01H8');
}

async function placeError(body: unknown): Promise<GoWayError> {
  return rejection(getPlace(body));
}

function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

describe('place responses', () => {
  it('keep exactly the contract keys and drop whatever else the server sent', async () => {
    const place = await getPlace({
      ...PLACE,
      internalRowId: 42,
      geom: 'SRID=4326;POINT(2.1686 41.3874)',
      moderatorNote: 'do not show',
      verification: { state: 'oxy_verified', reviewerId: 'staff_7' },
    });
    expect(Object.keys(place).sort()).toEqual([
      'address',
      'capabilities',
      'categories',
      'createdAt',
      'id',
      'location',
      'name',
      'sources',
      'status',
      'updatedAt',
      'verification',
    ]);
    expect(JSON.stringify(place)).not.toContain('staff_7');
    // An absent `claims` is NOT an empty claim list: the caller simply may not see them.
    expect(place).not.toHaveProperty('claims');
  });

  for (const field of ['id', 'location', 'status', 'verification', 'sources', 'capabilities', 'updatedAt']) {
    it(`reject a place missing ${field}, naming the path`, async () => {
      const error = await placeError(without(PLACE, field));
      expect(error).toBeInstanceOf(GoWayResponseError);
      expect(error.code).toBe('malformed_response');
      expect(error.status).toBe(200);
      expect(error.message).toContain(`response.${field}`);
    });
  }

  it('name the path and the expectation but never echo the value', async () => {
    const error = await placeError({ ...PLACE, location: { latitude: 181.123456, longitude: 2.1686 } });
    expect(error.message).toContain('response.location.latitude');
    expect(error.message).not.toContain('181.123456');

    const secret = await placeError({ ...PLACE, status: 'leaked-moderation-note' });
    expect(secret.message).toContain('response.status');
    expect(secret.message).not.toContain('leaked-moderation-note');
  });

  it('refuse a status a published place cannot carry', async () => {
    expect(await placeError({ ...PLACE, status: 'removed' })).toBeInstanceOf(GoWayResponseError);
  });

  it('refuse a capability with no provenance, and one whose key disagrees with its parts', async () => {
    const [capability] = PLACE.capabilities as Record<string, unknown>[];
    expect(await placeError({ ...PLACE, capabilities: [without(capability!, 'verification')] })).toBeInstanceOf(
      GoWayResponseError,
    );
    const mismatched = { ...capability, key: 'payments.faircoin.refused' };
    const error = await placeError({ ...PLACE, capabilities: [mismatched] });
    expect(error.message).toContain('response.capabilities[0].key');
  });

  it('carry an unknown source and capability namespace through — both open sets', async () => {
    const place = await getPlace({
      ...PLACE,
      sources: [{ source: 'someone-new', sourceId: 'x/1' }],
      capabilities: [
        {
          namespace: 'thirdparty.loyalty',
          capability: 'stamps',
          key: 'thirdparty.loyalty.stamps',
          value: 10,
          verification: 'business_asserted',
          observedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(place.sources[0]?.source).toBe('someone-new');
    expect(placeHasCapability(place, 'thirdparty.loyalty.stamps')).toBe(true);
  });

  it('fail a whole page when one item is malformed, rather than dropping it', async () => {
    const { fetch } = fakeFetch(200, page([PLACE_WITH_DISTANCE, without(PLACE_WITH_DISTANCE, 'distanceMeters')]));
    const error = await rejection(
      createGoWayClient({ fetch }).places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10 }),
    );
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.message).toContain('response.items[1].distanceMeters');
  });

  it('refuse a page without a nextCursor or with one that is not a cursor', async () => {
    const query = { latitude: 0, longitude: 0, radiusMeters: 10 };
    for (const body of [{ items: [] }, page([], 'not a cursor!'), [PLACE_WITH_DISTANCE]]) {
      const { fetch } = fakeFetch(200, body);
      expect(await rejection(createGoWayClient({ fetch }).places.nearby(query))).toBeInstanceOf(GoWayResponseError);
    }
  });

  it('read a claim with the place it is over and its decision time', async () => {
    const { fetch } = fakeFetch(200, page([{ ...CLAIM, decidedAt: '2026-10-02T00:00:00.000Z', reviewer: 'x' }]));
    const claims = await createGoWayClient({ fetch }).claims.mine();
    expect(claims.items[0]).toEqual({ ...CLAIM, decidedAt: '2026-10-02T00:00:00.000Z' });
    const missingPlace = fakeFetch(200, page([without(CLAIM, 'placeId')]));
    expect(await rejection(createGoWayClient({ fetch: missingPlace.fetch }).claims.mine())).toBeInstanceOf(
      GoWayResponseError,
    );
  });
});

describe('place names', () => {
  const names = [
    { language: 'es', name: 'Museo Picasso', source: 'goway' },
    { language: 'zh-Hant', name: '畢卡索博物館', source: 'openstreetmap' },
  ];

  it('parse the name set and the resolved name', async () => {
    const place = await getPlace({ ...PLACE, names, localizedName: names[0] });
    expect(place.names).toEqual(names);
    expect(placeDisplayName(place)).toBe('Museo Picasso');
  });

  it('read an absent name set as "not published here", never as empty', async () => {
    const place = await getPlace(PLACE);
    expect(place).not.toHaveProperty('names');
    expect(placeDisplayName(place)).toBe(PLACE.name);
  });

  it('reject a name under a language tag that is not canonical', async () => {
    const error = await placeError({ ...PLACE, names: [{ language: 'ES', name: 'x', source: 'goway' }] });
    expect(error.message).toContain('response.names[0].language');
  });
});

describe('search and route responses', () => {
  it('reject a relevance outside 0..1 and a bad result kind', async () => {
    const [result] = SEARCH_RESULTS.items as Record<string, unknown>[];
    for (const bad of [{ ...result, relevance: 1.5 }, { ...result, kind: 'galaxy' }]) {
      const { fetch } = fakeFetch(200, { ...SEARCH_RESULTS, items: [bad] });
      expect(await rejection(createGoWayClient({ fetch }).search.query({ query: 'x' }))).toBeInstanceOf(
        GoWayResponseError,
      );
    }
  });

  it('carry the degraded providers through', async () => {
    const { fetch } = fakeFetch(200, { ...SEARCH_RESULTS, degradedProviders: ['nominatim'] });
    const results = await createGoWayClient({ fetch }).search.query({ query: 'x' });
    expect(results.degradedProviders).toEqual(['nominatim']);
  });

  it('accept an empty routes array as the normal "no route" answer', async () => {
    const { fetch } = fakeFetch(200, { routes: [] });
    const answer = await createGoWayClient({ fetch }).routes.directions({
      origin: { placeId: 'a' },
      destination: { placeId: 'b' },
      mode: 'drive',
    });
    expect(answer.routes).toEqual([]);
  });

  it('reject route geometry that is not a LineString, and a transposed position', async () => {
    const [route] = ROUTE_RESPONSE.routes as Record<string, unknown>[];
    const bodies = [
      { routes: [{ ...route, geometry: { type: 'Point', coordinates: [2.1686, 41.3874] } }] },
      { routes: [{ ...route, geometry: { type: 'LineString', coordinates: [[41.3874, 2.1686], [41.3881, 182.17]] } }] },
    ];
    for (const body of bodies) {
      const { fetch } = fakeFetch(200, body);
      const error = await rejection(
        createGoWayClient({ fetch }).routes.directions({ origin: { placeId: 'a' }, destination: { placeId: 'b' }, mode: 'walk' }),
      );
      expect(error).toBeInstanceOf(GoWayResponseError);
      expect(error.message).toContain('response.routes[0].geometry');
    }
  });
});

describe('empty bodies', () => {
  it('report an empty body where the contract promises one', async () => {
    const error = await placeError('');
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.message).toContain('empty or unparseable');
  });

  it('ignore whatever accompanies a 2xx for an operation whose answer is empty', async () => {
    const { fetch } = fakeFetch(200, { legacy: 'asset body' });
    await expect(createGoWayClient({ fetch }).captures.remove('asset-1')).resolves.toBeUndefined();
  });
});
