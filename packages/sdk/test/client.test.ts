import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  DEFAULT_GOWAY_API_BASE_URL,
  DEFAULT_PLACE_LIST_LIMIT,
  GoWayValidationError,
  MAX_PLACE_LIST_LIMIT,
  MAX_WAYPOINTS,
  type CapabilityKey,
  type GoWayClient,
  type PlaceCapabilityInput,
  type PlaceCreateInput,
} from '../src/index';
import { fakeFetch, queryOf, rejection } from './helpers';
import { CLAIM, page, PLACE, PLACE_WITH_DISTANCE, ROUTE_RESPONSE, SEARCH_RESULTS } from './fixtures';

function clientFor(body: unknown, status = 200) {
  const { fetch, calls } = fakeFetch(status, body);
  return { client: createGoWayClient({ fetch, getAccessToken: () => 'token' }), calls };
}

function sentBody(calls: { init: { body?: string } }[], index = 0): Record<string, unknown> {
  return JSON.parse(calls[index]?.init.body ?? '{}') as Record<string, unknown>;
}

describe('createGoWayClient options', () => {
  it('rejects a bad base URL, locale, timeout and header before any request', () => {
    expect(() => createGoWayClient({ apiBaseUrl: 'api.goway.to' })).toThrow(TypeError);
    expect(() => createGoWayClient({ apiBaseUrl: 'https://api.goway.to/v1?x=1' })).toThrow(TypeError);
    expect(() => createGoWayClient({ webBaseUrl: 'javascript:alert(1)' })).toThrow(TypeError);
    expect(() => createGoWayClient({ locale: 'not a locale' })).toThrow(TypeError);
    expect(() => createGoWayClient({ timeoutMs: 0 })).toThrow(TypeError);
    expect(() => createGoWayClient({ timeoutMs: 1.5 })).toThrow(TypeError);
    // @ts-expect-error a non-function fetch is a programmer error
    expect(() => createGoWayClient({ fetch: 'no' })).toThrow(TypeError);
  });

  it('refuses to let a caller set the SDK-owned headers', () => {
    expect(() => createGoWayClient({ headers: { Authorization: 'Bearer leaked' } })).toThrow(/SDK owns it/);
    expect(() => createGoWayClient({ headers: { accept: 'text/html' } })).toThrow(/SDK owns it/);
    expect(() => createGoWayClient({ headers: { 'bad header': 'x' } })).toThrow(TypeError);
    expect(() => createGoWayClient({ headers: { 'X-Trace-Id': 'abc' } })).not.toThrow();
  });

  it('returns a frozen client whose namespaces are frozen too', () => {
    const client: GoWayClient = createGoWayClient();
    expect(Object.isFrozen(client)).toBe(true);
    for (const namespace of [
      client.places,
      client.places.capabilities,
      client.places.claims,
      client.claims,
      client.search,
      client.geocode,
      client.routes,
      client.captures,
      client.street3d,
      client.links,
    ]) {
      expect(Object.isFrozen(namespace)).toBe(true);
    }
  });

  it('defaults to the production API origin', async () => {
    const { client, calls } = clientFor(PLACE);
    await client.places.get('gw_place_01H8');
    expect(calls[0]?.url).toBe(`${DEFAULT_GOWAY_API_BASE_URL}/api/v1/places/gw_place_01H8`);
  });
});

