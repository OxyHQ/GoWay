/**
 * The richer place data over a real socket and a real PostGIS database: the
 * category taxonomy, typed capabilities, the derived timezone and dated hours
 * exceptions.
 *
 * Most of what is asserted is a REFUSAL — a category that is not in the
 * taxonomy, a capability key that is not registered, a value of the wrong kind,
 * an exception rewritten at somebody else's tier — because each of those is a
 * value that would otherwise be stored and then rendered as if it meant
 * something.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CATEGORY_KEYS,
  type CategoryPage,
  type Place,
  type PlaceHoursException,
  type PlaceHoursExceptionPage,
  type PlaceWithDistancePage,
} from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { ApiError } from '../../http/apiError';
import { errorHandler, unknownRouteHandler } from '../../http/errorHandler';
import { createCategoriesRouter } from '../categories';
import { createPlacesRouter } from '../places';
import { apiAuthor, NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('user-contributor'), assertedVerification: 'community_reported' };

/** A box of Barcelona nothing else in this file writes into. */
const RAVAL = { latitude: 41.3801, longitude: 2.1669 };
const NEAR_RAVAL = 'latitude=41.3801&longitude=2.1669&radiusMeters=3000';

let suite: SuiteDatabase | null = null;
let server: Server;
let origin: string;

const optionalAuth: RequestHandler = (request, _response, next) => {
  const user = request.header('x-test-user');
  if (user) request.userId = user;
  next();
};

const requireAuth: RequestHandler = (request, _response, next) => {
  const user = request.header('x-test-user');
  if (!user) {
    next(new ApiError('unauthorized', 'This request requires an Oxy session.'));
    return;
  }
  request.userId = user;
  next();
};

interface Fetched<T> {
  status: number;
  body: T;
}

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

async function call<T>(path: string, init: RequestInit = {}): Promise<Fetched<T>> {
  const response = await fetch(`${origin}/api/v1${path}`, init);
  return { status: response.status, body: (response.status === 204 ? undefined : await response.json()) as T };
}

