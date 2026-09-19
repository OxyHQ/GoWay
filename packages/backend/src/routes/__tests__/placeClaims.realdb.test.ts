/**
 * The claims HTTP surface, deferred from #4 and reachable now.
 *
 * It is here because of the capability write path rather than beside it: an
 * APPROVED claim is what raises an assertion from `community_reported` to
 * `business_asserted`, so "the write path is authorization-aware" is only true
 * if there is a way to acquire the authorization — and only safe if that way
 * cannot be walked all the way to approval by the person asking.
 *
 * So the assertions below are about two things: that a claim can be requested
 * and read by the people it concerns, and that nothing here lets a caller
 * decide their own claim. Approval is deliberately absent, not overlooked —
 * GoWay models no authority that could grant it.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Place, PlaceClaim } from '@goway/shared-types';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { ApiError } from '../../http/apiError';
import { errorHandler, notFoundHandler } from '../../http/errorHandler';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = {
  oxyUserId: 'user-contributor',
  assertedVerification: 'community_reported',
};

const CATALUNYA = { latitude: 41.387, longitude: 2.17 };
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };

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

async function call<T>(path: string, init: RequestInit = {}): Promise<Fetched<T>> {
  const response = await fetch(`${origin}/api/v1${path}`, init);
  return { status: response.status, body: (await response.json()) as T };
}

function asUser(user: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), 'x-test-user': user } };
}

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };
type AccountClaim = PlaceClaim & { placeId: string };

/** Unclaimed at the start of the suite. */
let vacant: Place;
/** Already claimed, approved, by `user-owner`. */
let held: Place;
/** One of a chain's two locations, for the multi-location read. */
let branchOne: Place;
let branchTwo: Place;