describe('query serialisation', () => {
  it('is byte-identical for two equivalent nearby queries', async () => {
    const { client, calls } = clientFor(page([PLACE_WITH_DISTANCE]));
    await client.places.nearby({
      latitude: 41.3874,
      longitude: 2.1686,
      radiusMeters: 5000,
      capabilities: ['payments.faircoin.accepted', 'commerce.mercaria.store'],
      categories: ['food.cafe', 'food.bar'],
      limit: 20,
    });
    await client.places.nearby({
      limit: 20,
      categories: ['food.bar', 'food.cafe', 'food.bar'],
      capabilities: ['commerce.mercaria.store', 'payments.faircoin.accepted'],
      radiusMeters: 5000,
      longitude: 2.1686,
      latitude: 41.3874,
    });
    expect(calls[0]?.url).toBe(calls[1]?.url);
    expect(queryOf(calls[0]?.url ?? '')).toBe(
      'capabilities=commerce.mercaria.store,payments.faircoin.accepted&' +
        'categories=food.bar,food.cafe&latitude=41.3874&limit=20&longitude=2.1686&radiusMeters=5000',
    );
  });

  it('sends the contract default limit and omits absent parameters', async () => {
    const { client, calls } = clientFor(page([]));
    await client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 100, capabilities: [] });
    expect(queryOf(calls[0]?.url ?? '')).toBe(`latitude=0&limit=${DEFAULT_PLACE_LIST_LIMIT}&longitude=0&radiusMeters=100`);
  });

  it('passes a cursor back verbatim', async () => {
    const { client, calls } = clientFor(page([]));
    await client.places.inBounds({ west: 0, south: 0, east: 1, north: 1, cursor: 'opaque_Cursor-1' });
    expect(queryOf(calls[0]?.url ?? '')).toContain('cursor=opaque_Cursor-1');
  });

  it('percent-encodes a place id in the path and refuses a traversal', async () => {
    const { client, calls } = clientFor(PLACE);
    await client.places.get('gw place/01?x');
    expect(calls[0]?.url).toBe(`${DEFAULT_GOWAY_API_BASE_URL}/api/v1/places/gw%20place%2F01%3Fx`);
    await expect(client.places.get('..')).rejects.toBeInstanceOf(GoWayValidationError);
    await expect(client.places.get('')).rejects.toBeInstanceOf(GoWayValidationError);
  });
});

describe('client-side validation with the contract schemas', () => {
  it('refuses before sending anything, naming the field but never the value', async () => {
    const { client, calls } = clientFor(page([]));
    const error = await rejection(client.places.nearby({ latitude: 91.25, longitude: 2, radiusMeters: 10 }));
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(error.status).toBeNull();
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('query.latitude');
    expect(error.message).not.toContain('91.25');
    expect(calls).toHaveLength(0);
  });

  it('refuses an unknown query parameter rather than dropping it', async () => {
    const { client, calls } = clientFor(page([]));
    const query = { latitude: 0, longitude: 0, radiusMeters: 10, radius: 10 } as never;
    expect(await rejection(client.places.nearby(query))).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });

  it('holds limits and radii to the contract maxima', async () => {
    const { client } = clientFor(page([]));
    const box = { west: 0, south: 0, east: 1, north: 1 };
    await expect(client.places.inBounds({ ...box, limit: MAX_PLACE_LIST_LIMIT + 1 })).rejects.toBeInstanceOf(
      GoWayValidationError,
    );
    await expect(client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 50_001 })).rejects.toBeInstanceOf(
      GoWayValidationError,
    );
    await expect(client.search.query({ query: 'x', limit: 51 })).rejects.toBeInstanceOf(GoWayValidationError);
  });

  it('refuses a capability key that is not a lower-case namespaced key', async () => {
    const { client } = clientFor(page([]));
    for (const key of ['faircoin', 'Payments.FairCoin.Accepted', 'payments..accepted']) {
      await expect(
        client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 1, capabilities: [key] }),
      ).rejects.toBeInstanceOf(GoWayValidationError);
    }
  });

  it('allows an antimeridian-crossing box but not an inverted or oversized one', async () => {
    const { client, calls } = clientFor(page([PLACE]));
    await client.places.inBounds({ west: 179, south: -17, east: -179, north: -16 });
    expect(calls[0]?.url).toContain('/api/v1/places/bounds?');
    await expect(client.places.inBounds({ west: 0, south: 10, east: 1, north: 5 })).rejects.toBeInstanceOf(
      GoWayValidationError,
    );
    await expect(client.places.inBounds({ west: 0, south: 0, east: 120, north: 1 })).rejects.toBeInstanceOf(
      GoWayValidationError,
    );
  });

  it('refuses a null query as a validation error, not a TypeError', async () => {
    const { client } = clientFor(page([]));
    await expect(client.places.nearby(null as never)).rejects.toBeInstanceOf(GoWayValidationError);
    await expect(client.search.query(null as never)).rejects.toBeInstanceOf(GoWayValidationError);
  });
});

