import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type {
  OrganizationList,
  OrganizationListEntry,
  OrganizationListEntryInput,
  OrganizationListInput,
  OrganizationListUpdate,
} from '@goway/contracts';
import type { DatabaseOrTransaction, Transaction } from './postgres';
import { organizationLists as lists, organizationListEntries as entries, places } from './schema';
import { ApiError } from '../http/apiError';

function listDto(row: typeof lists.$inferSelect): OrganizationList {
  return {
    id: row.id,
    oxyAccountId: row.oxyAccountId,
    title: row.title,
    description: row.description,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function getList(db: DatabaseOrTransaction, id: string, lock = false) {
  const query = db.select().from(lists).where(eq(lists.id, id));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new ApiError('not_found', 'The list is unavailable.');
  return listDto(row);
}
export async function listOrganizations(
  db: DatabaseOrTransaction,
  accountId: string | undefined,
  after: string | undefined,
  limit: number,
) {
  return (
    await db
      .select()
      .from(lists)
      .where(
        and(
          accountId ? eq(lists.oxyAccountId, accountId) : undefined,
          after ? gt(lists.id, after) : undefined,
        ),
      )
      .orderBy(asc(lists.id))
      .limit(limit)
  ).map(listDto);
}
export async function createList(
  db: DatabaseOrTransaction,
  input: OrganizationListInput,
  actor: string,
) {
  const [row] = await db
    .insert(lists)
    .values({ ...input, updatedByOxyUserId: actor })
    .returning();
  if (!row) throw new Error('List insert returned no row');
  return listDto(row);
}
export async function touchList(
  tx: Transaction,
  id: string,
  actor: string,
  input?: OrganizationListUpdate,
) {
  await tx
    .update(lists)
    .set({
      ...input,
      revision: sql`${lists.revision} + 1`,
      updatedAt: new Date(),
      updatedByOxyUserId: actor,
    })
    .where(eq(lists.id, id));
  return getList(tx, id);
}
export async function deleteList(tx: Transaction, id: string) {
  await tx.delete(lists).where(eq(lists.id, id));
}
function entryDto(
  row: typeof entries.$inferSelect,
  timezone: string | null,
  now: Date,
): OrganizationListEntry {
  return {
    id: row.id,
    listId: row.listId,
    placeId: row.placeId,
    activity: row.activity,
    information: row.information,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    position: row.position,
    completedAt: row.completedAt?.toISOString() ?? null,
    timezone,
    status: row.completedAt
      ? 'completed'
      : row.endsAt <= now
        ? 'expired'
        : row.startsAt > now
          ? 'upcoming'
          : 'active',
  };
}
export async function listEntries(
  db: DatabaseOrTransaction,
  listId: string,
  state: 'active' | 'all',
  after: [number, string] | undefined,
  limit: number,
  now: Date,
) {
  const rows = await db
    .select({ entry: entries, timezone: places.timezone })
    .from(entries)
    .innerJoin(places, eq(places.id, entries.placeId))
    .where(
      and(
        eq(entries.listId, listId),
        state === 'active'
          ? and(isNull(entries.completedAt), gt(entries.endsAt, now), eq(places.status, 'active'))
          : undefined,
        after
          ? or(
              gt(entries.position, after[0]),
              and(eq(entries.position, after[0]), gt(entries.id, after[1])),
            )
          : undefined,
      ),
    )
    .orderBy(asc(entries.position), asc(entries.id))
    .limit(limit);
  return rows.map((row) => entryDto(row.entry, row.timezone, now));
}
export async function getEntry(
  db: DatabaseOrTransaction,
  listId: string,
  entryId: string,
  now = new Date(),
) {
  const [row] = await db
    .select({ entry: entries, timezone: places.timezone })
    .from(entries)
    .innerJoin(places, eq(places.id, entries.placeId))
    .where(and(eq(entries.listId, listId), eq(entries.id, entryId)));
  if (!row) throw new ApiError('not_found', 'The activity is unavailable.');
  return entryDto(row.entry, row.timezone, now);
}
export async function writeEntry(
  tx: Transaction,
  listId: string,
  entryId: string | undefined,
  input: OrganizationListEntryInput,
  actor: string,
) {
  const [place] = await tx
    .select({ id: places.id })
    .from(places)
    .where(and(eq(places.id, input.placeId), eq(places.status, 'active')))
    .for('share');
  if (!place) throw new ApiError('validation_failed', 'Choose an existing active GoWay place.');
  const values = {
    ...input,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    updatedByOxyUserId: actor,
  };
  if (entryId) {
    await getEntry(tx, listId, entryId);
    await tx
      .update(entries)
      .set(values)
      .where(and(eq(entries.listId, listId), eq(entries.id, entryId)));
  } else {
    const current = await tx
      .select({ position: entries.position })
      .from(entries)
      .where(eq(entries.listId, listId));
    if (current.length >= 200)
      throw new ApiError('validation_failed', 'A list may contain at most 200 activities.');
    const [row] = await tx
      .insert(entries)
      .values({ ...values, listId, position: Math.max(-1, ...current.map((e) => e.position)) + 1 })
      .returning({ id: entries.id });
    entryId = row?.id;
  }
  if (!entryId) throw new Error('Activity insert returned no row');
  await touchList(tx, listId, actor);
  return getEntry(tx, listId, entryId);
}
export async function completeEntry(
  tx: Transaction,
  listId: string,
  entryId: string,
  actor: string,
) {
  await getEntry(tx, listId, entryId);
  await tx
    .update(entries)
    .set({ completedAt: sql`coalesce(${entries.completedAt}, now())`, updatedByOxyUserId: actor })
    .where(and(eq(entries.listId, listId), eq(entries.id, entryId)));
  await touchList(tx, listId, actor);
  return getEntry(tx, listId, entryId);
}
export async function deleteEntry(tx: Transaction, listId: string, entryId: string, actor: string) {
  await getEntry(tx, listId, entryId);
  await tx.delete(entries).where(and(eq(entries.listId, listId), eq(entries.id, entryId)));
  await touchList(tx, listId, actor);
}
export async function orderEntries(
  tx: Transaction,
  list: OrganizationList,
  ids: string[],
  revision: number,
  actor: string,
) {
  if (revision !== list.revision)
    throw new ApiError('conflict', 'The list changed. Reload it before ordering.');
  const current = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.listId, list.id));
  if (current.length !== ids.length || current.some((e) => !ids.includes(e.id)))
    throw new ApiError('conflict', 'The order must contain every current activity exactly once.');
  for (const [position, id] of ids.entries())
    await tx
      .update(entries)
      .set({ position, updatedByOxyUserId: actor })
      .where(and(eq(entries.listId, list.id), eq(entries.id, id)));
  return touchList(tx, list.id, actor);
}
