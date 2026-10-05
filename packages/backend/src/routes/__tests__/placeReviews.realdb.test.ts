/**
 * Place reviews, end to end: the real review, places and moderation routers,
 * the real role resolver asking a fake Oxy at the HTTP boundary, and a real
 * PostGIS.
 *
 *  - one review per person, written, rewritten, withdrawn and revived;
 *  - the self-review ban: the claimant account, a switched session, and ANY
 *    member of a claimant organization — and a 503 when Oxy cannot say;
 *  - the rating, recomputed from the published reviews by every write and
 *    equal to a fresh computation over the rows;
 *  - the three orders and their cursors;
 *  - the business's reply, its withdrawal, and moderation's hide, restore and
 *    reply removal;
 *  - every write's revision in its own transaction, never public, never
 *    holding a word.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type {
  ModerationPlaceRevisionPage,
  Place,
  PlaceReport,
  PlaceReview,
  PlaceReviewPage,
  PlaceReviewWithStatus,
  PlaceRevisionPage,
} from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { createRequireOperator } from '../../middleware/operator';
import { createAccountRoleResolver } from '../../oxy/accountRoles';
import { membershipKey, startFakeOxy, type FakeOxy } from '../../__tests__/fakeOxy';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createModerationRouter } from '../moderation';
import { createPlaceReviewsRouter } from '../placeReviews';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('person-contributor'), assertedVerification: 'community_reported' };
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const OPERATOR = session('person-mod');

let suite: SuiteDatabase | null = null;
let oxy: FakeOxy;
let api: TestApi;

/** Claimed, approved, by the organization `org-cafe`. */
let cafe: Place;
/** Claimed, approved, by the personal account `person-solo`. */
let solo: Place;
/** Nobody's. */
let open: Place;

async function put(placeId: string, who: Record<string, string>, body: unknown) {
  return api.call<PlaceReviewWithStatus & ErrorBody>('PUT', `/places/${placeId}/reviews/mine`, who, body);
}

async function reviewsOf(placeId: string, query = ''): Promise<PlaceReview[]> {
  const { status, body } = await api.call<PlaceReviewPage>('GET', `/places/${placeId}/reviews${query}`);
  expect(status).toBe(200);
  return body.items;
}

async function ratingOf(placeId: string): Promise<Place['rating']> {
  return (await api.call<Place>('GET', `/places/${placeId}`)).body.rating;
}

/** The aggregate row, and the same figures computed afresh from the published reviews. */
async function aggregateAndTruth(placeId: string) {
  const [stored] = await suite!.client<{ review_count: number; rating_average: string | null; rating1: number; rating5: number }[]>`
    SELECT review_count, rating_average, rating1, rating5 FROM place_review_aggregates WHERE place_id = ${placeId}
  `;
  const [truth] = await suite!.client<{ count: number; average: string | null; ones: number; fives: number }[]>`
    SELECT count(*)::int AS count, avg(rating)::numeric(4,3) AS average,
           (count(*) FILTER (WHERE rating = 1))::int AS ones, (count(*) FILTER (WHERE rating = 5))::int AS fives
    FROM place_reviews WHERE place_id = ${placeId} AND status = 'published'
  `;
  return {
    stored: { count: stored!.review_count, average: stored!.rating_average, ones: stored!.rating1, fives: stored!.rating5 },
    truth: { count: truth!.count, average: truth!.average, ones: truth!.ones, fives: truth!.fives },
  };
}