describe('place writes', () => {
  it('sends the parsed body: unknown keys and client-claimed verification never leave', async () => {
    const { client, calls } = clientFor(PLACE, 201);
    // A caller reaching past the types — which is exactly the case parsing the
    // body exists for. The types refuse both of these on their own:
    //   const bad: PlaceCapabilityInput = { …, verification: 'oxy_verified' };
    //   const worse: PlaceCreateInput = { …, id: 'gw_forged' };
    const forged = {
      name: '  New café ',
      location: { latitude: 41, longitude: 2 },
      capabilities: [
        { namespace: 'payments.faircoin', capability: 'accepted', value: true, verification: 'oxy_verified' },
      ],
      id: 'gw_forged',
      verification: { state: 'oxy_verified' },
    } as unknown as PlaceCreateInput;
    await client.places.create(forged);
    const body = sentBody(calls);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['Content-Type']).toBe('application/json');
    expect(body).toEqual({
      name: 'New café',
      location: { latitude: 41, longitude: 2 },
      capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
    });
  });

  it('writes translated names with canonical language tags', async () => {
    const { client, calls } = clientFor(PLACE);
    await client.places.update('gw_place_01H8', {
      names: [
        { language: 'ES', name: ' Museo Picasso ' },
        { language: 'zh_hant', name: '畢卡索博物館' },
      ],
      address: { countryCode: 'es' },
    });
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(sentBody(calls)).toEqual({
      names: [
        { language: 'es', name: 'Museo Picasso' },
        { language: 'zh-Hant', name: '畢卡索博物館' },
      ],
      address: { countryCode: 'ES' },
    });
  });

  it('refuses a status no caller may write', async () => {
    const { client, calls } = clientFor(PLACE);
    const error = await rejection(client.places.update('gw_place_01H8', { status: 'removed' } as never));
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(error.message).toContain('input.status');
    expect(calls).toHaveLength(0);
  });

  it('refuses a client-claimed verification at compile time too', () => {
    const claim: PlaceCapabilityInput = {
      namespace: 'payments.faircoin',
      capability: 'accepted',
      value: true,
      // @ts-expect-error `verification` is server-derived: a client cannot assert it
      verification: 'oxy_verified',
    };
    expect(claim.value).toBe(true);
  });

  it('refuses an update that changes nothing', async () => {
    const { client } = clientFor(PLACE);
    await expect(client.places.update('gw_place_01H8', {})).rejects.toBeInstanceOf(GoWayValidationError);
  });
});

