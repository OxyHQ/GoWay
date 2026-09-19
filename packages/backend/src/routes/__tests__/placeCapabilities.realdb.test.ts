/**
 * The capability WRITE path over a real socket and a real PostGIS database.
 *
 * Issue #8's acceptance criterion is not that a capability can be written — it
 * is that "anonymous/community assertions cannot masquerade as verified
 * acceptance". So most of what is asserted here is an ESCALATION ATTEMPT, made
 * the way an actual attacker would make it: send the field, hold a claim that
 * has not been approved, approve your own claim, delete the row that outranks
 * yours. Each one is answered by a tier the caller earned rather than the tier
 * they asked for.
 *
 * The happy paths are here too, but they are the cheap half. A test suite that
 * only proved a claimant can write `business_asserted` would pass just as
 * happily against a server that let a stranger write `oxy_verified`.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Place, PlaceCapability, PlaceClaim } from '@goway/shared-types';
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

const FAIRCOIN = 'payments.faircoin.accepted';

/** Old enough that no consumer should read it as a current fact. */
const TWO_YEARS_AGO = new Date('2023-09-19T10:00:00.000Z');

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

/** Every published assertion of one capability key, whatever its tier. */
function assertionsOf(place: Place, key: string): PlaceCapability[] {
  return place.capabilities.filter((capability) => capability.key === key);
}

function tierOf(place: Place, key: string, verification: string): PlaceCapability | undefined {
  return assertionsOf(place, key).find((capability) => capability.verification === verification);
}

/** Rows as the DATABASE holds them — the check that no response merely hid something. */
async function storedTiers(placeId: string, key: string): Promise<string[]> {
  const rows = await suite!.client<{ verification: string }[]>`
    SELECT verification FROM places_capabilities
    WHERE place_id = ${placeId} AND namespace || '.' || capability = ${key}
    ORDER BY verification
  `;
  return rows.map((row) => row.verification);
}

