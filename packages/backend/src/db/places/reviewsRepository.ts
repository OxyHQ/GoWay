/**
 * Place reviews and their derived rating: every database access the review
 * routes make.
 *
 * ## Every write recomputes the rating, in its own transaction
 *
 * {@link recomputeRating} reads the published reviews and SETS the place's
 * aggregate row. It is called at the end of every write that can change which
 * reviews are published — writing, rewriting, withdrawing, an operator's hide
 * or restore, a merge — inside that write's transaction, after the place row
 * was locked at its start. So two review writes to one place are serialized,
 * the second recomputes over the first's committed review, and the summary can
 * never drift from the rows it summarises. Nothing increments.
 *
 * ## Revisions never hold words
 *
 * Every write records one `moderation`-visibility revision whose change is the
 * review's `{ rating, status, locale?, replied }` — never its title, body or
 * reply (`revisions.reviewSnapshot`).
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type {
  ModeratedPlaceReviewStatus,
  PlaceReview,
  PlaceReviewStatus,
  PlaceReviewWithStatus,
  PlaceRevisionAction,
  ReviewSort,
} from '@goway/contracts';
import { MAX_REVIEW_RATING, MIN_REVIEW_RATING } from '@goway/contracts';
import type { SelectedRow } from '@oxy.so/db';
import { ApiError } from '../../http/apiError';
import type { Paged, TimeWindow } from '../../http/cursor';
import type { Database, DatabaseOrTransaction } from '../postgres';
import { placeReviewAggregates, placeReviews, places } from '../schema';
import {
  changeOf,
  recordRevision,
  reviewField,
  reviewSnapshot,
  type RevisionAuthor,
} from './revisions';

export const REVIEW_COLUMNS = {
  id: placeReviews.id,
  placeId: placeReviews.placeId,
  authorOxyUserId: placeReviews.authorOxyUserId,
  rating: placeReviews.rating,
  title: placeReviews.title,
  body: placeReviews.body,
  locale: placeReviews.locale,
  status: placeReviews.status,
  editedAt: placeReviews.editedAt,
  replyBody: placeReviews.replyBody,
  repliedAt: placeReviews.repliedAt,
  replyEditedAt: placeReviews.replyEditedAt,
  createdAt: placeReviews.createdAt,
  updatedAt: placeReviews.updatedAt,
} as const;

export type ReviewRow = SelectedRow<typeof REVIEW_COLUMNS>;

/** The public shape. The reply never names who wrote it. */
export function toPlaceReview(row: ReviewRow): PlaceReview {
  const review: PlaceReview = {
    id: row.id,
    placeId: row.placeId,
    rating: row.rating,
    authorOxyUserId: row.authorOxyUserId,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.title !== null) review.title = row.title;
  if (row.body !== null) review.body = row.body;
  if (row.locale !== null) review.locale = row.locale;
  if (row.editedAt !== null) review.editedAt = row.editedAt.toISOString();
  if (row.replyBody !== null && row.repliedAt !== null) {
    review.reply = { body: row.replyBody, repliedAt: row.repliedAt.toISOString() };
    if (row.replyEditedAt !== null) review.reply.editedAt = row.replyEditedAt.toISOString();
  }
  return review;
}

export function toReviewWithStatus(row: ReviewRow): PlaceReviewWithStatus {
  // CHECK-constrained to the contract's tuple.
  return { ...toPlaceReview(row), status: row.status as PlaceReviewStatus };
}

/**
 * Lock a place for a review write and move its `updated_at` — its `rating` is
 * part of the place a client caches. `false` when no place has the id.
 */
async function lockPlace(tx: DatabaseOrTransaction, placeId: string): Promise<boolean> {
  const [row] = await tx
    .update(places)
    .set({ updatedAt: new Date() })
    .where(eq(places.id, placeId))
    .returning({ id: places.id });
  return row !== undefined;
}

/**
 * Derive a place's rating from its PUBLISHED reviews and store it.
 *
 * Idempotent and order-free: it reads the rows and sets the answer, so a hidden
 * review leaves the average by construction and calling it twice changes
 * nothing. Call it inside the write's transaction, with the place locked.
 */
