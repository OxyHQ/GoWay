/**
 * Place revisions: the append-only history every place write records.
 *
 * {@link recordRevision} is called by every write path in `db/places` with the
 * write's own TRANSACTION handle, after the write and before the commit, so a
 * revision and the change it describes commit or roll back together. It is the
 * only insert into `place_revisions` in this package, and nothing updates or
 * deletes a row.
 *
 * The diff is computed here, from values in the PUBLISHED shape — `address.city`
 * rather than `address_city`, `location` rather than two ordinates — so the
 * history speaks the contract's language and a column added to `places` cannot
 * reach it by accident.
 */

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  PLACE_REVISION_ACTIONS,
  PUBLIC_PLACE_REVISION_ACTIONS,
  type ModerationPlaceRevision,
  type PlaceRevision,
  type PlaceRevisionAction,
  type PlaceRevisionChange,
  type PlaceRevisionSource,
  type RevisionValue,
} from '@goway/contracts';
import type { Paged, TimeWindow } from '../../http/cursor';
import type { DatabaseOrTransaction } from '../postgres';
import { placeRevisions } from '../schema';
import type { PlaceRow } from './placeMapper';

/**
 * Who made a write, and through which door.
 *
 * Built from the request by the route — `oxyAccountId` is the session's
 * effective account, `operatedByOxyUserId` the person from Oxy's actor chain —
 * and never from anything in a body.
 */
export interface RevisionAuthor {
  readonly oxyAccountId: string;
  /** `null` when Oxy did not report the person: recorded as unknown, never guessed. */
  readonly operatedByOxyUserId: string | null;
  readonly source: PlaceRevisionSource;
}

/** The author of a write made by `caller`, through `source`. */
export function revisionAuthor(
  caller: { readonly oxyAccountId: string; readonly operatedByOxyUserId: string | null },
  source: PlaceRevisionSource,
): RevisionAuthor {
  return { oxyAccountId: caller.oxyAccountId, operatedByOxyUserId: caller.operatedByOxyUserId, source };
}

/** One side of a diff: published field paths to their values, `undefined` meaning "no value". */
export type FieldValues = Readonly<Record<string, RevisionValue | undefined>>;

/** A JSON value with object keys sorted, so `jsonb`'s own key order never reads as a change. */
function canonical(value: RevisionValue | undefined): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  ) ?? 'undefined';
}

/** One change from a before and an after, or `null` when they are the same value. */
export function changeOf(
  field: string,
  before: RevisionValue | undefined,
  after: RevisionValue | undefined,
): PlaceRevisionChange | null {
  if (canonical(before) === canonical(after)) return null;
  const change: PlaceRevisionChange = { field };
  if (before !== undefined) change.before = before;
  if (after !== undefined) change.after = after;
  return change;
}

/** Every field whose value differs between two sides, in the order the AFTER side names them. */
export function changesBetween(before: FieldValues, after: FieldValues): PlaceRevisionChange[] {
  const fields = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  return fields.flatMap((field) => {
    const change = changeOf(field, before[field], after[field]);
    return change ? [change] : [];
  });
}

/** The `places` columns a diff reads. */
export type PlaceFieldRow = Pick<
  PlaceRow,
  | 'name'
  | 'latitude'
  | 'longitude'
  | 'geometry'
  | 'categories'
  | 'addressHouseNumber'
  | 'addressStreet'
  | 'addressLocality'
  | 'addressCity'
  | 'addressRegion'
  | 'addressPostalCode'
  | 'addressCountryCode'
  | 'addressCountry'
  | 'addressFormatted'
  | 'contactPhone'
  | 'contactEmail'
  | 'contactWebsite'
  | 'openingHours'
  | 'status'
>;

const json = (value: unknown): RevisionValue | undefined =>
  value === null || value === undefined ? undefined : (value as RevisionValue);

/**
 * A place's own columns as published fields.
 *
 * What a contributor can change on `places` itself, in the contract's names.
 * Verification and the merge pointer are moderation's and are diffed where
 * moderation writes them; authorship is never a field.
 */
export function placeFieldValues(row: PlaceFieldRow): FieldValues {
  return {
    name: row.name,
    location: { latitude: row.latitude, longitude: row.longitude },
    geometry: json(row.geometry),
    categories: row.categories,
    'address.houseNumber': json(row.addressHouseNumber),
    'address.street': json(row.addressStreet),
    'address.locality': json(row.addressLocality),
    'address.city': json(row.addressCity),
    'address.region': json(row.addressRegion),
    'address.postalCode': json(row.addressPostalCode),
    'address.countryCode': json(row.addressCountryCode),
    'address.country': json(row.addressCountry),
    'address.formatted': json(row.addressFormatted),
    'contact.phone': json(row.contactPhone),
    'contact.email': json(row.contactEmail),
    'contact.website': json(row.contactWebsite),
    openingHours: json(row.openingHours),
    status: row.status,
  };
}

