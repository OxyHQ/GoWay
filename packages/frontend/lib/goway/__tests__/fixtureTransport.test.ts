/**
 * The fixture transport answers exactly what GoWay answers.
 *
 * `mockTransport.ts` sits UNDER the real SDK, and the SDK parses every response
 * with the contract's own zod schemas — so a fixture that drifts from the
 * contract (a `null` where a field is optional, a list that is not a page, an
 * error code outside the closed list) is a `GoWayResponseError` the first time
 * the app reads it. Every route the app reads is driven here, through the real
 * client, so that drift fails a test instead of a screen.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  API_ERROR_STATUS,
  categoryTaxonomy,
  createGoWayClient,
  GoWayGoneError,
  GoWayNotFoundError,
  iterateGoWayPages,
  type GoWayClient,
} from '@goway.to/sdk';

import { classifyGoWayError } from '@/lib/goway/errors';
import {
  FIXTURE_CATEGORIES,
  FIXTURE_PLACES,
  FIXTURE_WITHDRAWN_PLACE_IDS,
} from '@/lib/goway/fixtures';
import {
  createFixtureFetch,
  setFixtureFaults,
  type FixtureFaults,
} from '@/lib/goway/mockTransport';

const API = 'https://api.goway.to';
const BARCELONA = { west: 2.1, south: 41.35, east: 2.22, north: 41.42 };
const PLAÇA_CATALUNYA = { latitude: 41.387, longitude: 2.17 };

/** A client served by the fixtures, degraded from its first request by `faults`. */
function fixtureClient(faults: FixtureFaults = {}): GoWayClient {
  return createGoWayClient({ apiBaseUrl: API, locale: 'es', fetch: createFixtureFetch(faults) });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

// The fault table is module state; leave it clean for whichever test runs next.
afterEach(() => setFixtureFaults({}));

describe('lists are pages', () => {
  test('the viewport read is one page of places, and the last page says so', async () => {
    const page = await fixtureClient().places.inBounds(BARCELONA);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.nextCursor).toBeNull();
    // A list read carries `localizedName` alone, never every language.
    expect(page.items.every((place) => place.names === undefined)).toBe(true);
  });

  test('a short page hands back a cursor, and walking it reaches the same places', async () => {
    const client = fixtureClient();
    const whole = await client.places.inBounds(BARCELONA);
    const first = await client.places.inBounds({ ...BARCELONA, limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    const walked: string[] = [];
    for await (const place of iterateGoWayPages((cursor) =>
      client.places.inBounds({ ...BARCELONA, limit: 3, ...(cursor ? { cursor } : {}) }),
    )) {
      walked.push(place.id);
    }
    expect(walked).toEqual(whole.items.map((place) => place.id));
  });

  test('nearby is a page of places with distances, nearest first', async () => {
    const page = await fixtureClient().places.nearby({ ...PLAÇA_CATALUNYA, radiusMeters: 1500 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.nextCursor).toBeNull();
    const distances = page.items.map((place) => place.distanceMeters);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  test('a category root matches every category below it, as the API expands it', async () => {
    const food = await fixtureClient().places.inBounds({ ...BARCELONA, categories: ['food'] });
    expect(food.items.length).toBeGreaterThan(3);
    expect(
      food.items.every((place) => place.categories.some((key) => key.startsWith('food.'))),
    ).toBe(true);
  });

  test('a capability value filter goes through the strongest assertion', async () => {
    const client = fixtureClient();
    const seafood = await client.places.inBounds({
      ...BARCELONA,
      capabilities: ['food.cuisine:seafood'],
    });
    expect(seafood.items.map((place) => place.id)).toEqual(['gw_restaurant_can_sole']);
    // Can Solé's business says `no`, over a community `yes`.
    const accessible = await client.places.inBounds({
      ...BARCELONA,
      capabilities: ['accessibility.wheelchair'],
    });
    expect(accessible.items.map((place) => place.id)).not.toContain('gw_restaurant_can_sole');
    expect(accessible.items.map((place) => place.id)).toContain('gw_museu_picasso');
  });

  test('a list read carries the hours exceptions open-now needs, as a single read does', async () => {
    const client = fixtureClient();
    const listed = await client.places.inBounds(BARCELONA);
    expect(listed.items.every((place) => Array.isArray(place.hoursExceptions))).toBe(true);
    expect(
      listed.items.find((place) => place.id === 'gw_museu_picasso')?.hoursExceptions,
    ).toHaveLength(2);
    const museum = await client.places.get('gw_museu_picasso');
    expect(museum.hoursExceptions).toHaveLength(2);
    expect(museum.timezone).toBe('Europe/Madrid');
  });

  test('a cursor the list never issued is refused, not served as page one', async () => {
    const error = await failureOf(
      fixtureClient().places.inBounds({ ...BARCELONA, cursor: 'forged' }),
    );
    expect(error).toMatchObject({ status: API_ERROR_STATUS.bad_request, code: 'bad_request' });
  });
});

describe('the category taxonomy', () => {
  test('is one page, labelled for the locale asked for, every language kept', async () => {
    const page = await fixtureClient().categories.list({ locale: 'es-MX' });
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((category) => category.key)).toEqual(
      FIXTURE_CATEGORIES.map((category) => category.key),
    );
    const cafe = page.items.find((category) => category.key === 'food.cafe');
    expect(cafe?.label).toBe('Cafetería');
    expect(cafe?.labels).toEqual({ en: 'Café', es: 'Cafetería' });
    expect(
      (await fixtureClient().categories.list()).items.find(
        (category) => category.key === 'food.cafe',
      )?.label,
    ).toBe('Café');
  });

  test('holds every key a fixture place carries, and every parent of one', async () => {
    const taxonomy = categoryTaxonomy((await fixtureClient().categories.list()).items);
    for (const place of FIXTURE_PLACES) {
      for (const key of place.categories) expect(taxonomy.of(key)?.key).toBe(key);
    }
    for (const category of taxonomy.categories) {
      if (category.parent !== null) expect(taxonomy.of(category.parent)).toBeDefined();
    }
  });

  test('a root filter expands to the categories below it, as the API does', async () => {
    const page = await fixtureClient().places.inBounds({ ...BARCELONA, categories: ['food'] });
    expect(page.items.length).toBeGreaterThan(0);
    expect(
      page.items.every((place) => place.categories.some((key) => key.startsWith('food.'))),
    ).toBe(true);
  });
});

describe('single places', () => {
  test('every fixture place parses as a published place, names included', async () => {
    const client = fixtureClient();
    const read = await Promise.all(FIXTURE_PLACES.map((place) => client.places.get(place.id)));
    expect(read.map((place) => place.id)).toEqual(FIXTURE_PLACES.map((place) => place.id));
  });

  test('a withdrawn place is gone, and renders as no longer on GoWay', async () => {
    const [withdrawn] = FIXTURE_WITHDRAWN_PLACE_IDS;
    const error = await failureOf(fixtureClient().places.get(withdrawn));
    expect(error).toBeInstanceOf(GoWayGoneError);
    expect(classifyGoWayError(error)).toEqual({ kind: 'gone', retryable: false });
  });

  test('a place that never existed is not found', async () => {
    const error = await failureOf(fixtureClient().places.get('gw_never_was'));
    expect(error).toBeInstanceOf(GoWayNotFoundError);
    expect(classifyGoWayError(error).kind).toBe('notFound');
  });
});

describe('search and geocoding answer SearchResults', () => {
  test('search lists items with the providers that answered', async () => {
    const results = await fixtureClient().search.query({ query: 'carrer', limit: 20 });
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.nextCursor).toBeNull();
    expect(results.providers).toEqual(['goway', 'photon']);
    expect(results.degradedProviders).toBeUndefined();
  });

  test('a degraded provider shortens the list instead of failing it', async () => {
    const results = await fixtureClient({ search: 'degraded' }).search.query({ query: 'gràcia' });
    expect(results.degradedProviders).toEqual(['photon']);
  });

  test('forward, reverse and structured geocoding all parse', async () => {
    const client = fixtureClient();
    const forward = await client.geocode.forward({ query: 'gràcia' });
    const reverse = await client.geocode.reverse({
      ...FIXTURE_PLACES[0].location,
      radiusMeters: 50,
      limit: 1,
    });
    const structured = await client.geocode.structured({ city: 'Barcelona' });
    expect(forward.items.length).toBeGreaterThan(0);
    expect(reverse.items).toHaveLength(1);
    expect(structured).toEqual({ items: [], nextCursor: null, providers: ['nominatim'] });
  });
});

describe('directions', () => {
  test('a multi-stop route parses, one leg per pair of stops', async () => {
    const [first, second, third] = FIXTURE_PLACES;
    const response = await fixtureClient().routes.directions({
      origin: { coordinate: first.location },
      waypoints: [{ placeId: second.id }],
      destination: { coordinate: third.location },
      mode: 'walk',
    });
    expect(response.routes[0]?.legs).toHaveLength(2);
  });
});

describe('failures arrive as the contract envelope', () => {
  test('an unavailable family is a 503 the app reads as unavailable', async () => {
    const error = await failureOf(
      fixtureClient({ places: 'unavailable' }).places.inBounds(BARCELONA),
    );
    expect(classifyGoWayError(error)).toEqual({ kind: 'unavailable', retryable: true });
  });

  test('a dropped connection reads as offline', async () => {
    const error = await failureOf(
      fixtureClient({ search: 'network' }).search.query({ query: 'carrer' }),
    );
    expect(classifyGoWayError(error).kind).toBe('offline');
  });

  test('a path no route serves is unknown_route, not not_found', async () => {
    const response = await createFixtureFetch()(`${API}/api/v1/claims`, {
      method: 'GET',
      headers: {},
      credentials: 'omit',
      redirect: 'follow',
    });
    expect(response.status).toBe(API_ERROR_STATUS.unknown_route);
    expect(JSON.parse(await response.text())).toMatchObject({ error: { code: 'unknown_route' } });
  });
});

describe('galleries and reviews', () => {
  test("a place's gallery and reviews are pages, and its rating is derived from the reviews", async () => {
    const client = fixtureClient();
    const gallery = await client.places.media.list('gw_mercat_boqueria');
    expect(gallery.items.length).toBeGreaterThan(0);
    const reviews = await client.places.reviews.list('gw_mercat_boqueria');
    const place = await client.places.get('gw_mercat_boqueria');
    const average =
      reviews.items.reduce((total, review) => total + review.rating, 0) / reviews.items.length;
    expect(place.rating).toEqual({
      average: Math.round(average * 10) / 10,
      count: reviews.items.length,
    });
    expect(place.logoFileId).toBe(gallery.items.find((item) => item.kind === 'logo')?.fileId);
  });

  test('reviews come in the three orders', async () => {
    const client = fixtureClient();
    const highest = await client.places.reviews.list('gw_mercat_boqueria', { sort: 'highest' });
    const ratings = highest.items.map((review) => review.rating);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
    const lowest = await client.places.reviews.list('gw_mercat_boqueria', { sort: 'lowest' });
    expect(lowest.items.map((review) => review.rating)).toEqual([...ratings].reverse());
  });

  test('a description is a single-place read, resolved for the locale, and absent from lists', async () => {
    const client = fixtureClient();
    const place = await client.places.get('gw_mercat_boqueria');
    expect(place.localizedDescription?.language).toBe('es');
    expect(place.description).toBeDefined();
    const listed = (await client.places.inBounds(BARCELONA)).items.find(
      (entry) => entry.id === 'gw_mercat_boqueria',
    );
    expect(listed?.description).toBeUndefined();
    expect(listed?.descriptions).toBeUndefined();
  });

  test('your review is written, read back, counted, and withdrawn', async () => {
    const client = fixtureClient();
    expect(await failureOf(client.places.reviews.mine('gw_parc_ciutadella'))).toBeInstanceOf(
      GoWayNotFoundError,
    );
    const written = await client.places.reviews.put('gw_parc_ciutadella', {
      rating: 4,
      body: 'Lovely on Sundays.',
    });
    expect(written.status).toBe('published');
    expect((await client.places.reviews.mine('gw_parc_ciutadella')).rating).toBe(4);
    expect((await client.places.get('gw_parc_ciutadella')).rating).toEqual({
      average: 4,
      count: 1,
    });
    await client.places.reviews.delete('gw_parc_ciutadella');
    expect((await client.places.get('gw_parc_ciutadella')).rating).toBeUndefined();
  });

  test('a withdrawn place answers its gallery with gone', async () => {
    const [withdrawn] = [...FIXTURE_WITHDRAWN_PLACE_IDS];
    expect(await failureOf(fixtureClient().places.media.list(withdrawn!))).toBeInstanceOf(
      GoWayGoneError,
    );
  });
});
