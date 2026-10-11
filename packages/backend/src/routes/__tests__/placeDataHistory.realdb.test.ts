/**
 * Place data under business moderation's rules: every hours-exception write
 * records a revision in its own transaction, the derived timezone is part of
 * the history, a merge moves hours exceptions the way it moves the other
 * children, and moderation's `oxy_verified` tier is held to the capability
 * registry like every other tier.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type {
  DuplicateCandidate,
  DuplicateCandidatePage,
  Place,
  PlaceHoursException,
  PlaceHoursExceptionPage,
  PlaceRevision,
  PlaceRevisionPage,
} from '@goway/contracts';
import {
  createClaim,
  createPlace,
  recordDuplicateCandidate,
  type PlaceActor,
} from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { createRequireOperator } from '../../middleware/operator';
import {
  fakeOptionalAuth,
  fakeRequireAuth,
  serve,
  session,
  type ErrorBody,
  type TestApi,
} from '../../__tests__/httpHarness';
import { apiAuthor, NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createModerationRouter } from '../moderation';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = {
  author: apiAuthor('person-contributor'),
  assertedVerification: 'community_reported',
};
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const LISBOA = { latitude: 38.7223, longitude: -9.1393 };
const OPERATOR = session('person-mod');

let suite: SuiteDatabase | null = null;
let api: TestApi;

async function history(placeId: string): Promise<PlaceRevision[]> {
  const { status, body } = await api.call<PlaceRevisionPage>(
    'GET',
    `/places/${placeId}/revisions?limit=100`,
  );
  expect(status).toBe(200);
  return body.items;
}

async function newest(placeId: string): Promise<PlaceRevision> {
  return (await history(placeId))[0]!;
}

async function storedRevisionCount(placeId: string): Promise<number> {
  const [row] = await suite!.client<
    { count: string }[]
  >`SELECT count(*) FROM place_revisions WHERE place_id = ${placeId}`;
  return Number(row!.count);
}

/** Make the database refuse to record one revision action, for the length of `run`. */
async function refusingRevisions(action: string, run: () => Promise<void>): Promise<void> {
  await suite!.client.unsafe(
    `ALTER TABLE place_revisions ADD CONSTRAINT test_refuse_action CHECK (action <> '${action}') NOT VALID`,
  );
  try {
    await run();
  } finally {
    await suite!.client`ALTER TABLE place_revisions DROP CONSTRAINT test_refuse_action`;
  }
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(
    createPlacesRouter({
      optionalAuth: fakeOptionalAuth,
      requireAuth: fakeRequireAuth,
      accountRoles: NO_MEMBERSHIPS,
      reportRateLimit: NO_RATE_LIMIT,
    }),
    createModerationRouter({
      requireAuth: fakeRequireAuth,
      requireOperator: createRequireOperator(['person-mod']),
    }),
  );
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('every hours-exception write records one public revision', () => {
  let place: Place;
  let exception: PlaceHoursException;

  beforeAll(async () => {
    place = await createPlace(suite!.db, { name: 'Forn Horari', location: GRACIA }, CONTRIBUTOR);
    await createClaim(suite!.db, {
      placeId: place.id,
      oxyAccountId: 'org-forn',
      role: 'owner',
      state: 'approved',
    });
  });

  it('records a creation with the exception at its tier', async () => {
    const created = await api.call<PlaceHoursException>(
      'POST',
      `/places/${place.id}/hours-exceptions`,
      session('org-forn', 'person-owner'),
      { startsOn: '2030-12-25', closed: true, note: 'Nadal' },
    );
    expect(created.status).toBe(201);
    exception = created.body;

    const revision = await newest(place.id);
    expect(revision.action).toBe('hours_exception_created');
    expect(revision.source).toBe('api');
    expect(revision.changes).toEqual([
      {
        field: `hoursExceptions.${exception.id}`,
        after: {
          startsOn: '2030-12-25',
          endsOn: '2030-12-25',
          closed: true,
          intervals: [],
          note: 'Nadal',
          verification: 'business_asserted',
          observedAt: exception.observedAt,
        },
      },
    ]);
  });

  it('records a rewrite with what it replaced', async () => {
    const rewritten = await api.call<PlaceHoursException>(
      'PUT',
      `/places/${place.id}/hours-exceptions/${exception.id}`,
      session('org-forn', 'person-owner'),
      { startsOn: '2030-12-25', closed: false, intervals: [{ opens: '09:00', closes: '13:00' }] },
    );
    expect(rewritten.status).toBe(200);

    const revision = await newest(place.id);
    expect(revision.action).toBe('hours_exception_replaced');
    const [change] = revision.changes;
    expect(change?.field).toBe(`hoursExceptions.${exception.id}`);
    expect(change?.before).toMatchObject({
      closed: true,
      note: 'Nadal',
      verification: 'business_asserted',
    });
    expect(change?.after).toMatchObject({
      closed: false,
      intervals: [{ opens: '09:00', closes: '13:00' }],
      verification: 'business_asserted',
    });
    expect(change?.after).not.toHaveProperty('note');
  });

  it('records a withdrawal with what was withdrawn', async () => {
    const withdrawn = await api.call(
      'DELETE',
      `/places/${place.id}/hours-exceptions/${exception.id}`,
      session('org-forn'),
    );
    expect(withdrawn.status).toBe(204);

    const revision = await newest(place.id);
    expect(revision.action).toBe('hours_exception_withdrawn');
    expect(revision.changes).toEqual([
      {
        field: `hoursExceptions.${exception.id}`,
        before: expect.objectContaining({ closed: false, verification: 'business_asserted' }),
      },
    ]);
  });

  it('publishes those revisions without naming the account or the person', async () => {
    const actions = (await history(place.id)).map((revision) => revision.action);
    expect(actions.slice(0, 3)).toEqual([
      'hours_exception_withdrawn',
      'hours_exception_replaced',
      'hours_exception_created',
    ]);
    const raw = JSON.stringify(await history(place.id));
    expect(raw).not.toContain('org-forn');
    expect(raw).not.toContain('person-owner');

    const [stored] = await suite!.client<
      { oxy_account_id: string; operated_by_oxy_user_id: string | null }[]
    >`
      SELECT oxy_account_id, operated_by_oxy_user_id FROM place_revisions
      WHERE place_id = ${place.id} AND action = 'hours_exception_created'
    `;
    expect(stored).toEqual({ oxy_account_id: 'org-forn', operated_by_oxy_user_id: 'person-owner' });
  });

  it('records nothing for a refused write', async () => {
    const before = await storedRevisionCount(place.id);
    const community = await api.call<PlaceHoursException>(
      'POST',
      `/places/${place.id}/hours-exceptions`,
      session('person-x'),
      {
        startsOn: '2030-01-01',
        closed: true,
      },
    );
    expect(community.status).toBe(201);
    expect(await storedRevisionCount(place.id)).toBe(before + 1);

    // A stranger may not withdraw, and the business may not rewrite the community's report.
    const refusedWithdraw = await api.call<ErrorBody>(
      'DELETE',
      `/places/${place.id}/hours-exceptions/${community.body.id}`,
      session('person-x'),
    );
    expect(refusedWithdraw.status).toBe(403);
    const refusedRewrite = await api.call<ErrorBody>(
      'PUT',
      `/places/${place.id}/hours-exceptions/${community.body.id}`,
      session('org-forn'),
      { startsOn: '2030-01-01', closed: false, intervals: [{ opens: '10:00', closes: '14:00' }] },
    );
    expect(refusedRewrite.status).toBe(403);
    expect(await storedRevisionCount(place.id)).toBe(before + 1);
  });
});

describe('the hours-exception revision is in the write transaction', () => {
  it('rolls a creation back when its revision cannot be recorded', async () => {
    const place = await createPlace(
      suite!.db,
      { name: 'Horari Atòmic', location: GRACIA },
      CONTRIBUTOR,
    );
    await refusingRevisions('hours_exception_created', async () => {
      const { status } = await api.call<ErrorBody>(
        'POST',
        `/places/${place.id}/hours-exceptions`,
        session('person-ana'),
        {
          startsOn: '2030-05-01',
          closed: true,
        },
      );
      expect(status).toBe(500);
    });
    const rows = await suite!
      .client`SELECT 1 FROM place_hours_exceptions WHERE place_id = ${place.id}`;
    expect(rows).toHaveLength(0);
  });

  it('rolls a rewrite and a withdrawal back when their revisions cannot be recorded', async () => {
    const place = await createPlace(
      suite!.db,
      { name: 'Horari Atòmic Dos', location: GRACIA },
      CONTRIBUTOR,
    );
    await createClaim(suite!.db, {
      placeId: place.id,
      oxyAccountId: 'org-atomic',
      role: 'owner',
      state: 'approved',
    });
    const { body: exception } = await api.call<PlaceHoursException>(
      'POST',
      `/places/${place.id}/hours-exceptions`,
      session('org-atomic'),
      { startsOn: '2030-05-01', closed: true },
    );

    await refusingRevisions('hours_exception_replaced', async () => {
      const { status } = await api.call<ErrorBody>(
        'PUT',
        `/places/${place.id}/hours-exceptions/${exception.id}`,
        session('org-atomic'),
        { startsOn: '2030-05-01', closed: false, intervals: [{ opens: '09:00', closes: '12:00' }] },
      );
      expect(status).toBe(500);
    });
    await refusingRevisions('hours_exception_withdrawn', async () => {
      const { status } = await api.call<ErrorBody>(
        'DELETE',
        `/places/${place.id}/hours-exceptions/${exception.id}`,
        session('org-atomic'),
      );
      expect(status).toBe(500);
    });

    const rows = await suite!.client<
      { closed: boolean }[]
    >`SELECT closed FROM place_hours_exceptions WHERE id = ${exception.id}`;
    expect(rows.map((row) => row.closed)).toEqual([true]);
  });
});

describe('the derived timezone is history too', () => {
  it('records the timezone a creation derived and the one a move derived', async () => {
    const created = await api.call<Place>('POST', '/places', session('person-ana'), {
      name: 'Cafè Viatger',
      location: GRACIA,
    });
    expect(created.status).toBe(201);
    const creation = await newest(created.body.id);
    expect(creation.changes).toContainEqual({ field: 'timezone', after: 'Europe/Madrid' });

    await api.call<Place>('PATCH', `/places/${created.body.id}`, session('person-ana'), {
      location: LISBOA,
    });
    const move = await newest(created.body.id);
    expect(move.action).toBe('place_updated');
    expect(move.changes).toContainEqual({
      field: 'timezone',
      before: 'Europe/Madrid',
      after: 'Europe/Lisbon',
    });
  });
});

describe('a merge and the place data', () => {
  async function candidateBetween(a: Place, b: Place): Promise<DuplicateCandidate> {
    await recordDuplicateCandidate(suite!.db, a.id, b.id, 'manual_report');
    const { body } = await api.call<DuplicateCandidatePage>(
      'GET',
      '/moderation/duplicates?limit=100',
      OPERATOR,
    );
    const pair = [a.id, b.id].sort();
    const found = body.items.find(
      (item) => item.placeId === pair[0] && item.candidatePlaceId === pair[1],
    );
    if (!found) throw new Error('the candidate was not listed');
    return found;
  }

  it("moves the absorbed place's hours exceptions where the survivor holds none, and keeps the survivor's columns", async () => {
    const survivor = await createPlace(
      suite!.db,
      { name: 'Bar Fusió', location: GRACIA, categories: ['food.bar'] },
      CONTRIBUTOR,
    );
    const absorbed = await createPlace(
      suite!.db,
      { name: 'Bar Fusió', location: GRACIA, categories: ['food.cafe'] },
      CONTRIBUTOR,
    );
    const report = (placeId: string, startsOn: string, note: string) =>
      api.call<PlaceHoursException>(
        'POST',
        `/places/${placeId}/hours-exceptions`,
        session('person-x'),
        {
          startsOn,
          closed: true,
          note,
        },
      );
    // Same dates, same tier on both: the survivor's own wins.
    await report(survivor.id, '2030-08-15', 'survivor');
    const losing = (await report(absorbed.id, '2030-08-15', 'absorbed')).body;
    // Dates the survivor has nothing for: these move.
    const moving = (await report(absorbed.id, '2030-09-11', 'absorbed only')).body;

    const candidate = await candidateBetween(survivor, absorbed);
    const merged = await api.call<DuplicateCandidate>(
      'POST',
      `/moderation/duplicates/${candidate.id}/resolution`,
      OPERATOR,
      {
        decision: 'merge',
        survivorPlaceId: survivor.id,
      },
    );
    expect(merged.status).toBe(200);

    const { body: list } = await api.call<PlaceHoursExceptionPage>(
      'GET',
      `/places/${survivor.id}/hours-exceptions`,
    );
    expect(list.items.map((item) => [item.startsOn, item.note])).toEqual([
      ['2030-08-15', 'survivor'],
      ['2030-09-11', 'absorbed only'],
    ]);
    expect(list.items[1]?.id).toBe(moving.id);
    // The losing exception was not destroyed: it stays with the absorbed place.
    const kept = await suite!.client<
      { id: string }[]
    >`SELECT id FROM place_hours_exceptions WHERE place_id = ${absorbed.id}`;
    expect(kept.map((row) => row.id)).toEqual([losing.id]);

    // The survivor's own columns are its statement, untouched by the merge.
    const { body: read } = await api.call<Place>('GET', `/places/${survivor.id}`);
    expect(read.categories).toEqual(['food.bar']);
    expect(read.timezone).toBe('Europe/Madrid');

    const received = await newest(survivor.id);
    expect(received.action).toBe('place_absorbed');
    expect(received.changes).toContainEqual({
      field: `hoursExceptions.${moving.id}`,
      after: expect.objectContaining({
        startsOn: '2030-09-11',
        verification: 'community_reported',
      }),
    });
    expect(received.changes.map((change) => change.field)).not.toContain(
      `hoursExceptions.${losing.id}`,
    );

    // The absorbed id's hours answer with where it went, for a read and a write.
    const gone = await api.call<ErrorBody>('GET', `/places/${absorbed.id}/hours-exceptions`);
    expect(gone.status).toBe(410);
    expect(gone.body.error.details).toEqual({ mergedInto: survivor.id });
    const write = await api.call<ErrorBody>(
      'POST',
      `/places/${absorbed.id}/hours-exceptions`,
      session('person-x'),
      {
        startsOn: '2030-10-01',
        closed: true,
      },
    );
    expect(write.status).toBe(410);
    expect(write.body.error.details).toEqual({ mergedInto: survivor.id });
  });
});

describe('Oxy verification is held to the capability registry', () => {
  let shop: Place;

  beforeAll(async () => {
    shop = await createPlace(
      suite!.db,
      { name: 'Botiga Registrada', location: GRACIA },
      CONTRIBUTOR,
    );
  });

  it('refuses a key the registry does not have', async () => {
    const { status, body } = await api.call<ErrorBody>(
      'PUT',
      `/moderation/places/${shop.id}/capabilities/payments.faircoin.rate`,
      OPERATOR,
      {
        value: 1.02,
      },
    );
    expect(status).toBe(400);
    expect(body.error.details?.field).toBe('key');
  });

  it("refuses a value outside the key's own type, and writes nothing", async () => {
    const asText = await api.call<ErrorBody>(
      'PUT',
      `/moderation/places/${shop.id}/capabilities/amenities.wifi`,
      OPERATOR,
      {
        value: 'yes',
      },
    );
    expect(asText.status).toBe(422);
    expect(asText.body.error.details?.field).toBe('value');

    const outOfSet = await api.call<ErrorBody>(
      'PUT',
      `/moderation/places/${shop.id}/capabilities/accessibility.wheelchair`,
      OPERATOR,
      { value: 'sometimes' },
    );
    expect(outOfSet.status).toBe(422);

    const rows = await suite!.client`SELECT 1 FROM places_capabilities WHERE place_id = ${shop.id}`;
    expect(rows).toHaveLength(0);
  });

  it('stores a verified value normalized by its key', async () => {
    const verified = await api.call<Place>(
      'PUT',
      `/moderation/places/${shop.id}/capabilities/food.cuisine`,
      OPERATOR,
      {
        value: ['pizza', 'italian', 'pizza'],
      },
    );
    expect(verified.status).toBe(200);
    const cuisine = verified.body.capabilities.find(
      (capability) => capability.key === 'food.cuisine',
    );
    expect(cuisine).toMatchObject({ value: ['italian', 'pizza'], verification: 'oxy_verified' });

    const revision = await newest(shop.id);
    expect(revision.action).toBe('capability_asserted');
    expect(revision.changes[0]?.after).toMatchObject({
      value: ['italian', 'pizza'],
      verification: 'oxy_verified',
    });
  });
});
