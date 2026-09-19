/**
 * The Places API over a real socket and a real PostGIS database.
 *
 * What is asserted here is what an `@goway.to/sdk` consumer actually observes:
 * the paths, the status codes, the error envelope, the response SHAPE, and the
 * two rules that are policy rather than plumbing — that a claimed place is not
 * community-editable, and that nothing a caller sends can raise their own
 * capability claim above the tier they are entitled to.
 *
 * ## The auth middlewares are injected, and the real ones are not exercised
 *
 * `createOxyAuthMiddleware` verifies a token against the Oxy identity service
 * over HTTP; standing one up is not what this suite is about. `createApp()`
 * passes the real ones, and `app.test.ts` covers the composition. What these
 * fakes reproduce is the only contract the router depends on: `requireAuth`
 * fails closed with `unauthorized`, and both publish `req.userId`.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Place, PlaceWithDistance } from '@goway/shared-types';
import { createPlace, createClaim, type PlaceActor } from '../../db/places/placesRepository';
import { SUITE_SETUP_TIMEOUT_MS, createSuiteDatabase, destroySuiteDatabase, type SuiteDatabase } from '../../db/__tests__/testDatabase';
import { ApiError } from '../../http/apiError';
import { errorHandler, notFoundHandler } from '../../http/errorHandler';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { oxyUserId: 'user-contributor', assertedVerification: 'community_reported' };

/** Plaça de Catalunya and two points around it, so distances are real. */
const CATALUNYA = { latitude: 41.387, longitude: 2.17 };
/** ~1.2 km north-west. */
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
/** ~505 km away: outside every radius this file asks for. */
const MADRID = { latitude: 40.4168, longitude: -3.7038 };

let suite: SuiteDatabase | null = null;
let server: Server;
let origin: string;

/** `x-test-user` stands in for a verified Oxy session. */
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
  headers: Headers;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<Fetched<T>> {
  const response = await fetch(`${origin}/api/v1${path}`, init);
  return { status: response.status, body: (await response.json()) as T, headers: response.headers };
}

function asUser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string>), 'x-test-user': user },
  };
}

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

let catalunya: Place;
let gracia: Place;
let claimed: Place;

