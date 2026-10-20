/**
 * Saved place lists: every database access the `/lists` routes make.
 *
 * ## Ownership is part of every statement
 *
 * Each function takes the OWNER and puts `owner_oxy_user_id = owner` in the
 * same query that reads or writes the row — an item is reached only through a
 * join to its list's owner. There is no function that loads a list by id and
 * leaves the comparison to its caller, so a route that forgets to check cannot
 * read or change another person's list: it simply finds nothing. Every
 * "not yours" and every "no such list" is the same `undefined`/`null`/`false`,
 * which the route answers `404` (never `403`: whether somebody else's list
 * exists is not the caller's to learn).
 *
 * ## Serialising writes
 *
 * Creating, renaming and ensuring a list take an advisory lock on the owner
 * (`pg_advisory_xact_lock`), so the list limit and the unique name are checked
 * against a state no concurrent request is changing. Writes to a list's items
 * lock the list row (`FOR UPDATE`), so positions never collide and the item
 * limit cannot be overshot. The unique indexes are the backstop, not the check.
 *
 * ## No revisions
 *
 * A list is the owner's, not the place's. Nothing here records a
 * `place_revision`, and nothing reads a place beyond its id.
 */

import { and, asc, eq, exists, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  MAX_SAVED_LIST_ITEMS,
  MAX_SAVED_LISTS_PER_USER,
  SAVED_LIST_CONFLICT_DETAIL,
  SAVED_LIST_COVER_PLACES,
  type SavedList,
  type SavedListConflictReason,
  type SavedListItem,
  type SavedPlace,
} from '@goway/contracts';
import { constraintNameOf, isUniqueViolation, type SelectedRow } from '@oxy.so/db';
import { ApiError } from '../../http/apiError';
import type { TimeWindow, Paged } from '../../http/cursor';
import type { Database, DatabaseOrTransaction } from '../postgres';
import { savedPlaceListItems, savedPlaceLists } from '../schema';

function conflict(reason: SavedListConflictReason, message: string, max?: number): ApiError {
  return new ApiError('conflict', message, {
    [SAVED_LIST_CONFLICT_DETAIL]: reason,
    ...(max === undefined ? {} : { max }),
  });
}

const LIST_COLUMNS = {
  id: savedPlaceLists.id,
  name: savedPlaceLists.name,
  visibility: savedPlaceLists.visibility,
  isDefault: savedPlaceLists.isDefault,
  createdAt: savedPlaceLists.createdAt,
  updatedAt: savedPlaceLists.updatedAt,
} as const;

type ListRow = SelectedRow<typeof LIST_COLUMNS>;

/**
 * The count and cover of each list, read for the lists a page holds: one
 * grouped count and one ranked read, never a query per list.
 */
async function summarize<Row extends ListRow>(
  db: DatabaseOrTransaction,
  rows: readonly Row[],
): Promise<{ row: Row; list: SavedList }[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const counts = await db
    .select({ listId: savedPlaceListItems.listId, count: sql<number>`count(*)::int` })
    .from(savedPlaceListItems)
    .where(inArray(savedPlaceListItems.listId, ids))
    .groupBy(savedPlaceListItems.listId);
  const ranked = db
    .select({
      listId: savedPlaceListItems.listId,
      placeId: savedPlaceListItems.placeId,
      rank: sql<number>`row_number() over (partition by ${savedPlaceListItems.listId} order by ${savedPlaceListItems.position}, ${savedPlaceListItems.id})`.as(
        'rank',
      ),
    })
    .from(savedPlaceListItems)
    .where(inArray(savedPlaceListItems.listId, ids))
    .as('ranked');
  const covers = await db
    .select({ listId: ranked.listId, placeId: ranked.placeId })
    .from(ranked)
    .where(lte(ranked.rank, SAVED_LIST_COVER_PLACES))
    .orderBy(asc(ranked.listId), asc(ranked.rank));

  const countOf = new Map(counts.map((row) => [row.listId, row.count]));
  const coverOf = new Map<string, string[]>();
  for (const row of covers)
    coverOf.set(row.listId, [...(coverOf.get(row.listId) ?? []), row.placeId]);
  return rows.map((row) => ({
    row,
    list: toSavedList(row, countOf.get(row.id) ?? 0, coverOf.get(row.id) ?? []),
  }));
}