/**
 * The field a name is recorded under. Its value is `{ name, source }`: a name
 * has provenance, and a merge moves names from every source.
 */
export function nameField(language: string): string {
  return `names.${language}`;
}

/** The field a capability assertion is recorded under. */
export function capabilityField(key: string): string {
  return `capabilities.${key}`;
}

/** One capability assertion at one tier, as a revision records it. */
export function capabilitySnapshot(row: {
  value: boolean | string | number;
  verification: string;
  observedAt: Date;
}): RevisionValue {
  return { value: row.value, verification: row.verification, observedAt: row.observedAt.toISOString() };
}

/**
 * Record one write. Call it INSIDE the write's transaction, after the write.
 *
 * Exactly one revision per write, even when `changes` is empty — a write that
 * restated what was already there still happened, and "somebody confirmed
 * this" is history too.
 */
export async function recordRevision(
  tx: DatabaseOrTransaction,
  revision: {
    placeId: string;
    action: PlaceRevisionAction;
    author: RevisionAuthor;
    changes: readonly PlaceRevisionChange[];
  },
): Promise<void> {
  await tx.insert(placeRevisions).values({
    placeId: revision.placeId,
    action: revision.action,
    source: revision.author.source,
    oxyAccountId: revision.author.oxyAccountId,
    operatedByOxyUserId: revision.author.operatedByOxyUserId,
    changes: [...revision.changes],
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

const REVISION_COLUMNS = {
  id: placeRevisions.id,
  placeId: placeRevisions.placeId,
  action: placeRevisions.action,
  source: placeRevisions.source,
  oxyAccountId: placeRevisions.oxyAccountId,
  operatedByOxyUserId: placeRevisions.operatedByOxyUserId,
  changes: placeRevisions.changes,
  createdAt: placeRevisions.createdAt,
  position: sql<string>`${placeRevisions.createdAt}::text`,
} as const;

/** A `(createdAt, id)` keyset, NEWEST first: resume strictly before the last revision served. */
function revisionWindow(window: TimeWindow): SQL | undefined {
  return window.after
    ? sql`(${placeRevisions.createdAt}, ${placeRevisions.id}) < (${window.after[0]}::timestamptz, ${window.after[1]})`
    : undefined;
}

/** Who may read the history being listed. */
export type RevisionAudience = 'public' | 'moderation';

/**
 * One window of a place's history, newest first.
 *
 * The PUBLIC audience gets only the actions `@goway/contracts` classifies
 * public, and the mapper below never reads the account or actor columns for
 * it: the absence is structural, not a field deleted after the fact. The
 * MODERATION audience gets every action and both.
 */
export async function listPlaceRevisions(
  db: DatabaseOrTransaction,
  placeId: string,
  audience: 'public',
  window: TimeWindow,
): Promise<Paged<PlaceRevision>[]>;
export async function listPlaceRevisions(
  db: DatabaseOrTransaction,
  placeId: string,
  audience: 'moderation',
  window: TimeWindow,
): Promise<Paged<ModerationPlaceRevision>[]>;
export async function listPlaceRevisions(
  db: DatabaseOrTransaction,
  placeId: string,
  audience: RevisionAudience,
  window: TimeWindow,
): Promise<Paged<PlaceRevision | ModerationPlaceRevision>[]> {
  const actions = audience === 'public' ? PUBLIC_PLACE_REVISION_ACTIONS : PLACE_REVISION_ACTIONS;
  const rows = await db
    .select(REVISION_COLUMNS)
    .from(placeRevisions)
    .where(and(eq(placeRevisions.placeId, placeId), inArray(placeRevisions.action, [...actions]), revisionWindow(window)))
    .orderBy(desc(placeRevisions.createdAt), desc(placeRevisions.id))
    .limit(window.limit);

  return rows.map((row) => {
    // `action` and `source` are CHECK-constrained to the contract's tuples.
    const revision: PlaceRevision = {
      id: row.id,
      placeId: row.placeId,
      action: row.action as PlaceRevisionAction,
      source: row.source as PlaceRevisionSource,
      changes: row.changes,
      createdAt: row.createdAt.toISOString(),
    };
    if (audience === 'public') return { item: revision, position: [row.position, row.id] };
    const moderated: ModerationPlaceRevision = { ...revision, oxyAccountId: row.oxyAccountId };
    if (row.operatedByOxyUserId !== null) moderated.operatedByOxyUserId = row.operatedByOxyUserId;
    return { item: moderated, position: [row.position, row.id] };
  });
}