describe('capabilities and claims', () => {
  it('asserts one capability with PUT and gets the place back', async () => {
    const { client, calls } = clientFor(PLACE);
    const place = await client.places.capabilities.put('gw_place_01H8', 'payments.faircoin.accepted', {
      value: true,
      source: { source: 'openstreetmap', sourceId: 'node/1' },
      verification: 'oxy_verified',
    } as never);
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.url).toBe(
      `${DEFAULT_GOWAY_API_BASE_URL}/api/v1/places/gw_place_01H8/capabilities/payments.faircoin.accepted`,
    );
    expect(sentBody(calls)).toEqual({ value: true, source: { source: 'openstreetmap', sourceId: 'node/1' } });
    expect(place.id).toBe('gw_place_01H8');
  });

  it('refuses a capability key in the path that is not a registered one', async () => {
    const { client, calls } = clientFor(PLACE);
    // The casts are the point: an untyped caller can still send these.
    await expect(
      client.places.capabilities.put('gw_place_01H8', 'Payments.FairCoin' as CapabilityKey, { value: true }),
    ).rejects.toBeInstanceOf(GoWayValidationError);
    await expect(
      client.places.capabilities.delete('gw_place_01H8', 'faircoin' as CapabilityKey),
    ).rejects.toBeInstanceOf(GoWayValidationError);
    await expect(
      client.places.capabilities.put('gw_place_01H8', 'payments.faircoin.rate' as CapabilityKey, { value: 1 }),
    ).rejects.toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });

  it('withdraws a capability with DELETE and resolves with nothing on 204', async () => {
    const { client, calls } = clientFor('', 204);
    await expect(client.places.capabilities.delete('gw_place_01H8', 'payments.faircoin.accepted')).resolves.toBeUndefined();
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('creates a claim and never sends a state the caller named', async () => {
    const { client, calls } = clientFor(CLAIM, 201);
    const claim = await client.places.claims.create('gw_place_01H8', { role: 'owner', state: 'approved' } as never);
    expect(calls[0]?.url).toContain('/api/v1/places/gw_place_01H8/claims');
    expect(sentBody(calls)).toEqual({ role: 'owner' });
    expect(claim.placeId).toBe('gw_place_01H8');
    expect(claim.decidedAt).toBeUndefined();
  });

  it('files a claim for an organization the caller names', async () => {
    const { client, calls } = clientFor({ ...CLAIM, oxyAccountId: 'org_cafe' }, 201);
    const claim = await client.places.claims.create('gw_place_01H8', { role: 'brand', oxyAccountId: ' org_cafe ' });
    expect(sentBody(calls)).toEqual({ role: 'brand', oxyAccountId: 'org_cafe' });
    expect(claim.oxyAccountId).toBe('org_cafe');
  });

  it('lists an organization’s claims when asked for its account', async () => {
    const { client, calls } = clientFor(page([CLAIM]));
    await client.claims.list({ oxyAccountId: 'org_cafe', limit: 5 });
    expect(queryOf(calls[0]?.url ?? '')).toBe('limit=5&oxyAccountId=org_cafe');
  });

  it('reads a place’s public history as a page, newest first as the server sends it', async () => {
    const revision = {
      id: 'rev_1',
      placeId: 'gw_place_01H8',
      action: 'place_updated',
      source: 'api',
      changes: [{ field: 'name', before: 'Old', after: 'New' }, { field: 'address.postalCode', after: '08012' }],
      createdAt: '2026-10-04T10:00:00.000Z',
      oxyAccountId: 'org_secret',
    };
    const { client, calls } = clientFor(page([revision], 'next_1'));
    const history = await client.places.revisions('gw_place_01H8', { limit: 10 });
    expect(calls[0]?.url).toBe(`${DEFAULT_GOWAY_API_BASE_URL}/api/v1/places/gw_place_01H8/revisions?limit=10`);
    expect(history.items[0]?.changes).toEqual(revision.changes);
    // A field the public contract does not name never reaches the caller.
    expect(history.items[0]).not.toHaveProperty('oxyAccountId');
  });

  it('reports a place, and refuses a reason outside the set before sending', async () => {
    const report = { id: 'rep_1', placeId: 'gw_place_01H8', reason: 'spam', createdAt: '2026-10-04T10:00:00.000Z' };
    const { client, calls } = clientFor(report, 201);
    expect(await client.places.report('gw_place_01H8', { reason: 'spam', note: ' fake tickets ' })).toEqual(report);
    expect(sentBody(calls)).toEqual({ reason: 'spam', note: 'fake tickets' });

    const refused = await rejection(client.places.report('gw_place_01H8', { reason: 'boring' } as never));
    expect(refused).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(1);
  });

  it('lists a place’s claims and the caller’s own claims as pages', async () => {
    const decided = { ...CLAIM, state: 'approved', decidedAt: '2026-10-02T00:00:00.000Z' };
    const { client, calls } = clientFor(page([decided], 'next_1'));
    const onPlace = await client.places.claims.list('gw_place_01H8', { limit: 10 });
    const mine = await client.claims.list({ cursor: 'next_1' });
    expect(queryOf(calls[0]?.url ?? '')).toBe('limit=10');
    expect(calls[1]?.url).toBe(`${DEFAULT_GOWAY_API_BASE_URL}/api/v1/claims?cursor=next_1&limit=50`);
    expect(onPlace.items[0]?.decidedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(mine.nextCursor).toBe('next_1');
  });
});

describe('access tokens', () => {
  it('asks for a token before every request and never caches one', async () => {
    let issued = 0;
    const { fetch, calls } = fakeFetch(200, PLACE);
    const client = createGoWayClient({
      fetch,
      getAccessToken: () => `token-${++issued}`,
    });
    await client.places.get('a');
    await client.places.get('b');
    await client.places.get('c');
    expect(issued).toBe(3);
    expect(calls.map((call) => call.init.headers.Authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
      'Bearer token-3',
    ]);
  });

  it('sends no Authorization header when the getter declines', async () => {
    const { fetch, calls } = fakeFetch(200, PLACE);
    const client = createGoWayClient({ fetch, getAccessToken: async () => null });
    await client.places.get('a');
    expect(calls[0]?.init.headers).not.toHaveProperty('Authorization');
    expect(calls[0]?.init.credentials).toBe('omit');
  });

  it('never stores the token on the client', async () => {
    const { fetch } = fakeFetch(200, PLACE);
    const client = createGoWayClient({ fetch, getAccessToken: () => 'super-secret' });
    await client.places.get('a');
    expect(JSON.stringify(client)).not.toContain('super-secret');
  });

  it('passes an error thrown by the getter straight through', async () => {
    const boom = new Error('sign-in expired');
    const { fetch } = fakeFetch(200, PLACE);
    const client = createGoWayClient({ fetch, getAccessToken: () => { throw boom; } });
    await expect(client.places.get('a')).rejects.toBe(boom);
  });
});

describe('namespaces', () => {
  it('nearby filters by capability and answers a page', async () => {
    const { client, calls } = clientFor(page([PLACE_WITH_DISTANCE], 'cursor_2'));
    const merchants = await client.places.nearby({
      latitude: 41.3874,
      longitude: 2.1686,
      radiusMeters: 5000,
      capabilities: ['payments.faircoin.accepted'],
    });
    expect(calls[0]?.url).toContain('/api/v1/places/nearby?');
    expect(calls[0]?.url).toContain('capabilities=payments.faircoin.accepted');
    expect(merchants.items[0]?.distanceMeters).toBe(412.5);
    expect(merchants.items[0]?.capabilities[0]?.verification).toBe('oxy_verified');
    expect(merchants.nextCursor).toBe('cursor_2');
  });

  it('routes search, geocode and directions to their own endpoints', async () => {
    const search = clientFor(SEARCH_RESULTS);
    const results = await search.client.search.query({ query: '  cafè  ', limit: 5 });
    expect(search.calls[0]?.url).toContain('/api/v1/search?');
    expect(queryOf(search.calls[0]?.url ?? '')).toBe('limit=5&q=caf%C3%A8');
    expect(results.items[0]?.placeId).toBe('gw_place_01H8');
    expect(results.nextCursor).toBeNull();

    const forward = clientFor(SEARCH_RESULTS);
    await forward.client.geocode.forward({
      query: 'Carrer de Sants',
      near: { latitude: 41.38, longitude: 2.16 },
      viewport: { west: 2.1, south: 41.3, east: 2.2, north: 41.4 },
    });
    expect(queryOf(forward.calls[0]?.url ?? '')).toBe(
      'east=2.2&latitude=41.38&longitude=2.16&north=41.4&q=Carrer%20de%20Sants&south=41.3&west=2.1',
    );

    const geocode = clientFor(SEARCH_RESULTS);
    await geocode.client.geocode.reverse({ latitude: 41.38, longitude: 2.16, radiusMeters: 50 });
    expect(geocode.calls[0]?.url).toContain('/api/v1/geocode/reverse?');

    const structured = clientFor(SEARCH_RESULTS);
    await structured.client.geocode.structured({ city: 'Barcelona', countryCode: 'es' });
    expect(queryOf(structured.calls[0]?.url ?? '')).toBe('city=Barcelona&countryCode=ES');
    await expect(structured.client.geocode.structured({})).rejects.toBeInstanceOf(GoWayValidationError);

    const routes = clientFor(ROUTE_RESPONSE);
    const answer = await routes.client.routes.directions({
      origin: { coordinate: { latitude: 41.38, longitude: 2.16 } },
      destination: { placeId: 'gw_place_01H8' },
      mode: 'walk',
    });
    expect(routes.calls[0]?.init.method).toBe('POST');
    expect(routes.calls[0]?.url).toBe(`${DEFAULT_GOWAY_API_BASE_URL}/api/v1/routes`);
    expect(answer.routes[0]?.geometry.coordinates[0]).toEqual([2.1686, 41.3874]);
  });

  it('refuses a route end that names neither a coordinate nor a place', async () => {
    const { client } = clientFor(ROUTE_RESPONSE);
    await expect(
      client.routes.directions({ origin: {}, destination: { placeId: 'x' }, mode: 'drive' }),
    ).rejects.toBeInstanceOf(GoWayValidationError);
  });

  it('refuses a travel mode this SDK does not know, and too many waypoints', async () => {
    const { client, calls } = clientFor(ROUTE_RESPONSE);
    const ends = { origin: { placeId: 'a' }, destination: { placeId: 'b' } };
    const error = await rejection(client.routes.directions({ ...ends, mode: 'transit' } as never));
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(error.message).toContain('routeRequest.mode');
    const waypoints = Array.from({ length: MAX_WAYPOINTS + 1 }, () => ({ placeId: 'w' }));
    await expect(client.routes.directions({ ...ends, waypoints, mode: 'walk' })).rejects.toBeInstanceOf(
      GoWayValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it('applies the client locale, normalized, and lets a call override it', async () => {
    const { fetch, calls } = fakeFetch(200, SEARCH_RESULTS);
    const client = createGoWayClient({ fetch, locale: 'CA' });
    await client.search.query({ query: 'x' });
    await client.search.query({ query: 'x', locale: 'pt-br' });
    expect(queryOf(calls[0]?.url ?? '')).toContain('locale=ca');
    expect(queryOf(calls[1]?.url ?? '')).toContain('locale=pt-BR');
  });

  it('carries the client locale into the place reads and into directions', async () => {
    const { fetch, calls } = fakeFetch(200, PLACE);
    const client = createGoWayClient({ fetch, locale: 'ca' });
    await client.places.get('gw_place_01H8');
    await client.places.get('gw_place_01H8', { locale: 'es-MX' });
    expect(queryOf(calls[0]?.url ?? '')).toBe('locale=ca');
    expect(queryOf(calls[1]?.url ?? '')).toBe('locale=es-MX');

    const list = fakeFetch(200, page([PLACE]));
    const listing = createGoWayClient({ fetch: list.fetch, locale: 'ca' });
    await listing.places.inBounds({ west: 0, south: 0, east: 1, north: 1 });
    await listing.places.inBounds({ west: 0, south: 0, east: 1, north: 1, locale: 'fr' });
    expect(queryOf(list.calls[0]?.url ?? '')).toContain('locale=ca');
    expect(queryOf(list.calls[1]?.url ?? '')).toContain('locale=fr');

    const route = fakeFetch(200, ROUTE_RESPONSE);
    await createGoWayClient({ fetch: route.fetch, locale: 'ca' }).routes.directions({
      origin: { placeId: 'a' },
      destination: { placeId: 'b' },
      mode: 'walk',
    });
    expect(sentBody(route.calls).locale).toBe('ca');
  });

  it('refuses a locale that is not a language tag, on a place read too', async () => {
    const { fetch } = fakeFetch(200, PLACE);
    const client = createGoWayClient({ fetch });
    await expect(client.places.get('p', { locale: '???' })).rejects.toBeInstanceOf(GoWayValidationError);
  });
});

describe('links', () => {
  it('builds the canonical place deep link from a GoWay Place ID', () => {
    const client = createGoWayClient();
    expect(client.links.place('gw_place_01H8')).toBe('https://goway.to/place/gw_place_01H8');
    expect(client.links.place({ id: 'gw place/1' })).toBe('https://goway.to/place/gw%20place%2F1');
    // A search result carries the reconciled GoWay id under `placeId`.
    expect(client.links.place({ placeId: 'gw_2', id: 'photon:node/1' })).toBe('https://goway.to/place/gw_2');
    expect(() => client.links.place('')).toThrow(GoWayValidationError);
  });

  it('honours a custom web origin and frames the map on a viewport', () => {
    const client = createGoWayClient({ webBaseUrl: 'https://staging.goway.to/' });
    expect(client.links.place('p')).toBe('https://staging.goway.to/place/p');
    expect(client.links.map({ latitude: 41.38, longitude: 2.16, zoom: 14 })).toBe(
      'https://staging.goway.to/?lat=41.38&lng=2.16&zoom=14',
    );
    expect(() => client.links.map({ latitude: 91, longitude: 0, zoom: 1 })).toThrow(GoWayValidationError);
    expect(() => client.links.map({ latitude: 0, longitude: 0, zoom: Number.NaN })).toThrow(GoWayValidationError);
  });
});