beforeAll(async () => {
  suite = await createSuiteDatabase();

  const app = express();
  app.use(express.json());
  // Mounted at the path `GOWAY_API_BASE_PATH` names, so every URL this file
  // requests is byte-identical to one the SDK would build.
  app.use('/api/v1', createPlacesRouter({ optionalAuth, requireAuth }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  catalunya = await createPlace(
    suite.db,
    {
      name: 'Bar Pinotxo',
      location: CATALUNYA,
      categories: ['food.bar', 'food'],
      address: { street: 'La Rambla', city: 'Barcelona', countryCode: 'ES' },
      contact: { website: 'https://example.test/pinotxo' },
      sources: [{ source: 'openstreetmap', sourceId: 'node/100' }],
      capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
    },
    CONTRIBUTOR,
  );
  gracia = await createPlace(
    suite.db,
    { name: 'Forn Gràcia', location: GRACIA, categories: ['food.bakery'] },
    CONTRIBUTOR,
  );
  await createPlace(suite.db, { name: 'Puerta del Sol', location: MADRID }, CONTRIBUTOR);

  claimed = await createPlace(suite.db, { name: 'Casa Batlló', location: CATALUNYA }, CONTRIBUTOR);
  await createClaim(suite.db, {
    placeId: claimed.id,
    oxyAccountId: 'user-owner',
    role: 'owner',
    state: 'approved',
  });
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('GET /places/:id', () => {
  it('answers a signed-out caller with the published Place shape', async () => {
    // The map opens without an account; a read that required one would break
    // the product's first rule.
    const { status, body } = await call<Place>(`/places/${catalunya.id}`);
    expect(status).toBe(200);
    expect(body.id).toBe(catalunya.id);
    expect(body.name).toBe('Bar Pinotxo');
    expect(body.location).toEqual(CATALUNYA);
    expect(body.status).toBe('active');
    expect(body.verification.state).toBe('unverified');
    expect(body.address?.countryCode).toBe('ES');
    expect(body.sources[0]?.sourceId).toBe('node/100');
    // The invariant the SDK's parser REFUSES a response over.
    expect(body.capabilities[0]?.key).toBe(
      `${body.capabilities[0]?.namespace}.${body.capabilities[0]?.capability}`,
    );
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  });

  it('publishes no internal column, whatever the table grows', async () => {
    // The projection is explicit rather than a spread, so these can only appear
    // if somebody adds them deliberately. `geo` is the PostGIS blob, and
    // `createdByOxyUserId` is contribution authorship that no consumer is owed.
    const { body } = await call<Record<string, unknown>>(`/places/${catalunya.id}`);
    for (const internal of ['geo', 'nameNormalized', 'name_normalized', 'createdByOxyUserId', 'verificationState']) {
      expect(body).not.toHaveProperty(internal);
    }
  });

  it('omits claims entirely for a caller who holds none — absent is not empty', async () => {
    const anonymous = await call<Place>(`/places/${claimed.id}`);
    expect(anonymous.body).not.toHaveProperty('claims');

    const outsider = await call<Place>(`/places/${claimed.id}`, asUser('user-stranger'));
    expect(outsider.body).not.toHaveProperty('claims');

    const owner = await call<Place>(`/places/${claimed.id}`, asUser('user-owner'));
    expect(owner.body.claims?.[0]?.role).toBe('owner');
    expect(owner.body.claims?.[0]?.state).toBe('approved');
  });

  it('answers an unknown id with the not_found envelope', async () => {
    const { status, body } = await call<ErrorBody>('/places/does-not-exist');
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});

describe('GET /places/nearby', () => {
  it('returns nearest-first with a real distance in metres', async () => {
    const { status, body } = await call<PlaceWithDistance[]>(
      `/places/nearby?latitude=${CATALUNYA.latitude}&longitude=${CATALUNYA.longitude}&radiusMeters=5000`,
    );
    expect(status).toBe(200);
    expect(body[0]?.distanceMeters).toBeLessThan(1);
    // Gràcia is ~1.2 km away and Madrid ~505 km: the radius excludes Madrid
    // rather than merely ranking it last.
    const names = body.map((place) => place.name);
    expect(names).toContain('Forn Gràcia');
    expect(names).not.toContain('Puerta del Sol');
    expect(body[body.length - 1]?.distanceMeters).toBeGreaterThan(1000);
  });

  it('accepts the short parameter names issue #4 documents', async () => {
    const { status, body } = await call<PlaceWithDistance[]>(
      `/places/nearby?lat=${CATALUNYA.latitude}&lng=${CATALUNYA.longitude}&radius=500`,
    );
    expect(status).toBe(200);
    expect(body.map((place) => place.name)).toEqual(['Bar Pinotxo', 'Casa Batlló']);
  });

  it('filters by capability without a client knowing the capability table exists', async () => {
    const { body } = await call<PlaceWithDistance[]>(
      `/places/nearby?latitude=${CATALUNYA.latitude}&longitude=${CATALUNYA.longitude}` +
        '&radiusMeters=5000&capabilities=payments.faircoin.accepted',
    );
    expect(body.map((place) => place.name)).toEqual(['Bar Pinotxo']);
  });

  it('treats several capabilities as a CONJUNCTION', async () => {
    // Asking for both means both. A disjunction here would send a FairCoin
    // wallet to a shop that takes something else entirely.
    const { body } = await call<PlaceWithDistance[]>(
      `/places/nearby?latitude=${CATALUNYA.latitude}&longitude=${CATALUNYA.longitude}` +
        '&radiusMeters=5000&capabilities=payments.faircoin.accepted,commerce.mercaria.store',
    );
    expect(body).toEqual([]);
  });

  it('treats several categories as a DISJUNCTION', async () => {
    const { body } = await call<PlaceWithDistance[]>(
      `/places/nearby?latitude=${CATALUNYA.latitude}&longitude=${CATALUNYA.longitude}` +
        '&radiusMeters=5000&categories=food.bar,food.bakery',
    );
    expect(body.map((place) => place.name).sort()).toEqual(['Bar Pinotxo', 'Forn Gràcia']);
  });

  it('answers an out-of-range coordinate with validation_failed, not a 500', async () => {
    const { status, body } = await call<ErrorBody>(
      '/places/nearby?latitude=120&longitude=2.17&radiusMeters=500',
    );
    expect(status).toBe(422);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.field).toBe('latitude');
  });

  it('never writes the offending coordinate into the error it returns', async () => {
    // `details` is the part of an error an integrator may log verbatim, and a
    // user's precise position is transient request data that is never persisted
    // anywhere — including somebody else's log index.
    const { body } = await call<ErrorBody>(
      '/places/nearby?latitude=41.3874999&longitude=2.1699999&radiusMeters=0',
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('41.3874999');
    expect(serialized).not.toContain('2.1699999');
  });

  it('refuses a radius larger than the endpoint serves', async () => {
    const { status, body } = await call<ErrorBody>(
      '/places/nearby?latitude=41.387&longitude=2.17&radiusMeters=9999999',
    );
    expect(status).toBe(422);
    expect(body.error.code).toBe('validation_failed');
  });
});

describe('GET /places/bounds and GET /places?bbox=', () => {
  it('returns the places inside the viewport', async () => {
    const { status, body } = await call<Place[]>('/places/bounds?west=2.0&south=41.3&east=2.3&north=41.5');
    expect(status).toBe(200);
    expect(body.map((place) => place.name).sort()).toEqual(['Bar Pinotxo', 'Casa Batlló', 'Forn Gràcia']);
  });

  it('answers the documented bbox spelling identically', async () => {
    const named = await call<Place[]>('/places/bounds?west=2.0&south=41.3&east=2.3&north=41.5');
    const bbox = await call<Place[]>('/places?bbox=2.0,41.3,2.3,41.5');
    expect(bbox.status).toBe(200);
    expect(bbox.body.map((place) => place.id)).toEqual(named.body.map((place) => place.id));
  });

  it('refuses south > north with validation_failed', async () => {
    const { status, body } = await call<ErrorBody>('/places/bounds?west=2.0&south=41.5&east=2.3&north=41.3');
    expect(status).toBe(422);
    expect(body.error.code).toBe('validation_failed');
  });

  it('ACCEPTS west > east — that is how an antimeridian box is spelled', async () => {
    // Refusing it would make the Pacific unmappable. The asymmetry with
    // south/north is the contract, not an oversight.
    const { status, body } = await call<Place[]>('/places/bounds?west=170&south=-25&east=-170&north=-10');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('refuses a bare GET /places with no box', async () => {
    // An unbounded list would be a scan of every place on Earth truncated by a
    // LIMIT, which reads to a client as missing data rather than as a refusal.
    const { status, body } = await call<ErrorBody>('/places');
    expect(status).toBe(422);
    expect(body.error.code).toBe('validation_failed');
  });
});

describe('POST /places', () => {
  it('refuses an unauthenticated write', async () => {
    const { status, body } = await call<ErrorBody>('/places', {
      method: 'POST',
      ...json({ name: 'Anon', location: CATALUNYA }),
    });
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it('creates an unverified place with community-reported capabilities', async () => {
    const { status, body, headers } = await call<Place>('/places', {
      method: 'POST',
      ...asUser(
        'user-new',
        json({
          name: 'Llibreria Calders',
          location: GRACIA,
          categories: ['shopping.books'],
          // A caller cannot talk their own submission up: these two fields are
          // not in the schema at all, so they are dropped, and the server
          // derives both.
          verification: { state: 'oxy_verified' },
          capabilities: [
            { namespace: 'payments.faircoin', capability: 'accepted', value: true, verification: 'oxy_verified' },
          ],
        }),
      ),
    });

    expect(status).toBe(201);
    expect(headers.get('location')).toBe(`/api/v1/places/${body.id}`);
    expect(body.verification.state).toBe('unverified');
    expect(body.capabilities[0]?.verification).toBe('community_reported');
  });

  it('classifies a missing required field as bad_request and a bad value as validation_failed', async () => {
    // The two are different failures and an integrator acts differently on
    // each: the first is a bug in their serialisation, the second in what they
    // asked for.
    const missing = await call<ErrorBody>('/places', {
      method: 'POST',
      ...asUser('user-new', json({ location: CATALUNYA })),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('bad_request');

    const refused = await call<ErrorBody>('/places', {
      method: 'POST',
      ...asUser('user-new', json({ name: 'Somewhere', location: { latitude: 120, longitude: 2 } })),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('validation_failed');
  });

  it('refuses a source record another place already holds', async () => {
    const { status, body } = await call<ErrorBody>('/places', {
      method: 'POST',
      ...asUser(
        'user-new',
        json({
          name: 'Bar Pinotxo (copy)',
          location: CATALUNYA,
          sources: [{ source: 'openstreetmap', sourceId: 'node/100' }],
        }),
      ),
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.details?.placeId).toBe(catalunya.id);
  });
});

describe('PATCH /places/:id', () => {
  it('lets anyone signed in edit an UNCLAIMED place', async () => {
    // Community editing is the product. A wiki map where only owners may edit
    // has no contributors.
    const { status, body } = await call<Place>(`/places/${gracia.id}`, {
      method: 'PATCH',
      ...asUser('user-passerby', json({ status: 'closed' })),
    });
    expect(status).toBe(200);
    expect(body.status).toBe('closed');
  });

  it('refuses an outsider editing a CLAIMED place', async () => {
    const { status, body } = await call<ErrorBody>(`/places/${claimed.id}`, {
      method: 'PATCH',
      ...asUser('user-stranger', json({ name: 'Not Casa Batlló' })),
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('lets an approved claimant edit it, and weighs their capability claim higher', async () => {
    const { status, body } = await call<Place>(`/places/${claimed.id}`, {
      method: 'PATCH',
      ...asUser(
        'user-owner',
        json({
          contact: { phone: '+34932160306' },
          capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
        }),
      ),
    });
    expect(status).toBe(200);
    expect(body.contact?.phone).toBe('+34932160306');
    // A claimant asserts about their own business — stronger than a passer-by,
    // and still not `oxy_verified`.
    expect(body.capabilities[0]?.verification).toBe('business_asserted');
  });

  it('refuses an empty update rather than answering 200 for nothing', async () => {
    const { status, body } = await call<ErrorBody>(`/places/${gracia.id}`, {
      method: 'PATCH',
      ...asUser('user-passerby', json({})),
    });
    expect(status).toBe(422);
    expect(body.error.code).toBe('validation_failed');
  });

  it('answers an unknown id with not_found before it checks anything else', async () => {
    const { status, body } = await call<ErrorBody>('/places/does-not-exist', {
      method: 'PATCH',
      ...asUser('user-passerby', json({ name: 'Ghost' })),
    });
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});