export async function recomputeRating(tx: DatabaseOrTransaction, placeId: string): Promise<void> {
  const counts = [MIN_REVIEW_RATING, 2, 3, 4, MAX_REVIEW_RATING].map(
    (rating) => sql<number>`(count(*) filter (where ${placeReviews.rating} = ${rating}))::int`,
  );
  const [derived] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      average: sql<string | null>`avg(${placeReviews.rating})::numeric(4,3)`,
      rating1: counts[0]!,
      rating2: counts[1]!,
      rating3: counts[2]!,
      rating4: counts[3]!,
      rating5: counts[4]!,
    })
    .from(placeReviews)
    .where(and(eq(placeReviews.placeId, placeId), eq(placeReviews.status, 'published')));
  const values = {
    reviewCount: derived?.count ?? 0,
    ratingAverage: derived?.average == null ? null : Number(derived.average),
    rating1: derived?.rating1 ?? 0,
    rating2: derived?.rating2 ?? 0,
    rating3: derived?.rating3 ?? 0,
    rating4: derived?.rating4 ?? 0,
    rating5: derived?.rating5 ?? 0,
    updatedAt: new Date(),
  };
  await tx
    .insert(placeReviewAggregates)
    .values({ placeId, ...values })
    .onConflictDoUpdate({ target: placeReviewAggregates.placeId, set: values });
}

/**
 * The review a person's writes address on a place: their published one, else
 * the newest they have in any other status. Locked when `lock` is set.
 */
async function findAuthorsReview(
  db: DatabaseOrTransaction,
  placeId: string,
  authorOxyUserId: string,
  lock = false,
): Promise<ReviewRow | undefined> {
  const query = db
    .select(REVIEW_COLUMNS)
    .from(placeReviews)
    .where(
      and(eq(placeReviews.placeId, placeId), eq(placeReviews.authorOxyUserId, authorOxyUserId)),
    )
    .orderBy(
      sql`(${placeReviews.status} = 'published') desc`,
      desc(placeReviews.updatedAt),
      desc(placeReviews.id),
    )
    .limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** The caller's own review of a place, in any status but `removed`, or `undefined`. */
export async function findOwnReview(
  db: DatabaseOrTransaction,
  placeId: string,
  authorOxyUserId: string,
): Promise<PlaceReviewWithStatus | undefined> {
  const row = await findAuthorsReview(db, placeId, authorOxyUserId);
  return row && row.status !== 'removed' ? toReviewWithStatus(row) : undefined;
}

/** A review as its author writes it, already parsed by the contract. */
export interface ReviewInput {
  rating: number;
  title?: string | undefined;
  body?: string | undefined;
  locale?: string | undefined;
}

/**
 * Write or rewrite a person's review of a place, and recompute the rating.
 *
 * - none yet: a new `published` review (`review_published`);
 * - a `removed` one: revived as a new `published` review with a fresh
 *   `createdAt` — the words it had are gone (`review_published`);
 * - a `published` or `hidden` one: rewritten whole, keeping its status — an
 *   operator's hide is not undone by an edit (`review_updated`).
 *
 * `created` says whether the result is a new review. `null` when no place has
 * the id. The author is the person the ROUTE established; nothing here can
 * write a review under anybody else's name.
 */
export async function putReview(
  db: Database,
  placeId: string,
  authorOxyUserId: string,
  input: ReviewInput,
  author: RevisionAuthor,
): Promise<{ review: PlaceReviewWithStatus; created: boolean } | null> {
  return db.transaction(async (tx) => {
    if (!(await lockPlace(tx, placeId))) return null;
    const existing = await findAuthorsReview(tx, placeId, authorOxyUserId, true);
    const now = new Date();
    const words = {
      rating: input.rating,
      title: input.title ?? null,
      body: input.body ?? null,
      locale: input.locale ?? null,
    };

    let row: ReviewRow | undefined;
    let action: PlaceRevisionAction;
    if (existing === undefined) {
      [row] = await tx
        .insert(placeReviews)
        .values({ placeId, authorOxyUserId, ...words, status: 'published' })
        .returning(REVIEW_COLUMNS);
      action = 'review_published';
    } else if (existing.status === 'removed') {
      [row] = await tx
        .update(placeReviews)
        .set({ ...words, status: 'published', editedAt: null, createdAt: now, updatedAt: now })
        .where(eq(placeReviews.id, existing.id))
        .returning(REVIEW_COLUMNS);
      action = 'review_published';
    } else {
      [row] = await tx
        .update(placeReviews)
        .set({ ...words, editedAt: now, updatedAt: now })
        .where(eq(placeReviews.id, existing.id))
        .returning(REVIEW_COLUMNS);
      action = 'review_updated';
    }
    if (!row) throw new ApiError('internal_error', 'The review could not be recorded.');

    const change = changeOf(
      reviewField(row.id),
      existing ? reviewSnapshot(existing) : undefined,
      reviewSnapshot(row),
    );
    await recordRevision(tx, { placeId, action, author, changes: change ? [change] : [] });
    await recomputeRating(tx, placeId);
    return { review: toReviewWithStatus(row), created: action === 'review_published' };
  });
}

/**
 * Withdraw a person's review: `removed`, its title, body and reply erased, and
 * the rating recomputed. `false` when they have no review there to withdraw.
 */
export async function withdrawReview(
  db: Database,
  placeId: string,
  authorOxyUserId: string,
  author: RevisionAuthor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockPlace(tx, placeId))) return false;
    const existing = await findAuthorsReview(tx, placeId, authorOxyUserId, true);
    if (!existing || existing.status === 'removed') return false;
    const [row] = await tx
      .update(placeReviews)
      .set({
        status: 'removed',
        title: null,
        body: null,
        replyBody: null,
        replyOxyAccountId: null,
        replyOperatedByOxyUserId: null,
        repliedAt: null,
        replyEditedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(placeReviews.id, existing.id))
      .returning(REVIEW_COLUMNS);
    if (!row) return false;
    const change = changeOf(reviewField(row.id), reviewSnapshot(existing), reviewSnapshot(row));
    await recordRevision(tx, {
      placeId,
      action: 'review_withdrawn',
      author,
      changes: change ? [change] : [],
    });
    await recomputeRating(tx, placeId);
    return true;
  });
}

