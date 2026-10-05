/**
 * A place's gallery: every database access the media routes make.
 *
 * Each write runs in ONE transaction with the revision that records it, with
 * the place row locked first — so two writes to one gallery are serialized,
 * positions never collide, and a logo or cover pointer is cleared in the same
 * commit as the item it named leaving the gallery.
 *
 * Nothing here talks to Oxy. The route checks and links a file before
 * {@link addPlaceMedia} and unlinks it after {@link removePlaceMedia}; a
 * database transaction never waits on another service.
 */

import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type {
  CapabilityVerification,
  ModeratedPlaceMediaState,
  ModerationPlaceMedia,
  PlaceMedia,
  PlaceMediaKind,
  PlaceMediaState,
  PlaceRevisionAction,
  PlaceRevisionChange,
} from '@goway/contracts';
import type { SelectedRow } from '@oxy.so/db';
import { ApiError } from '../../http/apiError';
import type { Paged, TimeWindow } from '../../http/cursor';
import { assertWritableVerification } from '../../places/capabilityAuthority';
import type { Database, DatabaseOrTransaction } from '../postgres';
import { placeMedia, places } from '../schema';
import type { PlaceActor } from './placesRepository';
import { changeOf, mediaField, mediaSnapshot, recordRevision, type RevisionAuthor } from './revisions';

export const MEDIA_COLUMNS = {
  id: placeMedia.id,
  placeId: placeMedia.placeId,
  oxyFileId: placeMedia.oxyFileId,
  oxyLinkPlaceId: placeMedia.oxyLinkPlaceId,
  kind: placeMedia.kind,
  contributorOxyAccountId: placeMedia.contributorOxyAccountId,
  operatedByOxyUserId: placeMedia.operatedByOxyUserId,
  verification: placeMedia.verification,
  state: placeMedia.state,
  position: placeMedia.position,
  caption: placeMedia.caption,
  attribution: placeMedia.attribution,
  license: placeMedia.license,
  width: placeMedia.width,
  height: placeMedia.height,
  createdAt: placeMedia.createdAt,
} as const;

export type MediaRow = SelectedRow<typeof MEDIA_COLUMNS>;

/** The public shape: no contributor and no state — only a visible item is ever published. */
export function toPlaceMedia(row: MediaRow): PlaceMedia {
  const media: PlaceMedia = {
    id: row.id,
    placeId: row.placeId,
    fileId: row.oxyFileId,
    // CHECK-constrained to the contract's tuples.
    kind: row.kind as PlaceMediaKind,
    verification: row.verification as CapabilityVerification,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.caption !== null) media.caption = row.caption;
  if (row.attribution !== null) media.attribution = row.attribution;
  if (row.license !== null) media.license = row.license;
  if (row.width !== null) media.width = row.width;
  if (row.height !== null) media.height = row.height;
  return media;
}

function toModerationMedia(row: MediaRow): ModerationPlaceMedia {
  return {
    ...toPlaceMedia(row),
    state: row.state as PlaceMediaState,
    contributorOxyAccountId: row.contributorOxyAccountId,
  };
}

/**
 * Lock a place for a gallery write and move its `updated_at` — a client caching
 * a place on it must not miss a new logo. `null` when no place has the id.
 */
async function lockPlace(tx: DatabaseOrTransaction, placeId: string) {
  const [row] = await tx
    .update(places)
    .set({ updatedAt: new Date() })
    .where(eq(places.id, placeId))
    .returning({ id: places.id, logoMediaId: places.logoMediaId, coverMediaId: places.coverMediaId });
  return row ?? null;
}

/**
 * Clear the place's logo or cover when it is the item leaving the gallery, and
 * say so. A pointer at an item nobody may see would publish it anyway.
 */
async function releasePointers(
  tx: DatabaseOrTransaction,
  place: { id: string; logoMediaId: string | null; coverMediaId: string | null },
  mediaId: string,
): Promise<PlaceRevisionChange[]> {
  const changes: PlaceRevisionChange[] = [];
  const cleared: { logoMediaId?: null; coverMediaId?: null } = {};
  if (place.logoMediaId === mediaId) {
    cleared.logoMediaId = null;
    changes.push({ field: 'logo', before: mediaId });
  }
  if (place.coverMediaId === mediaId) {
    cleared.coverMediaId = null;
    changes.push({ field: 'cover', before: mediaId });
  }
  if (changes.length > 0) await tx.update(places).set(cleared).where(eq(places.id, place.id));
  return changes;
}