beforeAll(async () => {
  suite = await createSuiteDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/v1', createPlacesRouter({ optionalAuth, requireAuth }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  vacant = await createPlace(suite.db, { name: 'Local Lliure', location: CATALUNYA }, CONTRIBUTOR);
  held = await createPlace(suite.db, { name: 'Casa Reclamada', location: GRACIA }, CONTRIBUTOR);
  branchOne = await createPlace(suite.db, { name: 'Cadena Gràcia', location: GRACIA }, CONTRIBUTOR);
  branchTwo = await createPlace(suite.db, { name: 'Cadena Rambla', location: CATALUNYA }, CONTRIBUTOR);

  await createClaim(suite.db, {
    placeId: held.id,
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

describe('POST /places/:id/claims', () => {
  it('refuses an unauthenticated claim', async () => {
    // A claim without an identity cannot be reviewed, and an approved one
    // grants a verification tier — so this is the one route where failing open
    // would be worst.
    const { status, body } = await call<ErrorBody>(`/places/${vacant.id}/claims`, {
      method: 'POST',
      ...json({ role: 'owner' }),
    });
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it('records a PENDING claim attributed to the session, not to the body', async () => {
    const { status, body } = await call<PlaceClaim>(`/places/${vacant.id}/claims`, {
      method: 'POST',
      // `oxyAccountId` in the body is a client-supplied identity — an
      // authorization bypass with extra steps. It is not in the schema, so it
      // is dropped, and the claim is attributed to the session.
      ...asUser('user-applicant', json({ role: 'operator', oxyAccountId: 'user-someone-else' })),
    });

    expect(status).toBe(201);
    expect(body.state).toBe('pending');
    expect(body.role).toBe('operator');
    expect(body.oxyAccountId).toBe('user-applicant');
    expect(Number.isNaN(Date.parse(body.claimedAt))).toBe(false);
    expect(body.id).toBeString();
  });

  it('carries a brandId through, so a chain can group its locations', async () => {
    const first = await call<PlaceClaim>(`/places/${branchOne.id}/claims`, {
      method: 'POST',
      ...asUser('user-chain', json({ role: 'brand', brandId: 'org-cadena' })),
    });
    const second = await call<PlaceClaim>(`/places/${branchTwo.id}/claims`, {
      method: 'POST',
      ...asUser('user-chain', json({ role: 'brand', brandId: 'org-cadena' })),
    });
    expect(first.body.brandId).toBe('org-cadena');
    expect(second.body.brandId).toBe('org-cadena');
  });

  it('refuses a second claim in the SAME role, and says which one already exists', async () => {
    // Not a silent no-op and not a second row: the caller needs to learn their
    // earlier request is still pending rather than assume this one is new.
    const { status, body } = await call<ErrorBody>(`/places/${vacant.id}/claims`, {
      method: 'POST',
      ...asUser('user-applicant', json({ role: 'operator' })),
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.details?.state).toBe('pending');
    expect(body.error.details?.claimId).toBeString();
  });

  it('allows the same account a DIFFERENT role on the same place', async () => {
    // A place and a business are related but distinct: an account can be both
    // the operator and the manager, and the schema's uniqueness is per role
    // precisely so that stays representable.
    const { status, body } = await call<PlaceClaim>(`/places/${vacant.id}/claims`, {
      method: 'POST',
      ...asUser('user-applicant', json({ role: 'manager' })),
    });
    expect(status).toBe(201);
    expect(body.role).toBe('manager');
  });

  it('refuses a role outside the published set', async () => {
    const { status, body } = await call<ErrorBody>(`/places/${vacant.id}/claims`, {
      method: 'POST',
      ...asUser('user-applicant', json({ role: 'admin' })),
    });
    expect(status).toBe(422);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.field).toBe('role');
  });

  it('answers an unknown place with not_found rather than a foreign-key 500', async () => {
    const { status, body } = await call<ErrorBody>('/places/does-not-exist/claims', {
      method: 'POST',
      ...asUser('user-applicant', json({ role: 'owner' })),
    });
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('offers no route that decides a claim', async () => {
    // Approval needs an authority GoWay does not model — there is no admin
    // role, no moderator and no verification workflow in this repository — and
    // inventing one would be inventing the escalation #8 exists to prevent. The
    // shapes somebody would reach for do not exist, and this pins that they
    // stay absent rather than appearing half-designed.
    for (const path of [
      `/places/${vacant.id}/claims/approve`,
      `/places/${vacant.id}/claims/some-claim-id`,
      '/claims/some-claim-id/approve',
    ]) {
      const { status } = await call<ErrorBody>(path, {
        method: 'POST',
        ...asUser('user-applicant', json({ state: 'approved' })),
      });
      expect(status).toBe(404);
    }

    const rows = await suite!.client<{ state: string }[]>`
      SELECT state FROM places_claims WHERE place_id = ${vacant.id}
    `;
    expect(rows.every((row) => row.state === 'pending')).toBe(true);
  });
});

describe('GET /places/:id/claims', () => {
  it('refuses a signed-out reader', async () => {
    const { status } = await call<ErrorBody>(`/places/${held.id}/claims`);
    expect(status).toBe(401);
  });

  it('refuses a caller who holds no claim on the place', async () => {
    // 403 rather than an empty list. An empty array would assert that a claimed
    // place has no claims, which is false and is the kind of confident wrong
    // answer a consumer caches.
    const { status, body } = await call<ErrorBody>(`/places/${held.id}/claims`, asUser('user-stranger'));
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('shows a claimant their own claim and the ones they compete with', async () => {
    const contested = await createPlace(
      suite!.db,
      { name: 'Local Disputat', location: GRACIA },
      CONTRIBUTOR,
    );
    await call<PlaceClaim>(`/places/${contested.id}/claims`, {
      method: 'POST',
      ...asUser('user-first', json({ role: 'owner' })),
    });
    await call<PlaceClaim>(`/places/${contested.id}/claims`, {
      method: 'POST',
      ...asUser('user-second', json({ role: 'operator' })),
    });

    const { status, body } = await call<PlaceClaim[]>(
      `/places/${contested.id}/claims`,
      asUser('user-first'),
    );
    expect(status).toBe(200);
    // A PENDING claimant counts as entitled: they have to be able to see that
    // their own request is pending, and that somebody else is asking too.
    expect(body.map((claim) => claim.oxyAccountId).sort()).toEqual(['user-first', 'user-second']);
    expect(body.every((claim) => claim.state === 'pending')).toBe(true);
  });

  it('answers an unknown place with not_found, before it answers forbidden', async () => {
    // 403 for an id that does not exist would confirm to a stranger that an id
    // they guessed is real.
    const { status, body } = await call<ErrorBody>('/places/does-not-exist/claims', asUser('user-stranger'));
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});

describe('GET /claims', () => {
  it('returns the caller own claims across places, with the place each is over', async () => {
    const { status, body } = await call<AccountClaim[]>('/claims', asUser('user-chain'));
    expect(status).toBe(200);
    // The multi-location read: a chain gets its locations in one request
    // instead of one per place.
    expect(body.map((claim) => claim.placeId).sort()).toEqual([branchOne.id, branchTwo.id].sort());
    expect(body.every((claim) => claim.oxyAccountId === 'user-chain')).toBe(true);
    expect(body.every((claim) => claim.brandId === 'org-cadena')).toBe(true);
  });

  it('is keyed on the SESSION and not on anything the caller can send', async () => {
    // A `?oxyAccountId=` parameter here would be an enumeration of who has
    // claimed what — a business relationship GoWay publishes to the parties
    // involved and to nobody else.
    const { body } = await call<AccountClaim[]>(
      `/claims?oxyAccountId=user-chain&brandId=org-cadena`,
      asUser('user-nobody'),
    );
    expect(body).toEqual([]);
  });

  it('refuses a signed-out reader', async () => {
    const { status } = await call<ErrorBody>('/claims');
    expect(status).toBe(401);
  });
});