function toSavedList(row: ListRow, itemCount: number, coverPlaceIds: string[]): SavedList {
  return {
    id: row.id,
    name: row.name,
    // CHECK-constrained to the contract's tuple.
    visibility: row.visibility as SavedList['visibility'],
    isDefault: row.isDefault,
    itemCount,
    coverPlaceIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ITEM_COLUMNS = {
  id: savedPlaceListItems.id,
  listId: savedPlaceListItems.listId,
  placeId: savedPlaceListItems.placeId,
  note: savedPlaceListItems.note,
  position: savedPlaceListItems.position,
  createdAt: savedPlaceListItems.createdAt,
} as const;

type ItemRow = SelectedRow<typeof ITEM_COLUMNS>;

function toSavedItem(row: ItemRow): SavedListItem {
  const item: SavedListItem = {
    id: row.id,
    listId: row.listId,
    placeId: row.placeId,
    position: row.position,
    addedAt: row.createdAt.toISOString(),
  };
  if (row.note !== null) item.note = row.note;
  return item;
}

/** One person's list-and-name writes are serialised on this lock for the length of the transaction. */
async function lockOwner(tx: DatabaseOrTransaction, owner: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`saved-lists:${owner}`}, 0))`,
  );
}

async function ownedListCount(tx: DatabaseOrTransaction, owner: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(savedPlaceLists)
    .where(eq(savedPlaceLists.ownerOxyUserId, owner));
  return row?.count ?? 0;
}

/** Lock the owner's list for an item write. `undefined` when it is not theirs. */
async function lockOwnList(
  tx: DatabaseOrTransaction,
  owner: string,
  listId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: savedPlaceLists.id })
    .from(savedPlaceLists)
    .where(and(eq(savedPlaceLists.id, listId), eq(savedPlaceLists.ownerOxyUserId, owner)))
    .for('update');
  return row;
}

async function touchList(tx: DatabaseOrTransaction, listId: string): Promise<void> {
  await tx
    .update(savedPlaceLists)
    .set({ updatedAt: new Date() })
    .where(eq(savedPlaceLists.id, listId));
}

async function readOwnList(
  db: DatabaseOrTransaction,
  owner: string,
  listId: string,
): Promise<SavedList | undefined> {
  const [row] = await db
    .select(LIST_COLUMNS)
    .from(savedPlaceLists)
    .where(and(eq(savedPlaceLists.id, listId), eq(savedPlaceLists.ownerOxyUserId, owner)));
  return row ? (await summarize(db, [row]))[0]?.list : undefined;
}

// ── Lists ───────────────────────────────────────────────────────────────────

/** One of the owner's lists, or `undefined` when they have none with that id. */
export function findSavedList(
  db: DatabaseOrTransaction,
  owner: string,
  listId: string,
): Promise<SavedList | undefined> {
  return readOwnList(db, owner, listId);
}

/** A window of the owner's lists, oldest first. */
export async function listSavedLists(
  db: DatabaseOrTransaction,
  owner: string,
  window: TimeWindow,
): Promise<Paged<SavedList>[]> {
  const rows = await db
    .select({ ...LIST_COLUMNS, createdAtText: sql<string>`${savedPlaceLists.createdAt}::text` })
    .from(savedPlaceLists)
    .where(
      and(
        eq(savedPlaceLists.ownerOxyUserId, owner),
        window.after
          ? sql`(${savedPlaceLists.createdAt}, ${savedPlaceLists.id}) > (${window.after[0]}::timestamptz, ${window.after[1]})`
          : undefined,
      ),
    )
    .orderBy(asc(savedPlaceLists.createdAt), asc(savedPlaceLists.id))
    .limit(window.limit);
  return (await summarize(db, rows)).map(({ row, list }) => ({
    item: list,
    position: [row.createdAtText, row.id],
  }));
}

const NAME_TAKEN = () => conflict('name_taken', 'You already have a list with that name.');
const LIST_LIMIT = () =>
  conflict(
    'list_limit_reached',
    'You have reached the most lists you can keep. Delete one to make another.',
    MAX_SAVED_LISTS_PER_USER,
  );

/** The `conflict` for a name a concurrent write took first. `null` for any other error. */
function nameConflict(error: unknown): ApiError | null {
  return isUniqueViolation(error) && constraintNameOf(error) === 'saved_place_lists_owner_name_key'
    ? NAME_TAKEN()
    : null;
}

async function nameHeld(
  tx: DatabaseOrTransaction,
  owner: string,
  name: string,
): Promise<{ id: string; isDefault: boolean } | undefined> {
  const [row] = await tx
    .select({ id: savedPlaceLists.id, isDefault: savedPlaceLists.isDefault })
    .from(savedPlaceLists)
    .where(
      and(
        eq(savedPlaceLists.ownerOxyUserId, owner),
        sql`${savedPlaceLists.nameNormalized} = lower(btrim(${name}))`,
      ),
    );
  return row;
}

/** A new private list. `conflict` when the name is taken or the owner holds the most lists. */
export async function createSavedList(
  db: Database,
  owner: string,
  name: string,
  isDefault = false,
): Promise<SavedList> {
  try {
    return await db.transaction(async (tx) => {
      await lockOwner(tx, owner);
      if ((await ownedListCount(tx, owner)) >= MAX_SAVED_LISTS_PER_USER) throw LIST_LIMIT();
      if (await nameHeld(tx, owner, name)) throw NAME_TAKEN();
      const [row] = await tx
        .insert(savedPlaceLists)
        .values({ ownerOxyUserId: owner, name, isDefault })
        .returning({ id: savedPlaceLists.id });
      const created = row ? await readOwnList(tx, owner, row.id) : undefined;
      if (!created) throw new ApiError('internal_error', 'The list could not be recorded.');
      return created;
    });
  } catch (error) {
    throw nameConflict(error) ?? error;
  }
}

/**
 * The owner's default list, created when they have none.
 *
 * - they have one: it, unchanged (`created: false`);
 * - they have a list already named `name` that is not the default: that list
 *   becomes the default, rather than a clash between the lazy create and a
 *   list they made by hand;
 * - otherwise: a new one named `name`.
 */
export async function ensureDefaultSavedList(
  db: Database,
  owner: string,
  name: string,
): Promise<{ list: SavedList; created: boolean }> {
  try {
    return await db.transaction(async (tx) => {
      await lockOwner(tx, owner);
      const [existing] = await tx
        .select({ id: savedPlaceLists.id })
        .from(savedPlaceLists)
        .where(and(eq(savedPlaceLists.ownerOxyUserId, owner), eq(savedPlaceLists.isDefault, true)));
      if (existing) {
        const list = await readOwnList(tx, owner, existing.id);
        if (!list) throw new ApiError('internal_error', 'The list could not be read.');
        return { list, created: false };
      }
      const sameName = await nameHeld(tx, owner, name);
      if (sameName) {
        await tx
          .update(savedPlaceLists)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(savedPlaceLists.id, sameName.id));
        const list = await readOwnList(tx, owner, sameName.id);
        if (!list) throw new ApiError('internal_error', 'The list could not be read.');
        return { list, created: false };
      }
      if ((await ownedListCount(tx, owner)) >= MAX_SAVED_LISTS_PER_USER) throw LIST_LIMIT();
      const [row] = await tx
        .insert(savedPlaceLists)
        .values({ ownerOxyUserId: owner, name, isDefault: true })
        .returning({ id: savedPlaceLists.id });
      const list = row ? await readOwnList(tx, owner, row.id) : undefined;
      if (!list) throw new ApiError('internal_error', 'The list could not be recorded.');
      return { list, created: true };
    });
  } catch (error) {
    throw nameConflict(error) ?? error;
  }
}

/** Rename one of the owner's lists. `undefined` when it is not theirs; `conflict` when the name is taken. */
export async function renameSavedList(
  db: Database,
  owner: string,
  listId: string,
  name: string,
): Promise<SavedList | undefined> {
  try {
    return await db.transaction(async (tx) => {
      await lockOwner(tx, owner);
      if (!(await lockOwnList(tx, owner, listId))) return undefined;
      const held = await nameHeld(tx, owner, name);
      if (held && held.id !== listId) throw NAME_TAKEN();
      await tx
        .update(savedPlaceLists)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(savedPlaceLists.id, listId), eq(savedPlaceLists.ownerOxyUserId, owner)));
      return readOwnList(tx, owner, listId);
    });
  } catch (error) {
    throw nameConflict(error) ?? error;
  }
}

/** Delete one of the owner's lists; its items go with it. `false` when it is not theirs. */
export async function deleteSavedList(
  db: DatabaseOrTransaction,
  owner: string,
  listId: string,
): Promise<boolean> {
  const rows = await db
    .delete(savedPlaceLists)
    .where(and(eq(savedPlaceLists.id, listId), eq(savedPlaceLists.ownerOxyUserId, owner)))
    .returning({ id: savedPlaceLists.id });
  return rows.length > 0;
}

/**
 * Delete everything a person saved: every list and, by cascade, every item.
 * The hook for an account erasure. Returns how many lists went.
 */
export async function deleteSavedDataOf(db: DatabaseOrTransaction, owner: string): Promise<number> {
  const rows = await db
    .delete(savedPlaceLists)
    .where(eq(savedPlaceLists.ownerOxyUserId, owner))
    .returning({ id: savedPlaceLists.id });
  return rows.length;
}

// ── Items ───────────────────────────────────────────────────────────────────

/** A window of one of the owner's lists, in their order. `undefined` when the list is not theirs. */
export async function listSavedItems(
  db: DatabaseOrTransaction,
  owner: string,
  listId: string,
  window: { limit: number; after?: [number, string] | undefined },
): Promise<{ item: SavedListItem; position: [number, string] }[] | undefined> {
  if (!(await readOwnList(db, owner, listId))) return undefined;
  const rows = await db
    .select(ITEM_COLUMNS)
    .from(savedPlaceListItems)
    .innerJoin(savedPlaceLists, eq(savedPlaceLists.id, savedPlaceListItems.listId))
    .where(
      and(
        eq(savedPlaceListItems.listId, listId),
        eq(savedPlaceLists.ownerOxyUserId, owner),
        window.after
          ? sql`(${savedPlaceListItems.position}, ${savedPlaceListItems.id}) > (${window.after[0]}, ${window.after[1]})`
          : undefined,
      ),
    )
    .orderBy(asc(savedPlaceListItems.position), asc(savedPlaceListItems.id))
    .limit(window.limit);
  return rows.map((row) => ({ item: toSavedItem(row), position: [row.position, row.id] }));
}

/**
 * Save a place at the end of one of the owner's lists.
 *
 * `undefined` when the list is not theirs. A place already in the list answers
 * its existing item (`created: false`) and changes nothing — not even the
 * note. `conflict` at the item limit.
 */
export async function addSavedItem(
  db: Database,
  owner: string,
  listId: string,
  input: { placeId: string; note?: string | undefined },
): Promise<{ item: SavedListItem; created: boolean } | undefined> {
  return db.transaction(async (tx) => {
    if (!(await lockOwnList(tx, owner, listId))) return undefined;

    const [existing] = await tx
      .select(ITEM_COLUMNS)
      .from(savedPlaceListItems)
      .where(
        and(eq(savedPlaceListItems.listId, listId), eq(savedPlaceListItems.placeId, input.placeId)),
      );
    if (existing) return { item: toSavedItem(existing), created: false };

    const [tally] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        last: sql<number>`coalesce(max(${savedPlaceListItems.position}), -1)::int`,
      })
      .from(savedPlaceListItems)
      .where(eq(savedPlaceListItems.listId, listId));
    if ((tally?.count ?? 0) >= MAX_SAVED_LIST_ITEMS) {
      throw conflict(
        'item_limit_reached',
        'This list is full. Remove a place to save another.',
        MAX_SAVED_LIST_ITEMS,
      );
    }
    const [row] = await tx
      .insert(savedPlaceListItems)
      .values({
        listId,
        placeId: input.placeId,
        note: input.note ?? null,
        position: (tally?.last ?? -1) + 1,
      })
      .returning(ITEM_COLUMNS);
    if (!row) throw new ApiError('internal_error', 'The place could not be saved.');
    await touchList(tx, listId);
    return { item: toSavedItem(row), created: true };
  });
}

/** Set or clear (`null`) the note on an item of the owner's list. `undefined` when it is not theirs. */
export async function updateSavedItemNote(
  db: Database,
  owner: string,
  listId: string,
  itemId: string,
  note: string | null,
): Promise<SavedListItem | undefined> {
  return db.transaction(async (tx) => {
    if (!(await lockOwnList(tx, owner, listId))) return undefined;
    const [row] = await tx
      .update(savedPlaceListItems)
      .set({ note, updatedAt: new Date() })
      .where(and(eq(savedPlaceListItems.id, itemId), eq(savedPlaceListItems.listId, listId)))
      .returning(ITEM_COLUMNS);
    if (!row) return undefined;
    await touchList(tx, listId);
    return toSavedItem(row);
  });
}

/** Remove an item from the owner's list. `false` when it is not theirs. */
export async function removeSavedItem(
  db: Database,
  owner: string,
  listId: string,
  itemId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockOwnList(tx, owner, listId))) return false;
    const rows = await tx
      .delete(savedPlaceListItems)
      .where(and(eq(savedPlaceListItems.id, itemId), eq(savedPlaceListItems.listId, listId)))
      .returning({ id: savedPlaceListItems.id });
    if (rows.length === 0) return false;
    await touchList(tx, listId);
    return true;
  });
}

/**
 * Put the named items first, in the order given, and the list's other items
 * after them in their existing order; positions are renumbered `0…n-1`.
 * `false` when the list is not the owner's; an id that is not an item of it is
 * `validation_failed`.
 */
export async function orderSavedItems(
  db: Database,
  owner: string,
  listId: string,
  itemIds: readonly string[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockOwnList(tx, owner, listId))) return false;
    const current = await tx
      .select({ id: savedPlaceListItems.id })
      .from(savedPlaceListItems)
      .where(eq(savedPlaceListItems.listId, listId))
      .orderBy(asc(savedPlaceListItems.position), asc(savedPlaceListItems.id));
    const held = new Set(current.map((row) => row.id));
    const unknown = itemIds.findIndex((id) => !held.has(id));
    if (unknown !== -1) {
      throw new ApiError('validation_failed', 'Every item named must be an item of this list.', {
        field: `itemIds.${String(unknown)}`,
        issue: 'not_in_list',
      });
    }
    const named = new Set(itemIds);
    const order = [...named, ...current.map((row) => row.id).filter((id) => !named.has(id))];
    // One statement: each item takes its index in the new order.
    const positions = sql.join(
      order.map((id, index) => sql`when ${id} then ${index}::integer`),
      sql` `,
    );
    await tx
      .update(savedPlaceListItems)
      .set({
        position: sql`case ${savedPlaceListItems.id} ${positions} end`,
        updatedAt: new Date(),
      })
      .where(and(eq(savedPlaceListItems.listId, listId), inArray(savedPlaceListItems.id, order)));
    await touchList(tx, listId);
    return true;
  });
}

// ── Lookup and place merges ─────────────────────────────────────────────────

/**
 * Which of the owner's lists hold each of these places. A place they have not
 * saved is absent. In the order the places were asked for; lists oldest first.
 */
export async function findSavedPlaces(
  db: DatabaseOrTransaction,
  owner: string,
  placeIds: readonly string[],
): Promise<SavedPlace[]> {
  if (placeIds.length === 0) return [];
  const rows = await db
    .select({
      placeId: savedPlaceListItems.placeId,
      listId: savedPlaceListItems.listId,
      itemId: savedPlaceListItems.id,
    })
    .from(savedPlaceListItems)
    .innerJoin(savedPlaceLists, eq(savedPlaceLists.id, savedPlaceListItems.listId))
    .where(
      and(
        eq(savedPlaceLists.ownerOxyUserId, owner),
        inArray(savedPlaceListItems.placeId, [...placeIds]),
      ),
    )
    .orderBy(asc(savedPlaceLists.createdAt), asc(savedPlaceLists.id));
  const holds = new Map<string, SavedPlace['lists']>();
  for (const row of rows) {
    const lists = holds.get(row.placeId) ?? [];
    lists.push({ listId: row.listId, itemId: row.itemId });
    holds.set(row.placeId, lists);
  }
  return placeIds.flatMap((placeId) => {
    const lists = holds.get(placeId);
    return lists && lists.length > 0 ? [{ placeId, lists }] : [];
  });
}

/**
 * A merge folds the absorbed place's saves into the survivor, inside the
 * merge's transaction: a list that already holds the survivor just loses the
 * absorbed entry (a place is in a list once), every other list's entry now
 * names the survivor in the same position. Returns how many saves moved.
 */
export async function moveSavedItemsToSurvivor(
  tx: DatabaseOrTransaction,
  survivorId: string,
  absorbedId: string,
): Promise<number> {
  const survivor = alias(savedPlaceListItems, 'survivor');
  await tx.delete(savedPlaceListItems).where(
    and(
      eq(savedPlaceListItems.placeId, absorbedId),
      exists(
        tx
          .select({ one: sql`1` })
          .from(survivor)
          .where(
            and(eq(survivor.listId, savedPlaceListItems.listId), eq(survivor.placeId, survivorId)),
          ),
      ),
    ),
  );
  const moved = await tx
    .update(savedPlaceListItems)
    .set({ placeId: survivorId, updatedAt: new Date() })
    .where(eq(savedPlaceListItems.placeId, absorbedId))
    .returning({ id: savedPlaceListItems.id });
  return moved.length;
}
