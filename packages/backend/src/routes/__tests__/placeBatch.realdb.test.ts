/**
 * `GET /places?ids=` — several places by id in one read — over a real socket
 * and a real PostGIS.
 *
 * What it promises is that it is the single read, batched: every id lands in
 * exactly one of `items`, `gone` and `missing`, in the order it was asked for,
 * and a place in `items` is exactly what `GET /places/{placeId}` answers for
 * it — names, descriptions, hours exceptions and the claim rule included.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MAX_PLACE_BATCH_SIZE, type Place, type PlaceBatch, type PlacePage } from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('person-contributor'), assertedVerification: 'community_reported' };
const SANT_ANTONI = { latitude: 41.3784, longitude: 2.1622 };
const BOX = 'west=2.16&south=41.37&east=2.17&north=41.39';

let suite: SuiteDatabase | null = null;
let api: TestApi;

/** Published, translated, described, with a closure coming up, claimed by `org-forn`. */
let forn: Place;
/** Published, plain. */
let kiosk: Place;
/** Removed by moderation. */
let removed: Place;
/** Merged into `forn`. */
let merged: Place;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(
    createPlacesRouter({ optionalAuth: fakeOptionalAuth, requireAuth: fakeRequireAuth, accountRoles: NO_MEMBERSHIPS, reportRateLimit: NO_RATE_LIMIT }),
  );

  forn = await createPlace(
    suite.db,
    {
      name: 'Forn de Sant Antoni',
      location: SANT_ANTONI,
      names: [{ language: 'es', name: 'Horno de San Antonio' }],
      description: 'Pa de pagès des de 1902.',
      descriptions: [{ language: 'en', description: 'Country bread since 1902.' }],
    },
    CONTRIBUTOR,
  );
  kiosk = await createPlace(suite.db, { name: 'Quiosc del Mercat', location: { latitude: 41.3787, longitude: 2.1625 } }, CONTRIBUTOR);
  removed = await createPlace(suite.db, { name: 'Botiga Retirada', location: SANT_ANTONI }, CONTRIBUTOR);
  merged = await createPlace(suite.db, { name: 'Forn Sant Antoni (duplicat)', location: SANT_ANTONI }, CONTRIBUTOR);
  await suite.client`UPDATE places SET status = 'removed' WHERE id = ${removed.id}`;
  await suite.client`UPDATE places SET status = 'merged', merged_into_place_id = ${forn.id} WHERE id = ${merged.id}`;
  await createClaim(suite.db, { placeId: forn.id, oxyAccountId: 'org-forn', role: 'owner', state: 'approved' });
  await api.call('POST', `/places/${forn.id}/hours-exceptions`, session('org-forn'), {
    startsOn: '2031-12-25',
    closed: true,
    note: 'Nadal',
  });
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

function batchPath(ids: readonly string[], extra = ''): string {
  return `/places?ids=${ids.map(encodeURIComponent).join(',')}${extra}`;
}

describe('GET /places?ids=', () => {
  it('puts every id in exactly one list, in the order it was asked for', async () => {
    const { status, body } = await api.call<PlaceBatch>(
      'GET',
      batchPath([kiosk.id, merged.id, 'no-such-place', forn.id, removed.id, kiosk.id]),
    );
    expect(status).toBe(200);
    // A repeated id collapses; the first mention decides the order.
    expect(body.items.map((place) => place.id)).toEqual([kiosk.id, forn.id]);
    expect(body.gone).toEqual([{ id: merged.id, mergedInto: forn.id }, { id: removed.id }]);
    expect(body.missing).toEqual(['no-such-place']);
  });

  it('answers each place exactly as the single read does — names, descriptions and hours exceptions', async () => {
    const [batch, single] = await Promise.all([
      api.call<PlaceBatch>('GET', batchPath([forn.id], '&locale=es')),
      api.call<Place>('GET', `/places/${forn.id}?locale=es`),
    ]);
    expect(batch.body.items).toEqual([single.body]);

    const [place] = batch.body.items;
    expect(place?.names?.map((name) => name.language)).toEqual(['es']);
    expect(place?.localizedName?.name).toBe('Horno de San Antonio');
    expect(place?.description).toBe('Pa de pagès des de 1902.');
    expect(place?.descriptions?.map((description) => description.language)).toEqual(['en']);
    expect(place?.hoursExceptions?.map((exception) => [exception.startsOn, exception.verification])).toEqual([
      ['2031-12-25', 'business_asserted'],
    ]);
    // Signed out: claims are nobody's business.
    expect(place?.claims).toBeUndefined();
  });

  it('publishes claims only on the places the session itself holds one on', async () => {
    const { body } = await api.call<PlaceBatch>('GET', batchPath([forn.id, kiosk.id]), session('org-forn'));
    const byId = new Map(body.items.map((place) => [place.id, place]));
    expect(byId.get(forn.id)?.claims?.map((claim) => [claim.oxyAccountId, claim.state])).toEqual([['org-forn', 'approved']]);
    expect(byId.get(kiosk.id)?.claims).toBeUndefined();
  });

  it('answers an empty `items` when nothing asked for is published', async () => {
    const { status, body } = await api.call<PlaceBatch>('GET', batchPath([removed.id, 'never-was']));
    expect(status).toBe(200);
    expect(body).toEqual({ items: [], gone: [{ id: removed.id }], missing: ['never-was'] });
  });

  it(`refuses no ids, more than ${String(MAX_PLACE_BATCH_SIZE)}, and the parameter twice`, async () => {
    const none = await api.call<ErrorBody>('GET', '/places?ids=');
    expect(none.status).toBe(422);
    expect(none.body.error.details?.field).toBe('ids');

    const tooMany = Array.from({ length: MAX_PLACE_BATCH_SIZE + 1 }, (_unused, index) => `place-${String(index)}`);
    const over = await api.call<ErrorBody>('GET', batchPath(tooMany));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('validation_failed');

    const repeated = await api.call<ErrorBody>('GET', `/places?ids=${forn.id}&ids=${kiosk.id}`);
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.code).toBe('bad_request');
  });
});

describe('the lists carry what open-now needs', () => {
  it('embeds the current hours exceptions on a viewport read, and [] where there are none', async () => {
    const { body } = await api.call<PlacePage>('GET', `/places/bounds?${BOX}`);
    const byId = new Map(body.items.map((place) => [place.id, place]));
    expect(byId.get(forn.id)?.hoursExceptions?.map((exception) => exception.startsOn)).toEqual(['2031-12-25']);
    expect(byId.get(kiosk.id)?.hoursExceptions).toEqual([]);
    // Still a list: no names set, no descriptions, no claims.
    expect(byId.get(forn.id)?.names).toBeUndefined();
    expect(byId.get(forn.id)?.descriptions).toBeUndefined();
    expect(byId.get(forn.id)?.claims).toBeUndefined();
  });
});
