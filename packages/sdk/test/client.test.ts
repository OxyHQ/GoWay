import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  DEFAULT_GOWAY_API_BASE_URL,
  GoWayValidationError,
  type GoWayClient,
  type PlaceCapabilityInput,
  type PlaceCreateInput,
} from '../src/index';
import { fakeFetch, queryOf } from './helpers';
import { PLACE, PLACE_WITH_DISTANCE, ROUTE_RESPONSE, SEARCH_RESULTS } from './fixtures';

function clientFor(body: unknown, status = 200) {
  const { fetch, calls } = fakeFetch(status, body);
  return { client: createGoWayClient({ fetch }), calls };
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
    expect(Object.isFrozen(client.places)).toBe(true);
    expect(Object.isFrozen(client.links)).toBe(true);
  });

  it('defaults to the production API origin', async () => {
    const { client, calls } = clientFor(PLACE);
    await client.places.get('gw_place_01H8');
    expect(calls[0]?.url).toBe(`${DEFAULT_GOWAY_API_BASE_URL}/api/v1/places/gw_place_01H8`);
  });
});

describe('query serialisation', () => {
  it('is byte-identical for two equivalent nearby queries', async () => {
    const { client, calls } = clientFor([PLACE_WITH_DISTANCE]);
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

  it('omits absent parameters entirely rather than sending empty ones', async () => {
    const { client, calls } = clientFor([PLACE_WITH_DISTANCE]);
    await client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 100, capabilities: [] });
    expect(queryOf(calls[0]?.url ?? '')).toBe('latitude=0&longitude=0&radiusMeters=100');
  });

  it('percent-encodes a place id in the path and refuses a traversal', async () => {
    const { client, calls } = clientFor(PLACE);
    await client.places.get('gw place/01?x');
    expect(calls[0]?.url).toBe(`${DEFAULT_GOWAY_API_BASE_URL}/api/v1/places/gw%20place%2F01%3Fx`);
    await expect(client.places.get('..')).rejects.toBeInstanceOf(GoWayValidationError);
    await expect(client.places.get('')).rejects.toBeInstanceOf(GoWayValidationError);
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
  it('nearby filters by capability without exposing the capability table', async () => {
    const { client, calls } = clientFor([PLACE_WITH_DISTANCE]);
    const merchants = await client.places.nearby({
      latitude: 41.3874,
      longitude: 2.1686,
      radiusMeters: 5000,
      capabilities: ['payments.faircoin.accepted'],
    });
    expect(calls[0]?.url).toContain('/api/v1/places/nearby?');
    expect(calls[0]?.url).toContain('capabilities=payments.faircoin.accepted');
    expect(merchants[0]?.distanceMeters).toBe(412.5);
    expect(merchants[0]?.capabilities[0]?.verification).toBe('oxy_verified');
  });

  it('refuses a capability key that is not namespaced', async () => {
    const { client } = clientFor([]);
    await expect(
      client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 1, capabilities: ['faircoin'] }),
    ).rejects.toBeInstanceOf(GoWayValidationError);
  });

  it('allows an antimeridian-crossing box but not an inverted one', async () => {
    const { client, calls } = clientFor([PLACE]);
    await client.places.inBounds({ west: 179, south: -17, east: -179, north: -16 });
    expect(calls[0]?.url).toContain('/api/v1/places/bounds?');
    await expect(client.places.inBounds({ west: 0, south: 10, east: 1, north: 5 })).rejects.toBeInstanceOf(
      GoWayValidationError,
    );
  });

  it('writes a place body field by field, dropping client-claimed verification', async () => {
    const { client, calls } = clientFor(PLACE);
    // A caller reaching past the types — which is exactly the case the body
    // builder exists for. The types refuse both of these on their own:
    //   const bad: PlaceCapabilityInput = { …, verification: 'oxy_verified' };
    //   const worse: PlaceCreateInput = { …, id: 'gw_forged' };
    const forged = {
      name: 'New café',
      location: { latitude: 41, longitude: 2 },
      capabilities: [
        { namespace: 'payments.faircoin', capability: 'accepted', value: true, verification: 'oxy_verified' },
      ],
      id: 'gw_forged',
    } as unknown as PlaceCreateInput;
    await client.places.create(forged);
    const body = JSON.parse(calls[0]?.init.body ?? '{}') as Record<string, unknown>;
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['Content-Type']).toBe('application/json');
    expect(body).not.toHaveProperty('id');
    expect(body.capabilities).toEqual([{ namespace: 'payments.faircoin', capability: 'accepted', value: true }]);
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

  it('routes search, geocode and directions to their own endpoints', async () => {
    const search = clientFor(SEARCH_RESULTS);
    await search.client.search.query({ query: '  cafè  ', limit: 5 });
    expect(search.calls[0]?.url).toContain('/api/v1/search?');
    expect(queryOf(search.calls[0]?.url ?? '')).toBe('limit=5&q=caf%C3%A8');

    const geocode = clientFor(SEARCH_RESULTS);
    await geocode.client.geocode.reverse({ latitude: 41.38, longitude: 2.16, radiusMeters: 50 });
    expect(geocode.calls[0]?.url).toContain('/api/v1/geocode/reverse?');

    const structured = clientFor(SEARCH_RESULTS);
    await structured.client.geocode.structured({ city: 'Barcelona', countryCode: 'ES' });
    expect(structured.calls[0]?.url).toContain('/api/v1/geocode/structured?');
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

  it('applies the client locale and lets a call override it', async () => {
    const { fetch, calls } = fakeFetch(200, SEARCH_RESULTS);
    const client = createGoWayClient({ fetch, locale: 'ca' });
    await client.search.query({ query: 'x' });
    await client.search.query({ query: 'x', locale: 'pt-BR' });
    expect(queryOf(calls[0]?.url ?? '')).toContain('locale=ca');
    expect(queryOf(calls[1]?.url ?? '')).toContain('locale=pt-BR');
  });

  it('carries the client locale into the three place reads', async () => {
    // Before 0.1.1 the client locale reached search, geocoding and routing but
    // not `places.*` — so a map set to Catalan fetched its own pins in
    // whatever language the row happened to be stored in.
    const { fetch, calls } = fakeFetch(200, PLACE);
    const client = createGoWayClient({ fetch, locale: 'ca' });
    await client.places.get('gw_place_01H8');
    await client.places.get('gw_place_01H8', { locale: 'es-MX' });
    expect(queryOf(calls[0]?.url ?? '')).toContain('locale=ca');
    expect(queryOf(calls[1]?.url ?? '')).toContain('locale=es-MX');

    const list = fakeFetch(200, [PLACE]);
    const listing = createGoWayClient({ fetch: list.fetch, locale: 'ca' });
    await listing.places.inBounds({ west: 0, south: 0, east: 1, north: 1 });
    await listing.places.inBounds({ west: 0, south: 0, east: 1, north: 1, locale: 'fr' });
    expect(queryOf(list.calls[0]?.url ?? '')).toContain('locale=ca');
    expect(queryOf(list.calls[1]?.url ?? '')).toContain('locale=fr');

    const near = fakeFetch(200, [PLACE_WITH_DISTANCE]);
    const nearby = createGoWayClient({ fetch: near.fetch, locale: 'ca' });
    await nearby.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10 });
    expect(queryOf(near.calls[0]?.url ?? '')).toContain('locale=ca');
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
  });
});
