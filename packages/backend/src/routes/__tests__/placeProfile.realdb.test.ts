/**
 * A place's profile — its descriptions — and what a merge does with a place's
 * descriptions, gallery and reviews.
 *
 *  - the default description and GoWay's per-language ones, written, resolved
 *    for a locale, withdrawn, recorded, and kept off list reads;
 *  - a merge moves the gallery (the survivor's copy of a file wins), moves
 *    every review, keeps one person's NEWER review published and hides the
 *    older, recomputes both ratings, moves descriptions the survivor lacks, and
 *    lists the gallery — never the reviews — in the public `place_absorbed`.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type {
  DuplicateCandidatePage,
  Place,
  PlacePage,
  PlaceReview,
  PlaceReviewPage,
  PlaceRevisionPage,
} from '@goway/contracts';
import { addPlaceMedia } from '../../db/places/mediaRepository';
import { createPlace, recordDuplicateCandidate, type PlaceActor } from '../../db/places/placesRepository';
import { putReview } from '../../db/places/reviewsRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { createRequireOperator } from '../../middleware/operator';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_FILES, NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createModerationRouter } from '../moderation';
import { createPlaceMediaRouter } from '../placeMedia';
import { createPlaceReviewsRouter } from '../placeReviews';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('person-contributor'), assertedVerification: 'community_reported' };
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const OPERATOR = session('person-mod');

let suite: SuiteDatabase | null = null;
let api: TestApi;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(
    createPlacesRouter({
      optionalAuth: fakeOptionalAuth,
      requireAuth: fakeRequireAuth,
      accountRoles: NO_MEMBERSHIPS,
      reportRateLimit: NO_RATE_LIMIT,
    }),
    createPlaceMediaRouter({
      optionalAuth: fakeOptionalAuth,
      requireAuth: fakeRequireAuth,
      accountRoles: NO_MEMBERSHIPS,
      placeFiles: NO_FILES,
      reportRateLimit: NO_RATE_LIMIT,
      contributionRateLimit: NO_RATE_LIMIT,
    }),
    createPlaceReviewsRouter({
      requireAuth: fakeRequireAuth,
      accountRoles: NO_MEMBERSHIPS,
      reportRateLimit: NO_RATE_LIMIT,
      contributionRateLimit: NO_RATE_LIMIT,
    }),
    createModerationRouter({ requireAuth: fakeRequireAuth, requireOperator: createRequireOperator(['person-mod']) }),
  );
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('descriptions', () => {
  let place: Place;

  beforeAll(async () => {
    place = await createPlace(
      suite!.db,
      { name: 'Museu del Barri', location: GRACIA, description: 'Un museu petit i ple de records.' },
      CONTRIBUTOR,
    );
  });

  it('publishes the default description on the place itself', async () => {
    const { body } = await api.call<Place>('GET', `/places/${place.id}`);
    expect(body.description).toBe('Un museu petit i ple de records.');
    expect(body.descriptions).toEqual([]);
  });

  it('writes translations as GoWay rows and resolves one for a locale', async () => {
    const { status } = await api.call<Place>('PATCH', `/places/${place.id}`, session('person-ana'), {
      descriptions: [
        { language: 'ES', description: 'Un museo pequeño y lleno de recuerdos.' },
        { language: 'en', description: 'A small museum full of memories.' },
      ],
    });
    expect(status).toBe(200);

    const { body } = await api.call<Place>('GET', `/places/${place.id}?locale=es-MX`);
    expect(body.descriptions?.map((entry) => `${entry.language}:${entry.source}`)).toEqual(['en:goway', 'es:goway']);
    expect(body.localizedDescription).toEqual({
      language: 'es',
      description: 'Un museo pequeño y lleno de recuerdos.',
      source: 'goway',
    });
    // The default never moves with the locale.
    expect(body.description).toBe('Un museu petit i ple de records.');
  });

  it('records each change, and withdraws a language with null', async () => {
    await api.call<Place>('PATCH', `/places/${place.id}`, session('person-ana'), {
      description: null,
      descriptions: [{ language: 'en', description: null }],
    });
    const { body } = await api.call<PlaceRevisionPage>('GET', `/places/${place.id}/revisions`);
    const [latest] = body.items;
    expect(latest?.changes).toContainEqual({ field: 'description', before: 'Un museu petit i ple de records.' });
    expect(latest?.changes).toContainEqual({
      field: 'descriptions.en',
      before: { description: 'A small museum full of memories.', source: 'goway' },
    });
    const { body: read } = await api.call<Place>('GET', `/places/${place.id}`);
    expect(read.description).toBeUndefined();
    expect(read.descriptions?.map((entry) => entry.language)).toEqual(['es']);
  });

  it('keeps descriptions off list reads', async () => {
    const { body } = await api.call<PlacePage>('GET', '/places/bounds?west=2.15&south=41.39&east=2.17&north=41.40&locale=es');
    const listed = body.items.find((entry) => entry.id === place.id);
    expect(listed).toBeDefined();
    expect(listed?.descriptions).toBeUndefined();
    expect(listed?.localizedDescription).toBeUndefined();
  });

  it('refuses a description past the limit', async () => {
    const { status, body } = await api.call<ErrorBody>('PATCH', `/places/${place.id}`, session('person-ana'), {
      description: 'x'.repeat(2001),
    });
    expect(status).toBe(422);
    expect(body.error.details?.field).toBe('description');
  });
});

describe('a merge moves descriptions, the gallery and reviews', () => {
  let survivor: Place;
  let absorbed: Place;
  let survivorLogoMediaId: string;

  /** A review written at a known moment, so "the newer one" is decided by data, not by timing. */
  async function review(placeId: string, author: string, rating: number, at: string): Promise<void> {
    const written = await putReview(suite!.db, placeId, author, { rating }, apiAuthor(author));
    await suite!.client`UPDATE place_reviews SET created_at = ${at}::timestamptz WHERE id = ${written!.review.id}`;
  }

  async function galleryOf(placeId: string) {
    return suite!.client<{ id: string; oxy_file_id: string; oxy_link_place_id: string; position: number }[]>`
      SELECT id, oxy_file_id, oxy_link_place_id, position FROM place_media
      WHERE place_id = ${placeId} AND state <> 'removed' ORDER BY position, id
    `;
  }

  beforeAll(async () => {
    survivor = await createPlace(suite!.db, { name: 'Can Pere', location: GRACIA, description: 'La casa de sempre.' }, CONTRIBUTOR);
    absorbed = await createPlace(
      suite!.db,
      { name: 'Ca n’Pere', location: GRACIA, descriptions: [{ language: 'es', description: 'La casa de siempre.' }] },
      CONTRIBUTOR,
    );
    const actor = (person: string): PlaceActor => ({ author: apiAuthor(person), assertedVerification: 'community_reported' });
    const logo = await addPlaceMedia(suite!.db, survivor.id, { fileId: 'file-shared', kind: 'logo' }, actor('person-s'));
    survivorLogoMediaId = logo!.id;
    await addPlaceMedia(suite!.db, absorbed.id, { fileId: 'file-shared', kind: 'logo' }, actor('person-a'));
    await addPlaceMedia(suite!.db, absorbed.id, { fileId: 'file-only-absorbed', kind: 'photo' }, actor('person-a'));

    // person-both reviewed each place; the absorbed one is NEWER and wins.
    await review(survivor.id, 'person-both', 2, '2026-01-01T10:00:00Z');
    await review(absorbed.id, 'person-both', 5, '2026-03-01T10:00:00Z');
    // person-older-there wrote the OLDER review on the absorbed place: it is the one set aside.
    await review(survivor.id, 'person-older-there', 4, '2026-04-01T10:00:00Z');
    await review(absorbed.id, 'person-older-there', 1, '2026-02-01T10:00:00Z');
    await review(absorbed.id, 'person-only-absorbed', 3, '2026-02-15T10:00:00Z');

    await recordDuplicateCandidate(suite!.db, survivor.id, absorbed.id, 'manual_report');
    const { body } = await api.call<DuplicateCandidatePage>('GET', '/moderation/duplicates', OPERATOR);
    const candidate = body.items.find((entry) => [entry.placeId, entry.candidatePlaceId].includes(absorbed.id))!;
    const merged = await api.call('POST', `/moderation/duplicates/${candidate.id}/resolution`, OPERATOR, {
      decision: 'merge',
      survivorPlaceId: survivor.id,
    });
    expect(merged.status).toBe(200);
  });

  it("moves the gallery where the survivor lacks the file, after the survivor's own items", async () => {
    const gallery = await galleryOf(survivor.id);
    expect(gallery.map((item) => item.oxy_file_id)).toEqual(['file-shared', 'file-only-absorbed']);
    expect(gallery[0]?.id).toBe(survivorLogoMediaId);
    // The Oxy link still names the place it was made for.
    expect(gallery[1]?.oxy_link_place_id).toBe(absorbed.id);
    // The absorbed copy of the shared file stayed behind rather than being destroyed.
    expect((await galleryOf(absorbed.id)).map((item) => item.oxy_file_id)).toEqual(['file-shared']);
  });

  it('moves every review, keeps the newer of one person\'s two published, and hides the older', async () => {
    const { body } = await api.call<PlaceReviewPage>('GET', `/places/${survivor.id}/reviews`);
    const byAuthor = new Map(body.items.map((entry: PlaceReview) => [entry.authorOxyUserId, entry.rating]));
    expect(Object.fromEntries(byAuthor)).toEqual({ 'person-both': 5, 'person-older-there': 4, 'person-only-absorbed': 3 });

    const hidden = await suite!.client<{ author_oxy_user_id: string; rating: number; place_id: string }[]>`
      SELECT author_oxy_user_id, rating, place_id FROM place_reviews WHERE status = 'hidden' ORDER BY author_oxy_user_id
    `;
    expect([...hidden]).toEqual([
      { author_oxy_user_id: 'person-both', rating: 2, place_id: survivor.id },
      { author_oxy_user_id: 'person-older-there', rating: 1, place_id: survivor.id },
    ]);
  });

  it('recomputes both ratings', async () => {
    const { body } = await api.call<Place>('GET', `/places/${survivor.id}`);
    expect(body.rating).toEqual({ average: 4, count: 3 });
    const [left] = await suite!.client<{ review_count: number }[]>`
      SELECT review_count FROM place_review_aggregates WHERE place_id = ${absorbed.id}
    `;
    expect(left?.review_count).toBe(0);
  });

  it("moves descriptions the survivor lacks, and never rewrites the survivor's own", async () => {
    const { body } = await api.call<Place>('GET', `/places/${survivor.id}`);
    expect(body.description).toBe('La casa de sempre.');
    expect(body.descriptions).toEqual([{ language: 'es', description: 'La casa de siempre.', source: 'goway' }]);
  });

  it('lists the moved gallery in the public place_absorbed revision, and no review', async () => {
    const { body } = await api.call<PlaceRevisionPage>('GET', `/places/${survivor.id}/revisions`);
    const absorbedRevision = body.items.find((revision) => revision.action === 'place_absorbed')!;
    const fields = absorbedRevision.changes.map((change) => change.field);
    expect(fields.filter((field) => field.startsWith('media.'))).toHaveLength(1);
    expect(fields).toContain('descriptions.es');
    expect(fields.some((field) => field.startsWith('reviews.'))).toBe(false);
    expect(JSON.stringify(absorbedRevision)).not.toContain('file-only-absorbed');
  });

  it("answers the absorbed place's gallery and reviews with 410 and where it went", async () => {
    for (const path of ['media', 'reviews']) {
      const { status, body } = await api.call<ErrorBody>('GET', `/places/${absorbed.id}/${path}`);
      expect(status).toBe(410);
      expect(body.error.details).toEqual({ mergedInto: survivor.id });
    }
  });
});