async function reviewCount(placeId: string): Promise<number> {
  const [row] = await suite!.client<{ count: string }[]>`SELECT count(*) FROM place_reviews WHERE place_id = ${placeId}`;
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
  oxy = await startFakeOxy();
  for (const account of ['org-cafe', 'person-solo']) oxy.accounts.add(account);
  oxy.memberships.set(membershipKey('person-owner', 'org-cafe'), 'owner');
  oxy.memberships.set(membershipKey('person-viewer', 'org-cafe'), 'viewer');
  // Invited, not active: no role yet, so no conflict either.
  oxy.memberships.set(membershipKey('person-invited', 'org-cafe'), { role: 'editor', status: 'invited' });

  const accountRoles = createAccountRoleResolver({ oxyApiUrl: oxy.url, ttlMs: 0 });
  api = await serve(
    createPlacesRouter({ optionalAuth: fakeOptionalAuth, requireAuth: fakeRequireAuth, accountRoles, reportRateLimit: NO_RATE_LIMIT }),
    createPlaceReviewsRouter({
      requireAuth: fakeRequireAuth,
      accountRoles,
      reportRateLimit: NO_RATE_LIMIT,
      contributionRateLimit: NO_RATE_LIMIT,
    }),
    createModerationRouter({ requireAuth: fakeRequireAuth, requireOperator: createRequireOperator(['person-mod']) }),
  );

  cafe = await createPlace(suite.db, { name: 'Cafè de la Plaça', location: GRACIA }, CONTRIBUTOR);
  solo = await createPlace(suite.db, { name: 'Taller Solo', location: GRACIA }, CONTRIBUTOR);
  open = await createPlace(suite.db, { name: 'Forn del Barri', location: GRACIA }, CONTRIBUTOR);
  await createClaim(suite.db, { placeId: cafe.id, oxyAccountId: 'org-cafe', role: 'owner', state: 'approved' });
  await createClaim(suite.db, { placeId: solo.id, oxyAccountId: 'person-solo', role: 'owner', state: 'approved' });
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await oxy.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

beforeEach(() => {
  oxy.mode = 'ok';
  oxy.requests.length = 0;
});

describe("a person's review", () => {
  it('is readable signed out, and written only signed in', async () => {
    expect(await reviewsOf(open.id)).toEqual([]);
    expect((await put(open.id, {}, { rating: 5 })).status).toBe(401);
  });

  it('is written once, and the place gains a rating', async () => {
    const { status, body } = await put(open.id, session('person-ana'), { rating: 4, title: 'Bon pa', body: 'Croissants de primera.', locale: 'CA' });
    expect(status).toBe(201);
    expect(body).toMatchObject({ rating: 4, title: 'Bon pa', locale: 'ca', status: 'published', authorOxyUserId: 'person-ana' });
    expect(body.editedAt).toBeUndefined();
    expect(await ratingOf(open.id)).toEqual({ average: 4, count: 1 });
    // An unclaimed place asks Oxy nothing.
    expect(oxy.requests).toHaveLength(0);
  });

  it('is rewritten whole by a second write, which says when', async () => {
    const { status, body } = await put(open.id, session('person-ana'), { rating: 2 });
    expect(status).toBe(200);
    expect(body.rating).toBe(2);
    expect(body.title).toBeUndefined();
    expect(body.editedAt).toBeDefined();
    expect((await reviewsOf(open.id)).length).toBe(1);
    expect(await ratingOf(open.id)).toEqual({ average: 2, count: 1 });
  });

  it('is read back by its author', async () => {
    const { status, body } = await api.call<PlaceReviewWithStatus>('GET', `/places/${open.id}/reviews/mine`, session('person-ana'));
    expect(status).toBe(200);
    expect(body.status).toBe('published');
    expect((await api.call('GET', `/places/${open.id}/reviews/mine`, session('person-bob'))).status).toBe(404);
  });

  it('is withdrawn with its words erased, and can be written afresh', async () => {
    expect((await api.call('DELETE', `/places/${open.id}/reviews/mine`, session('person-ana'))).status).toBe(204);
    expect(await reviewsOf(open.id)).toEqual([]);
    expect(await ratingOf(open.id)).toBeUndefined();
    const [row] = await suite!.client<{ status: string; title: string | null; body: string | null }[]>`
      SELECT status, title, body FROM place_reviews WHERE place_id = ${open.id} AND author_oxy_user_id = 'person-ana'
    `;
    expect(row).toEqual({ status: 'removed', title: null, body: null });
    expect((await api.call('DELETE', `/places/${open.id}/reviews/mine`, session('person-ana'))).status).toBe(404);

    const revived = await put(open.id, session('person-ana'), { rating: 5, body: 'Han millorat molt.' });
    expect(revived.status).toBe(201);
    expect(await reviewCount(open.id)).toBe(1);
  });

  it('is refused to a session switched into an organization', async () => {
    const { status, body } = await put(open.id, session('org-cafe', 'person-owner'), { rating: 5 });
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });
});

describe('a business may not review itself', () => {
  it('refuses the personal account that holds the claim, without asking Oxy', async () => {
    expect((await put(solo.id, session('person-solo'), { rating: 5 })).status).toBe(403);
    expect(oxy.requests).toHaveLength(0);
  });

  it("refuses the organization's owner, and even its viewer", async () => {
    for (const person of ['person-owner', 'person-viewer']) {
      const { status, body } = await put(cafe.id, session(person), { rating: 5 });
      expect(`${person}: ${String(status)} ${body.error?.code ?? ''}`).toBe(`${person}: 403 forbidden`);
    }
    // Each was asked about with their own bearer, about the claiming account.
    expect(oxy.requests.map((request) => request.accountId)).toEqual(['org-cafe', 'org-cafe']);
  });

  it('lets a customer, and a member only invited, review the claimed place', async () => {
    expect((await put(cafe.id, session('person-stranger'), { rating: 3 })).status).toBe(201);
    expect((await put(cafe.id, session('person-invited'), { rating: 4 })).status).toBe(201);
  });

  it('fails closed with 503 when Oxy cannot say, and writes nothing', async () => {
    oxy.mode = 'down';
    const before = await reviewCount(cafe.id);
    const { status, body } = await put(cafe.id, session('person-newcomer'), { rating: 5 });
    expect(status).toBe(503);
    expect(body.error.code).toBe('service_unavailable');
    expect(await reviewCount(cafe.id)).toBe(before);
  });
});

describe('the rating is derived, never incremented', () => {
  let target: Place;

  beforeAll(async () => {
    target = await createPlace(suite!.db, { name: 'Bar del Mig', location: GRACIA }, CONTRIBUTOR);
    for (const [person, rating] of [['person-r1', 5], ['person-r2', 4], ['person-r3', 1]] as const) {
      expect((await put(target.id, session(person), { rating })).status).toBe(201);
    }
  });

  it('averages the published reviews to one decimal', async () => {
    expect(await ratingOf(target.id)).toEqual({ average: 3.3, count: 3 });
    const { stored, truth } = await aggregateAndTruth(target.id);
    expect(stored).toEqual(truth);
  });

  it('follows a rewrite, a hide, a restore and a withdrawal, matching the rows every time', async () => {
    await put(target.id, session('person-r3'), { rating: 3 });
    expect(await ratingOf(target.id)).toEqual({ average: 4, count: 3 });

    const [lowest] = await reviewsOf(target.id, '?sort=lowest');
    expect((await api.call('PATCH', `/moderation/places/${target.id}/reviews/${lowest!.id}`, OPERATOR, { status: 'hidden' })).status).toBe(200);
    expect(await ratingOf(target.id)).toEqual({ average: 4.5, count: 2 });
    expect((await aggregateAndTruth(target.id)).stored).toEqual((await aggregateAndTruth(target.id)).truth);

    expect((await api.call('PATCH', `/moderation/places/${target.id}/reviews/${lowest!.id}`, OPERATOR, { status: 'published' })).status).toBe(200);
    expect(await ratingOf(target.id)).toEqual({ average: 4, count: 3 });

    await api.call('DELETE', `/places/${target.id}/reviews/mine`, session('person-r1'));
    expect(await ratingOf(target.id)).toEqual({ average: 3.5, count: 2 });
    const { stored, truth } = await aggregateAndTruth(target.id);
    expect(stored).toEqual(truth);
  });

  it('keeps an author\'s edit from undoing an operator\'s hide', async () => {
    const [review] = (await reviewsOf(target.id)).filter((entry) => entry.authorOxyUserId === 'person-r2');
    await api.call('PATCH', `/moderation/places/${target.id}/reviews/${review!.id}`, OPERATOR, { status: 'hidden' });
    const rewritten = await put(target.id, session('person-r2'), { rating: 5 });
    expect(rewritten.status).toBe(200);
    expect(rewritten.body.status).toBe('hidden');
    expect((await reviewsOf(target.id)).some((entry) => entry.id === review!.id)).toBe(false);
    expect((await aggregateAndTruth(target.id)).stored).toEqual((await aggregateAndTruth(target.id)).truth);
  });
});

describe('the three orders', () => {
  let ordered: Place;

  beforeAll(async () => {
    ordered = await createPlace(suite!.db, { name: 'Llibreria Oberta', location: GRACIA }, CONTRIBUTOR);
    for (const [person, rating] of [['person-o1', 3], ['person-o2', 5], ['person-o3', 1], ['person-o4', 5]] as const) {
      await put(ordered.id, session(person), { rating });
    }
  });

  it('pages newest first, and highest and lowest with the newest first within a rating', async () => {
    const newest = await reviewsOf(ordered.id);
    expect(newest.map((review) => review.authorOxyUserId)).toEqual(['person-o4', 'person-o3', 'person-o2', 'person-o1']);
    expect((await reviewsOf(ordered.id, '?sort=highest')).map((review) => review.authorOxyUserId)).toEqual([
      'person-o4',
      'person-o2',
      'person-o1',
      'person-o3',
    ]);
    expect((await reviewsOf(ordered.id, '?sort=lowest')).map((review) => review.authorOxyUserId)).toEqual([
      'person-o3',
      'person-o1',
      'person-o4',
      'person-o2',
    ]);
  });

  it('walks every order a page at a time, and refuses a cursor from another order', async () => {
    for (const sort of ['newest', 'highest', 'lowest'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: PlaceReviewPage } = await api.call<PlaceReviewPage>(
          'GET',
          `/places/${ordered.id}/reviews?sort=${sort}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...page.body.items.map((review) => review.authorOxyUserId));
        cursor = page.body.nextCursor;
      } while (cursor !== null);
      expect(seen).toEqual((await reviewsOf(ordered.id, `?sort=${sort}`)).map((review) => review.authorOxyUserId));
    }
    const { body } = await api.call<PlaceReviewPage>('GET', `/places/${ordered.id}/reviews?sort=highest&limit=1`);
    expect((await api.call('GET', `/places/${ordered.id}/reviews?sort=newest&cursor=${body.nextCursor!}`)).status).toBe(400);
  });
});

describe("the business's reply", () => {
  let review: PlaceReview;

  beforeAll(async () => {
    [review] = (await reviewsOf(cafe.id)).filter((entry) => entry.authorOxyUserId === 'person-stranger');
  });

  it('is written by whoever acts for the claim, and never names them', async () => {
    expect((await api.call('PUT', `/places/${cafe.id}/reviews/${review.id}/reply`, session('person-viewer'), { body: 'Gràcies!' })).status).toBe(403);
    const { status, body } = await api.call<PlaceReview>('PUT', `/places/${cafe.id}/reviews/${review.id}/reply`, session('person-owner'), {
      body: 'Gràcies per venir!',
    });
    expect(status).toBe(200);
    expect(body.reply).toEqual({ body: 'Gràcies per venir!', repliedAt: expect.any(String) });
    const listed = (await reviewsOf(cafe.id)).find((entry) => entry.id === review.id)!;
    expect(listed.reply?.body).toBe('Gràcies per venir!');
    expect(JSON.stringify(listed)).not.toContain('person-owner');
    expect(JSON.stringify(listed)).not.toContain('org-cafe');
  });

  it('says when it was rewritten, and is withdrawn by the business', async () => {
    const { body } = await api.call<PlaceReview>('PUT', `/places/${cafe.id}/reviews/${review.id}/reply`, session('org-cafe', 'person-owner'), {
      body: 'Gràcies, us esperem aviat.',
    });
    expect(body.reply?.editedAt).toBeDefined();
    expect((await api.call('DELETE', `/places/${cafe.id}/reviews/${review.id}/reply`, session('person-owner'))).status).toBe(204);
    expect((await reviewsOf(cafe.id)).find((entry) => entry.id === review.id)?.reply).toBeUndefined();
    expect((await api.call('DELETE', `/places/${cafe.id}/reviews/${review.id}/reply`, session('person-owner'))).status).toBe(404);
  });

  it('is removed by an operator', async () => {
    await api.call('PUT', `/places/${cafe.id}/reviews/${review.id}/reply`, session('person-owner'), { body: 'Resposta.' });
    expect((await api.call('DELETE', `/moderation/places/${cafe.id}/reviews/${review.id}/reply`, OPERATOR)).status).toBe(204);
    expect((await reviewsOf(cafe.id)).find((entry) => entry.id === review.id)?.reply).toBeUndefined();
  });
});

describe('history', () => {
  it('keeps every review write out of the public history, and every word out of all of it', async () => {
    const publicHistory = await api.call<PlaceRevisionPage>('GET', `/places/${open.id}/revisions?limit=100`);
    expect(publicHistory.body.items.map((revision) => revision.action)).toEqual(['place_created']);

    const full = await api.call<ModerationPlaceRevisionPage>('GET', `/moderation/places/${open.id}/revisions?limit=100`, OPERATOR);
    const actions = full.body.items.map((revision) => revision.action).reverse();
    expect(actions).toEqual(['place_created', 'review_published', 'review_updated', 'review_withdrawn', 'review_published']);
    const text = JSON.stringify(full.body);
    for (const words of ['Bon pa', 'Croissants', 'Han millorat']) expect(text).not.toContain(words);
    expect(full.body.items.every((revision) => revision.operatedByOxyUserId === 'person-ana' || revision.action === 'place_created')).toBe(true);
  });

  it('records no review, and leaves the rating alone, when its revision cannot be recorded', async () => {
    const before = await reviewCount(open.id);
    const rating = await ratingOf(open.id);
    await refusingRevisions('review_published', async () => {
      expect((await put(open.id, session('person-atomic'), { rating: 1 })).status).toBe(500);
    });
    expect(await reviewCount(open.id)).toBe(before);
    expect(await ratingOf(open.id)).toEqual(rating);
  });
});

describe('reports', () => {
  it('files a report about one published review', async () => {
    const [review] = await reviewsOf(open.id);
    const filed = await api.call<PlaceReport>('POST', `/places/${open.id}/reviews/${review!.id}/reports`, session('person-bob'), {
      reason: 'conflict_of_interest',
      note: 'Sembla del propietari.',
    });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ reviewId: review!.id, reason: 'conflict_of_interest' });
    expect((await api.call('POST', `/places/${open.id}/reviews/no-such/reports`, session('person-bob'), { reason: 'spam' })).status).toBe(404);
  });
});