/** One published review of one place, or `undefined`. */
export async function findPublishedReview(
  db: DatabaseOrTransaction,
  placeId: string,
  reviewId: string,
): Promise<ReviewRow | undefined> {
  const [row] = await db
    .select(REVIEW_COLUMNS)
    .from(placeReviews)
    .where(
      and(
        eq(placeReviews.placeId, placeId),
        eq(placeReviews.id, reviewId),
        eq(placeReviews.status, 'published'),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Write or rewrite the business's reply to one PUBLISHED review. The account it
 * is written as and the person are recorded and never published. `null` when
 * the place or a published review of that id is gone.
 */
export async function replyToReview(
  db: Database,
  placeId: string,
  reviewId: string,
  body: string,
  author: RevisionAuthor,
): Promise<PlaceReview | null> {
  return db.transaction(async (tx) => {
    if (!(await lockPlace(tx, placeId))) return null;
    const [existing] = await tx
      .select(REVIEW_COLUMNS)
      .from(placeReviews)
      .where(
        and(
          eq(placeReviews.placeId, placeId),
          eq(placeReviews.id, reviewId),
          eq(placeReviews.status, 'published'),
        ),
      )
      .for('update');
    if (!existing) return null;
    const now = new Date();
    const [row] = await tx
      .update(placeReviews)
      .set({
        replyBody: body,
        replyOxyAccountId: author.oxyAccountId,
        replyOperatedByOxyUserId: author.operatedByOxyUserId,
        repliedAt: existing.repliedAt ?? now,
        replyEditedAt: existing.repliedAt === null ? null : now,
        updatedAt: now,
      })
      .where(eq(placeReviews.id, reviewId))
      .returning(REVIEW_COLUMNS);
    if (!row) return null;
    await recordRevision(tx, {
      placeId,
      action: 'review_replied',
      author,
      changes: [
        {
          field: `${reviewField(reviewId)}.reply`,
          ...(existing.repliedAt ? { before: 'replied' } : {}),
          after: 'replied',
        },
      ],
    });
    return toPlaceReview(row);
  });
}

/**
 * Withdraw the business's reply to a review, whatever the review's status.
 * `false` when there is no reply there to withdraw.
 */
export async function withdrawReply(
  db: Database,
  placeId: string,
  reviewId: string,
  author: RevisionAuthor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockPlace(tx, placeId))) return false;
    const [row] = await tx
      .update(placeReviews)
      .set({
        replyBody: null,
        replyOxyAccountId: null,
        replyOperatedByOxyUserId: null,
        repliedAt: null,
        replyEditedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(placeReviews.placeId, placeId),
          eq(placeReviews.id, reviewId),
          sql`${placeReviews.replyBody} is not null`,
        ),
      )
      .returning({ id: placeReviews.id });
    if (!row) return false;
    await recordRevision(tx, {
      placeId,
      action: 'review_reply_withdrawn',
      author,
      changes: [{ field: `${reviewField(reviewId)}.reply`, before: 'replied' }],
    });
    return true;
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

const REVIEW_PAGE_COLUMNS = {
  ...REVIEW_COLUMNS,
  createdAtText: sql<string>`${placeReviews.createdAt}::text`,
} as const;

/**
 * Where a review page resumes. `newest` resumes at `(createdAt, id)`; a rating
 * order at `(rating, createdAt, id)`. The timestamp is Postgres's own text, for
 * the reason `timeKeysetSchema` gives.
 */
export type ReviewKeyset =
  | readonly [createdAt: string, reviewId: string]
  | readonly [rating: number, createdAt: string, reviewId: string];

/** The keyset predicate and the order for one sort. Newest first within every rating. */
function reviewOrder(
  sort: ReviewSort,
  after: ReviewKeyset | undefined,
): { where: SQL | undefined; orderBy: SQL[] } {
  const newestFirst = [desc(placeReviews.createdAt), desc(placeReviews.id)];
  if (sort === 'newest') {
    return {
      where:
        after && after.length === 2
          ? sql`(${placeReviews.createdAt}, ${placeReviews.id}) < (${after[0]}::timestamptz, ${after[1]})`
          : undefined,
      orderBy: newestFirst,
    };
  }
  const ratingFirst = sort === 'highest' ? desc(placeReviews.rating) : asc(placeReviews.rating);
  let where: SQL | undefined;
  if (after && after.length === 3) {
    const [rating, createdAt, id] = after;
    const beyondRating =
      sort === 'highest'
        ? sql`${placeReviews.rating} < ${rating}`
        : sql`${placeReviews.rating} > ${rating}`;
    where = sql`(${beyondRating} or (${placeReviews.rating} = ${rating} and (${placeReviews.createdAt}, ${placeReviews.id}) < (${createdAt}::timestamptz, ${id})))`;
  }
  return { where, orderBy: [ratingFirst, ...newestFirst] };
}

/** One window of a place's PUBLISHED reviews, in the chosen order, each with the position a page ending on it resumes after. */
export async function listPlaceReviews(
  db: DatabaseOrTransaction,
  placeId: string,
  window: { sort: ReviewSort; limit: number; after?: ReviewKeyset | undefined },
): Promise<{ review: PlaceReview; position: ReviewKeyset }[]> {
  const { where, orderBy } = reviewOrder(window.sort, window.after);
  const rows = await db
    .select(REVIEW_PAGE_COLUMNS)
    .from(placeReviews)
    .where(and(eq(placeReviews.placeId, placeId), eq(placeReviews.status, 'published'), where))
    .orderBy(...orderBy)
    .limit(window.limit);
  return rows.map(({ createdAtText, ...row }) => ({
    review: toPlaceReview(row),
    position:
      window.sort === 'newest' ? [createdAtText, row.id] : [row.rating, createdAtText, row.id],
  }));
}

// ── Moderation ──────────────────────────────────────────────────────────────

/** One window of a place's reviews in one status (or every status), newest first. */
export async function listModerationReviews(
  db: DatabaseOrTransaction,
  placeId: string,
  status: PlaceReviewStatus | undefined,
  window: TimeWindow,
): Promise<Paged<PlaceReviewWithStatus>[]> {
  const rows = await db
    .select(REVIEW_PAGE_COLUMNS)
    .from(placeReviews)
    .where(
      and(
        eq(placeReviews.placeId, placeId),
        status ? eq(placeReviews.status, status) : undefined,
        window.after
          ? sql`(${placeReviews.createdAt}, ${placeReviews.id}) < (${window.after[0]}::timestamptz, ${window.after[1]})`
          : undefined,
      ),
    )
    .orderBy(desc(placeReviews.createdAt), desc(placeReviews.id))
    .limit(window.limit);
  return rows.map(({ createdAtText, ...row }) => ({
    item: toReviewWithStatus(row),
    position: [createdAtText, row.id],
  }));
}

const MODERATION_ACTION: Readonly<Record<ModeratedPlaceReviewStatus, PlaceRevisionAction>> = {
  hidden: 'review_hidden',
  published: 'review_restored',
};

/**
 * Hide a published review or restore a hidden one, and recompute the rating.
 *
 * A withdrawn review, one already in that status, or a restore that would give
 * its author a second published review on the place (a merge set the older one
 * aside) is a `conflict`. `null` when the place or the review is gone.
 */
export async function moderateReview(
  db: Database,
  placeId: string,
  reviewId: string,
  status: ModeratedPlaceReviewStatus,
  author: RevisionAuthor,
): Promise<PlaceReviewWithStatus | null> {
  return db.transaction(async (tx) => {
    if (!(await lockPlace(tx, placeId))) return null;
    const [before] = await tx
      .select(REVIEW_COLUMNS)
      .from(placeReviews)
      .where(and(eq(placeReviews.placeId, placeId), eq(placeReviews.id, reviewId)))
      .for('update');
    if (!before) return null;
    if (before.status === 'removed') {
      throw new ApiError('conflict', 'This review was withdrawn by its author.', {
        status: before.status,
      });
    }
    if (before.status === status)
      throw new ApiError('conflict', `This review is already ${status}.`, {
        status: before.status,
      });
    if (status === 'published') {
      const [other] = await tx
        .select({ id: placeReviews.id })
        .from(placeReviews)
        .where(
          and(
            eq(placeReviews.placeId, placeId),
            eq(placeReviews.authorOxyUserId, before.authorOxyUserId),
            eq(placeReviews.status, 'published'),
          ),
        )
        .limit(1);
      if (other) {
        throw new ApiError('conflict', 'Its author already has a published review of this place.', {
          reviewId: other.id,
        });
      }
    }

    const [after] = await tx
      .update(placeReviews)
      .set({ status, updatedAt: new Date() })
      .where(eq(placeReviews.id, reviewId))
      .returning(REVIEW_COLUMNS);
    if (!after) return null;
    const change = changeOf(reviewField(reviewId), reviewSnapshot(before), reviewSnapshot(after));
    await recordRevision(tx, {
      placeId,
      action: MODERATION_ACTION[status],
      author,
      changes: change ? [change] : [],
    });
    await recomputeRating(tx, placeId);
    return toReviewWithStatus(after);
  });
}

// ── Merges ──────────────────────────────────────────────────────────────────

/** The instant a review last changed in its author's hands, for "keep the newest". */
function writtenAt(row: ReviewRow): number {
  return (row.editedAt ?? row.createdAt).getTime();
}

/**
 * Move the absorbed place's reviews to the survivor, inside the merge's
 * transaction, and recompute both ratings. Returns how many moved.
 *
 * The moves are not itemized in the survivor's `place_absorbed` revision:
 * that one is public, and a review's history is moderation's. Each review set
 * aside records its own `review_hidden`.
 *
 * Every review moves. Where one person has a PUBLISHED review on both places,
 * the newer one (by when its author last wrote it) stays published and the
 * older is set aside as `hidden` — never destroyed, so an operator can read it
 * back. Withdrawn reviews move too: their rows hold no words, and leaving them
 * behind would make a revival write a second review.
 */
export async function moveReviewsToSurvivor(
  tx: DatabaseOrTransaction,
  survivorId: string,
  absorbedId: string,
  author: RevisionAuthor,
): Promise<number> {
  const [absorbed, survivor] = await Promise.all([
    tx.select(REVIEW_COLUMNS).from(placeReviews).where(eq(placeReviews.placeId, absorbedId)),
    tx
      .select(REVIEW_COLUMNS)
      .from(placeReviews)
      .where(and(eq(placeReviews.placeId, survivorId), eq(placeReviews.status, 'published'))),
  ]);
  if (absorbed.length === 0) return 0;

  const survivorsPublished = new Map(survivor.map((row) => [row.authorOxyUserId, row]));
  const now = new Date();
  // Set aside FIRST, so the partial unique index on published reviews never
  // sees two by one person on the survivor.
  for (const moving of absorbed) {
    const theirs = survivorsPublished.get(moving.authorOxyUserId);
    if (moving.status !== 'published' || theirs === undefined) continue;
    const older = writtenAt(moving) > writtenAt(theirs) ? theirs : moving;
    await tx
      .update(placeReviews)
      .set({ status: 'hidden', updatedAt: now })
      .where(eq(placeReviews.id, older.id));
    await recordRevision(tx, {
      placeId: older.placeId,
      action: 'review_hidden',
      author,
      changes: [
        {
          field: reviewField(older.id),
          before: reviewSnapshot(older),
          after: reviewSnapshot({ ...older, status: 'hidden' }),
        },
      ],
    });
  }

  await tx
    .update(placeReviews)
    .set({ placeId: survivorId, updatedAt: now })
    .where(
      inArray(
        placeReviews.id,
        absorbed.map((row) => row.id),
      ),
    );
  await recomputeRating(tx, survivorId);
  await recomputeRating(tx, absorbedId);
  return absorbed.length;
}
