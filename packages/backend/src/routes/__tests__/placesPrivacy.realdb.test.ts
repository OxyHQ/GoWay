/**
 * Asking "what is near me" must leave no trace of where "me" was.
 *
 * Issue #8 makes this an acceptance criterion — "querying nearby merchants does
 * not automatically create precise user location history" — and #4 makes it a
 * schema rule: public place data and user location data are separate domains,
 * and `places.created_by_oxy_user_id` is authorship of a contribution rather
 * than a position.
 *
 * ## Why this suite counts TABLES rather than inspecting the ones it knows
 *
 * A test that asserted "no row was added to `places`" would pass unchanged on
 * the day somebody adds a `place_views`, a `search_log` or a `nearby_requests`
 * table — which is exactly the change that would break the promise, and exactly
 * the change nobody would think to come back and test. So the check is made
 * against every table in the database, discovered at runtime: a future table
 * that a nearby query writes to fails this suite by existing, and the failure
 * names it.
 *
 * The queries below are made both signed out and signed IN. A signed-out
 * browse leaving no trace is the easy half; the interesting case is the FairCoin
 * wallet user with a session, because that is the request where a "helpful"
 * write would have somebody to attribute it to.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Place, PlaceWithDistance } from '@goway/shared-types';
import { createPlace, type PlaceActor } from '../../db/places/placesRepository';
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

/** Where the shop is. */
const SHOP = { latitude: 41.387, longitude: 2.17 };

/**
 * Where the USER is — deliberately distinctive, so a stray persisted copy is
 * findable by value rather than only by row count.
 */
const USER_POSITION = { latitude: 41.3874219, longitude: 2.1699731 };

let suite: SuiteDatabase | null = null;
let server: Server;
let origin: string;
let shop: Place;

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

async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}/api/v1${path}`, init);
  return { status: response.status, body: (await response.json()) as T };
}

function asUser(user: string): RequestInit {
  return { headers: { 'x-test-user': user } };
}

/**
 * Every table in the database, with its row count.
 *
 * Discovered from the catalogue rather than listed, so a table added later is
 * covered without anybody remembering to add it here. `spatial_ref_sys` is
 * PostGIS's own reference-system catalogue — thousands of static rows that no
 * GoWay code writes — and counting it every time would cost more than the rest
 * of the suite.
 */
async function tableCounts(): Promise<Record<string, number>> {
  const tables = await suite!.client<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'
    ORDER BY tablename
  `;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    const [row] = await suite!.client.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM "${tablename}"`,
    );
    counts[tablename] = row?.count ?? -1;
  }
  return counts;
}

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

  shop = await createPlace(
    suite.db,
    {
      name: 'Botiga FairCoin',
      location: SHOP,
      capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
    },
    CONTRIBUTOR,
  );
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('discovering merchants near a user', () => {
  it('writes nothing, anywhere, signed out or signed in', async () => {
    const before = await tableCounts();
    // The suite would pass vacuously if the catalogue query returned nothing.
    expect(Object.keys(before)).toContain('places');
    expect(Object.keys(before).length).toBeGreaterThan(4);

    const nearby = `latitude=${USER_POSITION.latitude}&longitude=${USER_POSITION.longitude}&radiusMeters=2000`;
    const filtered = `${nearby}&capabilities=payments.faircoin.accepted`;

    const anonymous = await call<PlaceWithDistance[]>(`/places/nearby?${nearby}`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.map((place) => place.id)).toContain(shop.id);

    // The FairCoin wallet's own request: a capability-filtered radius search
    // made by somebody GoWay could attribute a position to if it kept one.
    const identified = await call<PlaceWithDistance[]>(
      `/places/nearby?${filtered}`,
      asUser('user-wallet'),
    );
    expect(identified.status).toBe(200);
    expect(identified.body.map((place) => place.id)).toEqual([shop.id]);

    // The viewport read and the deep link, for the same reason: the map moving
    // is a stream of positions too.
    await call<Place[]>('/places/bounds?west=2.0&south=41.3&east=2.3&north=41.5', asUser('user-wallet'));
    await call<Place>(`/places/${shop.id}`, asUser('user-wallet'));

    // A REFUSED request as well. An early-return validation path is where an
    // "audit" write is most likely to be added and least likely to be noticed.
    await call('/places/nearby?latitude=120&longitude=2.17&radiusMeters=500', asUser('user-wallet'));

    expect(await tableCounts()).toEqual(before);
  });

  it('leaves the query coordinate nowhere in the places domain', async () => {
    // Row counts alone would miss a coordinate written INTO an existing row —
    // a "last searched near" column on a place, say. The position used above is
    // deliberately distinctive so it can be looked for by value.
    const [places] = await suite!.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM places
      WHERE latitude = ${USER_POSITION.latitude} OR longitude = ${USER_POSITION.longitude}
    `;
    expect(places?.count).toBe(0);

    // And nothing anywhere in the JSON columns that could carry one unnoticed.
    const [blobs] = await suite!.client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM places
      WHERE coalesce(geometry::text, '') LIKE ${`%${String(USER_POSITION.latitude)}%`}
         OR coalesce(opening_hours::text, '') LIKE ${`%${String(USER_POSITION.latitude)}%`}
    `;
    expect(blobs?.count).toBe(0);
  });

  it('never publishes who contributed a place', async () => {
    // `created_by_oxy_user_id` is authorship of a contribution — where somebody
    // said a shop is, never where that person was — and it is not published.
    // The distinction only holds while the column stays unpublished, because a
    // contributor id beside a coordinate reads exactly like a location trace.
    const { body } = await call<Record<string, unknown>>(`/places/${shop.id}`);
    expect(JSON.stringify(body)).not.toContain(CONTRIBUTOR.oxyUserId);
  });
});