/** An open, unclaimed place — the community-editable case. */
let open: Place;
/** Claimed, approved, by `user-owner`. */
let claimed: Place;
/** Claimed by `user-hopeful`, still PENDING — the claim that grants nothing. */
let pending: Place;
/** Carries an `oxy_verified` row nothing in this API can have written. */
let verified: Place;

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

  open = await createPlace(suite.db, { name: 'Bar Obert', location: CATALUNYA }, CONTRIBUTOR);
  claimed = await createPlace(suite.db, { name: 'Forn Reclamat', location: GRACIA }, CONTRIBUTOR);
  pending = await createPlace(suite.db, { name: 'Colmado Pendent', location: GRACIA }, CONTRIBUTOR);
  verified = await createPlace(suite.db, { name: 'Botiga Verificada', location: GRACIA }, CONTRIBUTOR);

  await createClaim(suite.db, {
    placeId: claimed.id,
    oxyAccountId: 'user-owner',
    role: 'owner',
    state: 'approved',
  });
  await createClaim(suite.db, {
    placeId: pending.id,
    oxyAccountId: 'user-hopeful',
    role: 'owner',
    // Left pending deliberately: this is the state an API caller can reach on
    // their own, and it must buy them nothing.
    state: 'pending',
  });

  // The one `oxy_verified` row in this database, written by SQL because no API
  // path can produce one. Everything below that touches it is an attempt to
  // reach it through the API, and every one of them must fail.
  await suite.client`
    INSERT INTO places_capabilities (id, place_id, namespace, capability, value, verification)
    VALUES ('cap-oxy-verified', ${verified.id}, 'payments.faircoin', 'accepted', 'true'::jsonb, 'oxy_verified')
  `;
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('PUT /places/:id/capabilities/:key', () => {
  it('refuses an unauthenticated assertion', async () => {
    const { status, body } = await call<ErrorBody>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...json({ value: true }),
    });
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it('records a signed-in stranger as a community report', async () => {
    const { status, body } = await call<Place>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: true })),
    });
    expect(status).toBe(200);

    const asserted = tierOf(body, FAIRCOIN, 'community_reported');
    expect(asserted?.value).toBe(true);
    expect(asserted?.namespace).toBe('payments.faircoin');
    expect(asserted?.capability).toBe('accepted');
    // The invariant the SDK's parser refuses a response over.
    expect(asserted?.key).toBe(`${asserted?.namespace}.${asserted?.capability}`);
    // Freshness is part of the contract: a claim with no date is not a fact.
    expect(Number.isNaN(Date.parse(asserted?.observedAt ?? ''))).toBe(false);
  });

  it('IGNORES a verification the caller sends in the body', async () => {
    // The escalation the criterion names, made the obvious way. The field is
    // not in the schema, so it is stripped rather than refused — and the row
    // that lands is the tier the caller earned.
    const { status, body } = await call<Place>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser(
        'user-liar',
        json({ value: true, verification: 'oxy_verified', observedAt: '2099-01-01T00:00:00.000Z' }),
      ),
    });
    expect(status).toBe(200);
    expect(assertionsOf(body, FAIRCOIN).map((capability) => capability.verification)).toEqual([
      'community_reported',
    ]);
    expect(await storedTiers(open.id, FAIRCOIN)).toEqual(['community_reported']);
    // And the date it tried to set is not the date it got.
    expect(tierOf(body, FAIRCOIN, 'community_reported')?.observedAt.startsWith('2099')).toBe(false);
  });

  it('gives a PENDING claimant nothing more than a passer-by', async () => {
    // An approved claim is what buys `business_asserted`. A claim a caller
    // created for themselves is pending, so this is the second half of the
    // self-approval escalation: even holding the row changes no tier.
    const { status, body } = await call<Place>(`/places/${pending.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-hopeful', json({ value: true })),
    });
    expect(status).toBe(200);
    expect(assertionsOf(body, FAIRCOIN).map((capability) => capability.verification)).toEqual([
      'community_reported',
    ]);
  });

  it('gives an APPROVED claimant the business tier, and no higher', async () => {
    const { status, body } = await call<Place>(`/places/${claimed.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-owner', json({ value: true })),
    });
    expect(status).toBe(200);
    expect(tierOf(body, FAIRCOIN, 'business_asserted')?.value).toBe(true);
    expect(tierOf(body, FAIRCOIN, 'oxy_verified')).toBeUndefined();
  });

  it('keeps a stale community report distinguishable from a current business one', async () => {
    // Both rows coexist — the tier is part of the uniqueness key — and this is
    // what "evidence must survive to the consumer" means in practice: the API
    // publishes the old date beside the new one, and the client decides how
    // loudly to present each. The backdating is what makes the assertion mean
    // something: without it the two dates are milliseconds apart.
    await call<Place>(`/places/${claimed.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: true })),
    });
    await suite!.client`
      UPDATE places_capabilities SET observed_at = ${TWO_YEARS_AGO.toISOString()}::timestamptz
      WHERE place_id = ${claimed.id} AND verification = 'community_reported'
    `;

    const { body } = await call<Place>(`/places/${claimed.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-owner', json({ value: true })),
    });

    const community = tierOf(body, FAIRCOIN, 'community_reported');
    const business = tierOf(body, FAIRCOIN, 'business_asserted');
    // A fresh business assertion does not refresh the stale community report.
    // If it did, a two-year-old rumour would inherit today's date the moment
    // the owner confirmed something unrelated about the same capability.
    expect(community?.observedAt).toBe(TWO_YEARS_AGO.toISOString());
    expect(Date.parse(business?.observedAt ?? '')).toBeGreaterThan(TWO_YEARS_AGO.getTime());
    // Strongest first, so a consumer taking the first row per key gets the
    // answer it can act on without knowing the ranking.
    expect(assertionsOf(body, FAIRCOIN).map((capability) => capability.verification)).toEqual([
      'business_asserted',
      'community_reported',
    ]);
  });

  it('refreshes the caller own tier in place rather than adding a row', async () => {
    const first = await call<Place>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: true })),
    });
    const observedFirst = tierOf(first.body, FAIRCOIN, 'community_reported')?.observedAt;

    const second = await call<Place>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      // The retraction path for a community reporter: not a deletion — an
      // absent row means "nobody has said", which a wallet cannot tell from
      // "somebody checked and it stopped being true".
      ...asUser('user-passerby', json({ value: false })),
    });

    expect(assertionsOf(second.body, FAIRCOIN)).toHaveLength(1);
    expect(tierOf(second.body, FAIRCOIN, 'community_reported')?.value).toBe(false);
    expect(Date.parse(tierOf(second.body, FAIRCOIN, 'community_reported')?.observedAt ?? '')).
      toBeGreaterThanOrEqual(Date.parse(observedFirst ?? ''));
  });

  it('moves updatedAt for a capability-only write', async () => {
    // A client caching on `updatedAt` must not miss a merchant that started
    // accepting FairCoin because the `places` row itself was untouched.
    const before = await call<Place>(`/places/${open.id}`);
    const after = await call<Place>(`/places/${open.id}/capabilities/commerce.mercaria.store`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: 'store-42' })),
    });
    expect(Date.parse(after.body.updatedAt)).toBeGreaterThan(Date.parse(before.body.updatedAt));
  });

  it('generalizes to any namespace, with any contract value type', async () => {
    // The criterion that the design is not FairCoin-shaped. Same URL, different
    // segment, different value type — no endpoint, schema or column per product.
    const homiio = await call<Place>(`/places/${open.id}/capabilities/housing.homiio.listings`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: 12 })),
    });
    expect(tierOf(homiio.body, 'housing.homiio.listings', 'community_reported')?.value).toBe(12);

    const moovo = await call<Place>(`/places/${open.id}/capabilities/mobility.moovo.pickup`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: true })),
    });
    expect(tierOf(moovo.body, 'mobility.moovo.pickup', 'community_reported')?.value).toBe(true);

    // And the generic READ filter picks the place up with no change of its own.
    const { body } = await call<Place[]>(
      `/places/nearby?latitude=${CATALUNYA.latitude}&longitude=${CATALUNYA.longitude}` +
        '&radiusMeters=500&capabilities=housing.homiio.listings,mobility.moovo.pickup',
    );
    expect(body.map((place) => place.id)).toEqual([open.id]);
  });

  it('records a sourced assertion as external_source, with the source published', async () => {
    const { body } = await call<Place>(`/places/${open.id}/capabilities/commerce.mercaria.store`, {
      method: 'PUT',
      ...asUser(
        'user-passerby',
        json({ value: 'store-7', source: { source: 'openstreetmap', sourceId: 'node/4242' } }),
      ),
    });
    const external = tierOf(body, 'commerce.mercaria.store', 'external_source');
    // The tier rests on a row in `places_sources` a reviewer can check, not on
    // who asked — and the ref comes back with the capability rather than having
    // to be looked up separately.
    expect(external?.source?.sourceId).toBe('node/4242');
    expect(body.sources.some((source) => source.sourceId === 'node/4242')).toBe(true);
  });

  it('refuses a source another place already holds', async () => {
    const { status, body } = await call<ErrorBody>(
      `/places/${claimed.id}/capabilities/commerce.mercaria.store`,
      {
        method: 'PUT',
        ...asUser(
          'user-owner',
          json({ value: 'store-7', source: { source: 'openstreetmap', sourceId: 'node/4242' } }),
        ),
      },
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.details?.placeId).toBe(open.id);
  });

  it('refuses a key that is not <namespace>.<capability>', async () => {
    // A bare `faircoin` would match nothing on the read side, so it is far more
    // likely a typo than an intent.
    const bare = await call<ErrorBody>(`/places/${open.id}/capabilities/faircoin`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: true })),
    });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('bad_request');

    // Refused at the edge rather than landing as a second, differently-cased
    // row beside the real one.
    const cased = await call<ErrorBody>(`/places/${open.id}/capabilities/Payments.FairCoin.Accepted`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: true })),
    });
    expect(cased.status).toBe(400);
  });

  it('refuses a body with no value, and a value of no contract type', async () => {
    // `value` is required rather than defaulted to `true`: a defaulted flag
    // reads well for `payments.faircoin.accepted` and silently means the wrong
    // thing for `payments.faircoin.rate`.
    //
    // Both are `validation_failed` rather than `bad_request`, because `value`
    // is a UNION of the three types the contract allows — zod reports a missing
    // member and a wrong member the same way, as a refused value. That matches
    // the `capabilities[]` field of the place write schema, which has the same
    // union; the two endpoints answer the same mistake the same way.
    const missing = await call<ErrorBody>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-passerby', json({})),
    });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('validation_failed');

    const nested = await call<ErrorBody>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: { accepted: true } })),
    });
    expect(nested.status).toBe(422);

    // A body that is not an object at all IS malformed, and is answered as
    // such: a bug in the caller's serialisation rather than in what they asked.
    const malformed = await call<ErrorBody>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-passerby', json(null)),
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('bad_request');
  });

  it('answers an unknown place with not_found', async () => {
    const { status, body } = await call<ErrorBody>(`/places/does-not-exist/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-passerby', json({ value: true })),
    });
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});

describe('DELETE /places/:id/capabilities/:key', () => {
  it('refuses a community reporter, and points at the honest retraction', async () => {
    const { status, body } = await call<ErrorBody>(`/places/${open.id}/capabilities/${FAIRCOIN}`, {
      method: 'DELETE',
      ...asUser('user-passerby', {}),
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
    // The row a stranger tried to remove is still there.
    expect(await storedTiers(open.id, FAIRCOIN)).toEqual(['community_reported']);
  });

  it('withdraws ONLY the claimant own tier', async () => {
    expect(await storedTiers(claimed.id, FAIRCOIN)).toEqual([
      'business_asserted',
      'community_reported',
    ]);

    const { status, body } = await call<Place>(`/places/${claimed.id}/capabilities/${FAIRCOIN}`, {
      method: 'DELETE',
      ...asUser('user-owner', {}),
    });
    expect(status).toBe(200);
    // The community report survives the owner's withdrawal: it is somebody
    // else's statement, at a tier the owner was never entitled to write.
    expect(assertionsOf(body, FAIRCOIN).map((capability) => capability.verification)).toEqual([
      'community_reported',
    ]);
    expect(await storedTiers(claimed.id, FAIRCOIN)).toEqual(['community_reported']);
  });

  it('cannot reach an oxy_verified row, by any caller', async () => {
    // Neither a stranger nor a claimant. There is no tier parameter on the
    // request to aim at it — the DELETE is scoped to a tier whose TYPE cannot
    // hold `oxy_verified`, so the row is unreachable rather than defended.
    const stranger = await call<ErrorBody>(`/places/${verified.id}/capabilities/${FAIRCOIN}`, {
      method: 'DELETE',
      ...asUser('user-passerby', {}),
    });
    expect(stranger.status).toBe(403);

    await createClaim(suite!.db, {
      placeId: verified.id,
      oxyAccountId: 'user-verified-owner',
      role: 'owner',
      state: 'approved',
    });
    const owner = await call<ErrorBody>(`/places/${verified.id}/capabilities/${FAIRCOIN}`, {
      method: 'DELETE',
      ...asUser('user-verified-owner', {}),
    });
    // 404: the owner has no `business_asserted` row of their own to withdraw.
    // The Oxy-verified one is not theirs and is not offered as an alternative.
    expect(owner.status).toBe(404);
    expect(await storedTiers(verified.id, FAIRCOIN)).toEqual(['oxy_verified']);
  });

  it('answers a tier the claimant never asserted with not_found, not 200', async () => {
    const { status, body } = await call<ErrorBody>(
      `/places/${claimed.id}/capabilities/mobility.moovo.pickup`,
      { method: 'DELETE', ...asUser('user-owner', {}) },
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});

describe('the oxy_verified tier, across everything this suite did', () => {
  it('was never produced by an API call', async () => {
    // The whole-database check, after every escalation attempt above. The only
    // `oxy_verified` row in this database is the one SQL inserted in setup: no
    // sequence of requests in this file created a second.
    const rows = await suite!.client<{ id: string }[]>`
      SELECT id FROM places_capabilities WHERE verification = 'oxy_verified'
    `;
    expect(rows.map((row) => row.id)).toEqual(['cap-oxy-verified']);
  });

  it('is published with its evidence intact to an ordinary reader', async () => {
    // The consumer half: a wallet reading this place sees the strong tier and
    // the date it was established, which is what lets it say "verified" rather
    // than "reported" without inventing the distinction itself.
    const { body } = await call<Place>(`/places/${verified.id}`);
    const capability = tierOf(body, FAIRCOIN, 'oxy_verified');
    expect(capability?.value).toBe(true);
    expect(Number.isNaN(Date.parse(capability?.observedAt ?? ''))).toBe(false);
  });
});

describe('claims as the escalation route', () => {
  it('cannot be created approved, so it cannot raise the caller own tier', async () => {
    // The full attack, end to end: claim the place, name yourself approved,
    // then assert. `state` is not in the schema and `requestClaim` takes no
    // state parameter, so the claim lands pending and the assertion stays a
    // community report.
    const target = await createPlace(
      suite!.db,
      { name: 'Bar Autoaprovat', location: CATALUNYA },
      CONTRIBUTOR,
    );

    const claim = await call<PlaceClaim>(`/places/${target.id}/claims`, {
      method: 'POST',
      ...asUser('user-attacker', json({ role: 'owner', state: 'approved' })),
    });
    expect(claim.status).toBe(201);
    expect(claim.body.state).toBe('pending');

    const asserted = await call<Place>(`/places/${target.id}/capabilities/${FAIRCOIN}`, {
      method: 'PUT',
      ...asUser('user-attacker', json({ value: true })),
    });
    expect(assertionsOf(asserted.body, FAIRCOIN).map((c) => c.verification)).toEqual([
      'community_reported',
    ]);

    const rows = await suite!.client<{ state: string }[]>`
      SELECT state FROM places_claims WHERE place_id = ${target.id}
    `;
    expect(rows.map((row) => row.state)).toEqual(['pending']);
  });
});