/** The position after the place's last live item. */
async function nextPosition(tx: DatabaseOrTransaction, placeId: string): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${placeMedia.position}) + 1, 0)::int` })
    .from(placeMedia)
    .where(and(eq(placeMedia.placeId, placeId), ne(placeMedia.state, 'removed')));
  return row?.next ?? 0;
}

/** What a contributor adds: a file Oxy has vouched for, and what it shows. */
export interface MediaContribution {
  fileId: string;
  kind: PlaceMediaKind;
  caption?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * Add one item to the end of a place's gallery, at the tier the contributor's
 * standing earns, and record `media_added`.
 *
 * A file already live in this gallery is a `conflict` naming the item it
 * already is: one image, one item. `null` when no place has the id.
 */
export async function addPlaceMedia(
  db: Database,
  placeId: string,
  item: MediaContribution,
  actor: PlaceActor,
): Promise<PlaceMedia | null> {
  const verification = assertWritableVerification(actor.assertedVerification);
  return db.transaction(async (tx) => {
    const place = await lockPlace(tx, placeId);
    if (!place) return null;

    const [row] = await tx
      .insert(placeMedia)
      .values({
        placeId,
        oxyFileId: item.fileId,
        oxyLinkPlaceId: placeId,
        kind: item.kind,
        contributorOxyAccountId: actor.author.oxyAccountId,
        operatedByOxyUserId: actor.author.operatedByOxyUserId,
        verification,
        state: 'visible',
        position: await nextPosition(tx, placeId),
        caption: item.caption ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
      })
      .onConflictDoNothing({
        target: [placeMedia.placeId, placeMedia.oxyFileId],
        where: sql`${placeMedia.state} <> 'removed'`,
      })
      .returning(MEDIA_COLUMNS);
    if (!row) {
      const [existing] = await tx
        .select({ id: placeMedia.id })
        .from(placeMedia)
        .where(and(eq(placeMedia.placeId, placeId), eq(placeMedia.oxyFileId, item.fileId), ne(placeMedia.state, 'removed')))
        .limit(1);
      throw new ApiError(
        'conflict',
        'That file is already in this place\'s gallery.',
        existing ? { mediaId: existing.id } : undefined,
      );
    }

    await recordRevision(tx, {
      placeId,
      action: 'media_added',
      author: actor.author,
      changes: [{ field: mediaField(row.id), after: mediaSnapshot(row) }],
    });
    return toPlaceMedia(row);
  });
}

/** One live item of one place — visible or hidden — or `undefined`. Carries the contributor, for the route to decide on. */
export async function findLivePlaceMedia(
  db: DatabaseOrTransaction,
  placeId: string,
  mediaId: string,
): Promise<MediaRow | undefined> {
  const [row] = await db
    .select(MEDIA_COLUMNS)
    .from(placeMedia)
    .where(and(eq(placeMedia.placeId, placeId), eq(placeMedia.id, mediaId), ne(placeMedia.state, 'removed')))
    .limit(1);
  return row;
}

/**
 * Withdraw one item: `removed`, terminally, with the place's logo or cover
 * cleared if it was either, and `media_removed` recorded. Returns the item
 * as it was, so the route can unlink its file; `null` when the place or a
 * live item of that id is gone.
 */
export async function removePlaceMedia(
  db: Database,
  placeId: string,
  mediaId: string,
  author: RevisionAuthor,
): Promise<MediaRow | null> {
  return db.transaction(async (tx) => {
    const place = await lockPlace(tx, placeId);
    if (!place) return null;
    const [before] = await tx
      .select(MEDIA_COLUMNS)
      .from(placeMedia)
      .where(and(eq(placeMedia.placeId, placeId), eq(placeMedia.id, mediaId), ne(placeMedia.state, 'removed')))
      .for('update');
    if (!before) return null;

    const [after] = await tx
      .update(placeMedia)
      .set({ state: 'removed', updatedAt: new Date() })
      .where(eq(placeMedia.id, mediaId))
      .returning(MEDIA_COLUMNS);
    if (!after) return null;

    const changes = [
      ...[changeOf(mediaField(mediaId), mediaSnapshot(before), undefined)].filter(
        (change): change is PlaceRevisionChange => change !== null,
      ),
      ...(await releasePointers(tx, place, mediaId)),
    ];
    await recordRevision(tx, { placeId, action: 'media_removed', author, changes });
    return before;
  });
}

/**
 * Put the named VISIBLE items first, in the order given, and the rest of the
 * visible gallery after them in its existing order. Hidden items keep their
 * positions. An id that is not a visible item of this place is
 * `validation_failed`. `false` when no place has the id.
 */
export async function reorderPlaceMedia(
  db: Database,
  placeId: string,
  mediaIds: readonly string[],
  author: RevisionAuthor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const place = await lockPlace(tx, placeId);
    if (!place) return false;

    const visible = await tx
      .select(MEDIA_COLUMNS)
      .from(placeMedia)
      .where(and(eq(placeMedia.placeId, placeId), eq(placeMedia.state, 'visible')))
      .orderBy(asc(placeMedia.position), asc(placeMedia.id));
    const byId = new Map(visible.map((row) => [row.id, row]));
    const unknown = mediaIds.findIndex((id) => !byId.has(id));
    if (unknown !== -1) {
      throw new ApiError('validation_failed', 'Every item named must be a visible item of this place.', {
        field: `mediaIds.${String(unknown)}`,
        issue: 'not_in_gallery',
      });
    }

    const named = new Set(mediaIds);
    const order = [...mediaIds.map((id) => byId.get(id)!), ...visible.filter((row) => !named.has(row.id))];
    // The visible items take the positions the visible items already held, in
    // the new order — so a hidden item's position is never taken, and a
    // restored item reappears where it was.
    const slots = visible.map((row) => row.position);
    const changes: PlaceRevisionChange[] = [];
    for (const [index, row] of order.entries()) {
      const position = slots[index]!;
      if (row.position === position) continue;
      await tx.update(placeMedia).set({ position, updatedAt: new Date() }).where(eq(placeMedia.id, row.id));
      const change = changeOf(mediaField(row.id), mediaSnapshot(row), mediaSnapshot({ ...row, position }));
      if (change) changes.push(change);
    }
    await recordRevision(tx, { placeId, action: 'media_reordered', author, changes });
    return true;
  });
}

/** Where a gallery page resumes: the last item served, by position and id. */
export type MediaKeyset = readonly [position: number, mediaId: string];

/** One window of a place's VISIBLE gallery, in its order. */
export async function listPlaceMedia(
  db: DatabaseOrTransaction,
  placeId: string,
  window: { kinds?: readonly PlaceMediaKind[] | undefined; limit: number; after?: MediaKeyset | undefined },
): Promise<PlaceMedia[]> {
  const rows = await db
    .select(MEDIA_COLUMNS)
    .from(placeMedia)
    .where(
      and(
        eq(placeMedia.placeId, placeId),
        eq(placeMedia.state, 'visible'),
        window.kinds && window.kinds.length > 0 ? inArray(placeMedia.kind, [...window.kinds]) : undefined,
        window.after ? sql`(${placeMedia.position}, ${placeMedia.id}) > (${window.after[0]}::int, ${window.after[1]})` : undefined,
      ),
    )
    .orderBy(asc(placeMedia.position), asc(placeMedia.id))
    .limit(window.limit);
  return rows.map(toPlaceMedia);
}

// ── Moderation ──────────────────────────────────────────────────────────────

const MODERATION_MEDIA_COLUMNS = { ...MEDIA_COLUMNS, positionAt: sql<string>`${placeMedia.createdAt}::text` } as const;

function createdWindow(window: TimeWindow): SQL | undefined {
  return window.after
    ? sql`(${placeMedia.createdAt}, ${placeMedia.id}) > (${window.after[0]}::timestamptz, ${window.after[1]})`
    : undefined;
}

/** One window of a place's items in one state (or every state), oldest first, with who added each. */
export async function listModerationMedia(
  db: DatabaseOrTransaction,
  placeId: string,
  state: PlaceMediaState | undefined,
  window: TimeWindow,
): Promise<Paged<ModerationPlaceMedia>[]> {
  const rows = await db
    .select(MODERATION_MEDIA_COLUMNS)
    .from(placeMedia)
    .where(and(eq(placeMedia.placeId, placeId), state ? eq(placeMedia.state, state) : undefined, createdWindow(window)))
    .orderBy(asc(placeMedia.createdAt), asc(placeMedia.id))
    .limit(window.limit);
  return rows.map(({ positionAt, ...row }) => ({ item: toModerationMedia(row), position: [positionAt, row.id] }));
}

const MODERATION_ACTION: Readonly<Record<ModeratedPlaceMediaState, PlaceRevisionAction>> = {
  hidden: 'media_hidden',
  visible: 'media_restored',
};

/**
 * Hide a visible item or restore a hidden one, and record it. Hiding clears a
 * logo or cover that named the item; restoring does not set it back — that is
 * the business's call. A removed item, or one already in the state asked for,
 * is a `conflict`. `null` when the place or the item is gone.
 */
export async function moderatePlaceMedia(
  db: Database,
  placeId: string,
  mediaId: string,
  state: ModeratedPlaceMediaState,
  author: RevisionAuthor,
): Promise<ModerationPlaceMedia | null> {
  return db.transaction(async (tx) => {
    const place = await lockPlace(tx, placeId);
    if (!place) return null;
    const [before] = await tx
      .select(MEDIA_COLUMNS)
      .from(placeMedia)
      .where(and(eq(placeMedia.placeId, placeId), eq(placeMedia.id, mediaId)))
      .for('update');
    if (!before) return null;
    if (before.state === 'removed') {
      throw new ApiError('conflict', 'This item was withdrawn by its contributor or the business.', { state: before.state });
    }
    if (before.state === state) {
      throw new ApiError('conflict', `This item is already ${state}.`, { state: before.state });
    }

    const [after] = await tx
      .update(placeMedia)
      .set({ state, updatedAt: new Date() })
      .where(eq(placeMedia.id, mediaId))
      .returning(MEDIA_COLUMNS);
    if (!after) return null;

    const changes = [
      ...[changeOf(mediaField(mediaId), mediaSnapshot(before), mediaSnapshot(after))].filter(
        (change): change is PlaceRevisionChange => change !== null,
      ),
      ...(state === 'hidden' ? await releasePointers(tx, place, mediaId) : []),
    ];
    await recordRevision(tx, { placeId, action: MODERATION_ACTION[state], author, changes });
    return toModerationMedia(after);
  });
}

// ── Merges ──────────────────────────────────────────────────────────────────

/**
 * Move the absorbed place's live items to the survivor, inside the merge's
 * transaction, and say what moved.
 *
 * A file the survivor's gallery already holds stays where it is — the
 * survivor's item wins, as every child's collision does. Moved items join the
 * end of the survivor's gallery in their own order. The absorbed place's logo
 * and cover pointers stay on its row (a merged place's columns are never
 * rewritten), naming items that now belong to the survivor; a merged place is
 * never published, so they are never read.
 */
export async function moveMediaToSurvivor(
  tx: DatabaseOrTransaction,
  survivorId: string,
  absorbedId: string,
): Promise<PlaceRevisionChange[]> {
  const [absorbed, survivor] = await Promise.all([
    tx
      .select(MEDIA_COLUMNS)
      .from(placeMedia)
      .where(and(eq(placeMedia.placeId, absorbedId), ne(placeMedia.state, 'removed')))
      .orderBy(asc(placeMedia.position), asc(placeMedia.id)),
    tx
      .select({ oxyFileId: placeMedia.oxyFileId })
      .from(placeMedia)
      .where(and(eq(placeMedia.placeId, survivorId), ne(placeMedia.state, 'removed'))),
  ]);
  const held = new Set(survivor.map((row) => row.oxyFileId));
  const moving = absorbed.filter((row) => !held.has(row.oxyFileId));
  if (moving.length === 0) return [];

  let position = await nextPosition(tx, survivorId);
  const now = new Date();
  const changes: PlaceRevisionChange[] = [];
  for (const row of moving) {
    await tx.update(placeMedia).set({ placeId: survivorId, position, updatedAt: now }).where(eq(placeMedia.id, row.id));
    changes.push({ field: mediaField(row.id), after: mediaSnapshot({ ...row, position }) });
    position += 1;
  }
  return changes;
}
