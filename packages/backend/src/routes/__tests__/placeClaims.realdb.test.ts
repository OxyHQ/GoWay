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
import type { Place, PlaceClaim, PlaceClaimPage } from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { ApiError } from '../../http/apiError';
import { errorHandler, unknownRouteHandler } from '../../http/errorHandler';
import { createPlacesRouter } from '../places';
import { apiAuthor, NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';

const CONTRIBUTOR: PlaceActor = {
  author: apiAuthor('user-contributor'),
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
  app.use(
    '/api/v1',
    createPlacesRouter({
      optionalAuth,
      requireAuth,
      accountRoles: NO_MEMBERSHIPS,
      reportRateLimit: NO_RATE_LIMIT,
    }),
  );
  app.use(unknownRouteHandler);
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  vacant = await createPlace(suite.db, { name: 'Local Lliure', location: CATALUNYA }, CONTRIBUTOR);
  held = await createPlace(suite.db, { name: 'Casa Reclamada', location: GRACIA }, CONTRIBUTOR);
  branchOne = await createPlace(suite.db, { name: 'Cadena Gràcia', location: GRACIA }, CONTRIBUTOR);
  branchTwo = await createPlace(
    suite.db,
    { name: 'Cadena Rambla', location: CATALUNYA },
    CONTRIBUTOR,
  );

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

  it('refuses a claim in another account name unless Oxy says the caller may file for it', async () => {
    // `oxyAccountId` names an organization the caller claims to speak for. The
    // claim is only as good as Oxy's answer, and in this suite Oxy reports no
    // membership in anything.
    const { status, body } = await call<ErrorBody>(`/places/${vacant.id}/claims`, {
      method: 'POST',
      ...asUser('user-applicant', json({ role: 'operator', oxyAccountId: 'user-someone-else' })),
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('records a PENDING claim attributed to the session when it names no account', async () => {
    const { status, body } = await call<PlaceClaim>(`/places/${vacant.id}/claims`, {
      method: 'POST',
      ...asUser('user-applicant', json({ role: 'operator' })),
    });

    expect(status).toBe(201);
    expect(body.state).toBe('pending');
    expect(body.role).toBe('operator');
    expect(body.oxyAccountId).toBe('user-applicant');
    expect(Number.isNaN(Date.parse(body.claimedAt))).toBe(false);
    expect(body.id).toBeString();
  });

  it('files a chain as one account claiming each location in the brand role', async () => {
    const first = await call<PlaceClaim>(`/places/${branchOne.id}/claims`, {
      method: 'POST',
      // A `brandId` is no longer part of the contract: it is dropped, and the
      // brand is the account itself.
      ...asUser('user-chain', json({ role: 'brand', brandId: 'org-cadena' })),
    });
    const second = await call<PlaceClaim>(`/places/${branchTwo.id}/claims`, {
      method: 'POST',
      ...asUser('user-chain', json({ role: 'brand' })),
    });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect([first.body.role, second.body.role]).toEqual(['brand', 'brand']);
    expect(first.body).not.toHaveProperty('brandId');
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

describe('GET /places/{placeId}/claims', () => {
  it('refuses a signed-out reader', async () => {
    const { status } = await call<ErrorBody>(`/places/${held.id}/claims`);
    expect(status).toBe(401);
  });

  it('refuses a caller who holds no claim on the place', async () => {
    // 403 rather than an empty list. An empty array would assert that a claimed
    // place has no claims, which is false and is the kind of confident wrong
    // answer a consumer caches.
    const { status, body } = await call<ErrorBody>(
      `/places/${held.id}/claims`,
      asUser('user-stranger'),
    );
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

    const { status, body } = await call<PlaceClaimPage>(
      `/places/${contested.id}/claims`,
      asUser('user-first'),
    );
    expect(status).toBe(200);
    // A PENDING claimant counts as entitled: they have to be able to see that
    // their own request is pending, and that somebody else is asking too.
    expect(body.items.map((claim) => claim.oxyAccountId).sort()).toEqual([
      'user-first',
      'user-second',
    ]);
    expect(
      body.items.every((claim) => claim.state === 'pending' && claim.placeId === contested.id),
    ).toBe(true);
    expect(body.items.every((claim) => claim.decidedAt === undefined)).toBe(true);

    // Entitlement is asked of the whole table, not of the page: a claimant
    // whose own claim falls on the SECOND page still reads the first.
    const first = await call<PlaceClaimPage>(
      `/places/${contested.id}/claims?limit=1`,
      asUser('user-second'),
    );
    expect(first.status).toBe(200);
    expect(first.body.items.map((claim) => claim.oxyAccountId)).toEqual(['user-first']);
    const second = await call<PlaceClaimPage>(
      `/places/${contested.id}/claims?limit=1&cursor=${first.body.nextCursor ?? ''}`,
      asUser('user-second'),
    );
    expect(second.body.items.map((claim) => claim.oxyAccountId)).toEqual(['user-second']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('answers an unknown place with not_found, before it answers forbidden', async () => {
    // 403 for an id that does not exist would confirm to a stranger that an id
    // they guessed is real.
    const { status, body } = await call<ErrorBody>(
      '/places/does-not-exist/claims',
      asUser('user-stranger'),
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});

describe('GET /claims', () => {
  it('returns the caller own claims across places, with the place each is over', async () => {
    const { status, body } = await call<PlaceClaimPage>('/claims', asUser('user-chain'));
    expect(status).toBe(200);
    // The multi-location read: a chain gets its locations in one request
    // instead of one per place.
    expect(body.items.map((claim) => claim.placeId).sort()).toEqual(
      [branchOne.id, branchTwo.id].sort(),
    );
    expect(body.items.every((claim) => claim.oxyAccountId === 'user-chain')).toBe(true);
    // Both still pending, so neither carries a decision time.
    expect(
      body.items.every((claim) => claim.state === 'pending' && claim.decidedAt === undefined),
    ).toBe(true);
  });

  it('pages oldest first, and refuses one account cursor under another', async () => {
    const first = await call<PlaceClaimPage>('/claims?limit=1', asUser('user-chain'));
    expect(first.body.items).toHaveLength(1);
    const cursor = first.body.nextCursor ?? '';
    expect(cursor).not.toBe('');

    const second = await call<PlaceClaimPage>(
      `/claims?limit=1&cursor=${cursor}`,
      asUser('user-chain'),
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0]?.id).not.toBe(first.body.items[0]?.id);

    // A cursor is opaque, not sealed: an edited position is refused as
    // `bad_request`, never handed to Postgres to fail as a 500.
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      p: [string, string];
    };
    const edited = Buffer.from(
      JSON.stringify({ ...decoded, p: ['not a time', decoded.p[1]] }),
    ).toString('base64url');
    const tampered = await call<ErrorBody>(
      `/claims?limit=1&cursor=${edited}`,
      asUser('user-chain'),
    );
    expect(tampered.status).toBe(400);
    expect(tampered.body.error.code).toBe('bad_request');

    // The session is in the cursor's binding: replaying it as somebody else is
    // a foreign cursor, not a view of the chain's claims.
    const replayed = await call<ErrorBody>(
      `/claims?limit=1&cursor=${cursor}`,
      asUser('user-nobody'),
    );
    expect(replayed.status).toBe(400);
    expect(replayed.body.error.code).toBe('bad_request');
  });

  it('narrows to one place with placeId, and binds the cursor to it', async () => {
    const { status, body } = await call<PlaceClaimPage>(
      `/claims?placeId=${branchTwo.id}`,
      asUser('user-chain'),
    );
    expect(status).toBe(200);
    expect(body.items.map((claim) => [claim.placeId, claim.role])).toEqual([
      [branchTwo.id, 'brand'],
    ]);
    expect(body.nextCursor).toBeNull();

    // A place the account holds nothing on is an empty list, not a refusal:
    // the filter narrows the caller's own list and reveals nothing else.
    const elsewhere = await call<PlaceClaimPage>(
      `/claims?placeId=does-not-exist`,
      asUser('user-chain'),
    );
    expect(elsewhere.body).toEqual({ items: [], nextCursor: null });

    // A cursor minted for every place does not resume a list of one.
    const first = await call<PlaceClaimPage>('/claims?limit=1', asUser('user-chain'));
    const narrowed = await call<ErrorBody>(
      `/claims?limit=1&placeId=${branchTwo.id}&cursor=${first.body.nextCursor ?? ''}`,
      asUser('user-chain'),
    );
    expect(narrowed.status).toBe(400);
    expect(narrowed.body.error.code).toBe('bad_request');
  });

  it('lists another account only when Oxy says the caller acts for it', async () => {
    // An `?oxyAccountId=` the caller does not act for would be an enumeration of
    // who has claimed what. In this suite Oxy reports no membership at all.
    const { status, body } = await call<ErrorBody>(
      '/claims?oxyAccountId=user-chain',
      asUser('user-nobody'),
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');

    // Naming yourself is the default, said out loud.
    const self = await call<PlaceClaimPage>(
      '/claims?oxyAccountId=user-nobody',
      asUser('user-nobody'),
    );
    expect(self.body).toEqual({ items: [], nextCursor: null });

    // A parameter the contract does not declare is still `bad_request`.
    const unknown = await call<ErrorBody>('/claims?brandId=org-cadena', asUser('user-nobody'));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('bad_request');
  });

  it('refuses a signed-out reader', async () => {
    const { status } = await call<ErrorBody>('/claims');
    expect(status).toBe(401);
  });
});