function as(user: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'x-test-user': user, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** Claimed and approved by `user-owner`. */
let claimed: Place;
/** Nobody's. */
let open: Place;

beforeAll(async () => {
  suite = await createSuiteDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/v1', createCategoriesRouter());
  app.use('/api/v1', createPlacesRouter({ optionalAuth, requireAuth, accountRoles: NO_MEMBERSHIPS, reportRateLimit: NO_RATE_LIMIT }));
  app.use(unknownRouteHandler);
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  claimed = await createPlace(
    suite.db,
    { name: 'Forn del Raval', location: RAVAL, categories: ['food.bakery'] },
    CONTRIBUTOR,
  );
  open = await createPlace(
    suite.db,
    { name: 'Trattoria Oberta', location: { latitude: 41.3805, longitude: 2.1672 }, categories: ['food.restaurant'] },
    CONTRIBUTOR,
  );
  await createClaim(suite.db, { placeId: claimed.id, oxyAccountId: 'user-owner', role: 'owner', state: 'approved' });
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  server?.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('GET /categories', () => {
  it('publishes the whole taxonomy, with parents, glyphs and labels', async () => {
    const { status, body } = await call<CategoryPage>('/categories');
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((category) => category.key)).toEqual([...CATEGORY_KEYS]);
    expect(body.items.find((category) => category.key === 'food.cafe')).toEqual({
      key: 'food.cafe',
      parent: 'food',
      icon: 'cafe',
      labels: { en: 'Café', es: 'Cafetería' },
    });
  });
});

describe('categories on a place', () => {
  it('refuses a category that is not in the taxonomy, on a write and on a filter', async () => {
    const write = await call<ErrorBody>('/places', as('user-x', 'POST', { name: 'X', location: RAVAL, categories: ['cafe'] }));
    expect(write.status).toBe(422);
    expect(write.body.error.details?.field).toBe('categories.0');

    const filter = await call<ErrorBody>(`/places/nearby?${NEAR_RAVAL}&categories=food_drink`);
    expect(filter.status).toBe(422);
  });

  it('expands a parent to every category below it', async () => {
    const food = await call<PlaceWithDistancePage>(`/places/nearby?${NEAR_RAVAL}&categories=food`);
    expect(food.body.items.map((place) => place.id).sort()).toEqual([claimed.id, open.id].sort());

    const bakeries = await call<PlaceWithDistancePage>(`/places/nearby?${NEAR_RAVAL}&categories=food.bakery`);
    expect(bakeries.body.items.map((place) => place.id)).toEqual([claimed.id]);

    const shops = await call<PlaceWithDistancePage>(`/places/nearby?${NEAR_RAVAL}&categories=shop`);
    expect(shops.body.items).toEqual([]);
  });
});

describe('the timezone', () => {
  it('is derived from the position and follows it', async () => {
    expect(claimed.timezone).toBe('Europe/Madrid');
    const created = await call<Place>('/places', as('user-x', 'POST', { name: 'Lisboa', location: { latitude: 38.7223, longitude: -9.1393 } }));
    expect(created.body.timezone).toBe('Europe/Lisbon');

    const moved = await call<Place>(
      `/places/${created.body.id}`,
      as('user-x', 'PATCH', { location: { latitude: 40.4168, longitude: -3.7038 } }),
    );
    expect(moved.body.timezone).toBe('Europe/Madrid');
  });

  it('cannot be written by a caller', async () => {
    const { status } = await call<Place>(
      `/places/${open.id}`,
      as('user-x', 'PATCH', { name: 'Trattoria Oberta', timezone: 'Asia/Tokyo' }),
    );
    expect(status).toBe(200);
    const { body } = await call<Place>(`/places/${open.id}`);
    expect(body.timezone).toBe('Europe/Madrid');
  });
});

describe('typed capabilities', () => {
  it('refuses a key the registry does not have', async () => {
    const { status, body } = await call<ErrorBody>(
      `/places/${open.id}/capabilities/payments.faircoin.rate`,
      as('user-x', 'PUT', { value: 1.02 }),
    );
    expect(status).toBe(400);
    expect(body.error.details?.field).toBe('key');
  });

  it("refuses a value outside the key's own type", async () => {
    const asText = await call<ErrorBody>(`/places/${open.id}/capabilities/amenities.wifi`, as('user-x', 'PUT', { value: 'yes' }));
    expect(asText.status).toBe(422);
    expect(asText.body.error.details?.field).toBe('value');

    const outOfSet = await call<ErrorBody>(
      `/places/${open.id}/capabilities/accessibility.wheelchair`,
      as('user-x', 'PUT', { value: 'sometimes' }),
    );
    expect(outOfSet.status).toBe(422);

    const price = await call<ErrorBody>(`/places/${open.id}/capabilities/price.level`, as('user-x', 'PUT', { value: 5 }));
    expect(price.status).toBe(422);

    const inBody = await call<ErrorBody>(
      `/places/${open.id}`,
      as('user-x', 'PATCH', { capabilities: [{ namespace: 'amenities', capability: 'teleporter', value: true }] }),
    );
    expect(inBody.status).toBe(422);
    expect(inBody.body.error.details?.field).toBe('capabilities.0.capability');
  });

  it('stores a value normalized by its key: a handle as its URL, a set in registry order', async () => {
    await call<Place>(`/places/${open.id}/capabilities/social.instagram`, as('user-x', 'PUT', { value: '@trattoria' }));
    const { body } = await call<Place>(
      `/places/${open.id}/capabilities/food.cuisine`,
      as('user-x', 'PUT', { value: ['pizza', 'italian', 'pizza'] }),
    );
    const valueOf = (key: string) => body.capabilities.find((capability) => capability.key === key)?.value;
    expect(valueOf('social.instagram')).toBe('https://www.instagram.com/trattoria');
    expect(valueOf('food.cuisine')).toEqual(['italian', 'pizza']);
  });

  it('filters by an enum-set member, an enum value and a price level, through the strongest assertion', async () => {
    await call(`/places/${claimed.id}/capabilities/accessibility.wheelchair`, as('user-owner', 'PUT', { value: 'no' }));
    await call(`/places/${claimed.id}/capabilities/accessibility.wheelchair`, as('user-x', 'PUT', { value: 'yes' }));
    await call(`/places/${open.id}/capabilities/accessibility.wheelchair`, as('user-x', 'PUT', { value: 'limited' }));
    await call(`/places/${open.id}/capabilities/price.level`, as('user-x', 'PUT', { value: 2 }));

    const ids = async (filter: string) =>
      (await call<PlaceWithDistancePage>(`/places/nearby?${NEAR_RAVAL}&capabilities=${filter}`)).body.items.map(
        (place) => place.id,
      );

    expect(await ids('food.cuisine:italian')).toEqual([open.id]);
    expect(await ids('food.cuisine:sushi')).toEqual([]);
    // The business's `no` outranks a community `yes`, and `no` is an absence.
    expect(await ids('accessibility.wheelchair')).toEqual([open.id]);
    expect(await ids('accessibility.wheelchair:no')).toEqual([claimed.id]);
    expect(await ids('accessibility.wheelchair:limited,price.level:2')).toEqual([open.id]);
    expect(await ids('accessibility.wheelchair:limited,price.level:3')).toEqual([]);

    const refused = await call<ErrorBody>(`/places/nearby?${NEAR_RAVAL}&capabilities=amenities.wifi:maybe`);
    expect(refused.status).toBe(422);
  });
});

describe('hours exceptions', () => {
  const CLOSURE = { startsOn: '2030-12-25', closed: true, note: 'Christmas' };

  it('records a report at the tier the caller earned, whatever the body says', async () => {
    // A tier in the body is dropped, never honoured.
    const created = await call<PlaceHoursException>(
      `/places/${claimed.id}/hours-exceptions`,
      as('user-x', 'POST', { ...CLOSURE, verification: 'oxy_verified', source: 'openstreetmap' }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      startsOn: '2030-12-25',
      endsOn: '2030-12-25',
      closed: true,
      intervals: [],
      note: 'Christmas',
      source: 'goway',
      verification: 'community_reported',
    });

    const business = await call<PlaceHoursException>(`/places/${claimed.id}/hours-exceptions`, as('user-owner', 'POST', CLOSURE));
    expect(business.status).toBe(201);
    expect(business.body.verification).toBe('business_asserted');
  });

  it('refuses the same dates twice at one tier, naming the exception to rewrite', async () => {
    const { status, body } = await call<ErrorBody>(`/places/${claimed.id}/hours-exceptions`, as('user-y', 'POST', CLOSURE));
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(typeof body.error.details?.exceptionId).toBe('string');
  });

  it('refuses a malformed exception as validation_failed', async () => {
    const backwards = await call<ErrorBody>(
      `/places/${claimed.id}/hours-exceptions`,
      as('user-x', 'POST', { startsOn: '2030-01-10', endsOn: '2030-01-01', closed: true }),
    );
    expect(backwards.status).toBe(422);
    const contradictory = await call<ErrorBody>(
      `/places/${claimed.id}/hours-exceptions`,
      as('user-x', 'POST', { startsOn: '2030-01-10', closed: true, intervals: [{ opens: '10:00', closes: '12:00' }] }),
    );
    expect(contradictory.status).toBe(422);
    const notADate = await call<ErrorBody>(
      `/places/${claimed.id}/hours-exceptions`,
      as('user-x', 'POST', { startsOn: '2030-02-30', closed: true }),
    );
    expect(notADate.status).toBe(422);
  });

  it('lets each tier rewrite only its own exception', async () => {
    const list = await call<PlaceHoursExceptionPage>(`/places/${claimed.id}/hours-exceptions`);
    const business = list.body.items.find((exception) => exception.verification === 'business_asserted')!;
    const community = list.body.items.find((exception) => exception.verification === 'community_reported')!;

    const intrusion = await call<ErrorBody>(
      `/places/${claimed.id}/hours-exceptions/${business.id}`,
      as('user-x', 'PUT', { startsOn: '2030-12-25', closed: false, intervals: [{ opens: '10:00', closes: '14:00' }] }),
    );
    expect(intrusion.status).toBe(403);

    const own = await call<PlaceHoursException>(
      `/places/${claimed.id}/hours-exceptions/${community.id}`,
      as('user-y', 'PUT', { startsOn: '2030-12-25', closed: false, intervals: [{ opens: '10:00', closes: '14:00' }] }),
    );
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ closed: false, intervals: [{ opens: '10:00', closes: '14:00' }] });
    expect(own.body.note).toBeUndefined();
  });

  it('lets only the claimant withdraw, and only the business tier', async () => {
    const list = await call<PlaceHoursExceptionPage>(`/places/${claimed.id}/hours-exceptions`);
    const business = list.body.items.find((exception) => exception.verification === 'business_asserted')!;
    const community = list.body.items.find((exception) => exception.verification === 'community_reported')!;

    expect((await call(`/places/${claimed.id}/hours-exceptions/${community.id}`, as('user-x', 'DELETE'))).status).toBe(403);
    expect((await call(`/places/${claimed.id}/hours-exceptions/${community.id}`, as('user-owner', 'DELETE'))).status).toBe(
      404,
    );
    expect((await call(`/places/${claimed.id}/hours-exceptions/${business.id}`, as('user-owner', 'DELETE'))).status).toBe(
      204,
    );
  });

  it('pages the full list and embeds the current ones in the place', async () => {
    for (const startsOn of ['2031-01-01', '2031-02-01', '2031-03-01']) {
      await call(`/places/${open.id}/hours-exceptions`, as('user-x', 'POST', { startsOn, closed: true }));
    }
    // One that ended long ago: listed, never embedded.
    await call(`/places/${open.id}/hours-exceptions`, as('user-x', 'POST', { startsOn: '2020-01-01', closed: true }));

    const first = await call<PlaceHoursExceptionPage>(`/places/${open.id}/hours-exceptions?limit=2`);
    expect(first.body.items.map((exception) => exception.startsOn)).toEqual(['2020-01-01', '2031-01-01']);
    const second = await call<PlaceHoursExceptionPage>(
      `/places/${open.id}/hours-exceptions?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((exception) => exception.startsOn)).toEqual(['2031-02-01', '2031-03-01']);
    expect(second.body.nextCursor).toBeNull();

    const place = await call<Place>(`/places/${open.id}`);
    expect(place.body.hoursExceptions?.map((exception) => exception.startsOn)).toEqual([
      '2031-01-01',
      '2031-02-01',
      '2031-03-01',
    ]);
    // A list read carries no exceptions at all — absent, not empty.
    const nearby = await call<PlaceWithDistancePage>(`/places/nearby?${NEAR_RAVAL}`);
    expect(nearby.body.items.every((item) => item.hoursExceptions === undefined)).toBe(true);
  });

  it('answers 404 for an unknown place and requires a session to write', async () => {
    expect((await call('/places/no-such-place/hours-exceptions')).status).toBe(404);
    const anonymous = await call(`/places/${open.id}/hours-exceptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CLOSURE),
    });
    expect(anonymous.status).toBe(401);
  });
});
