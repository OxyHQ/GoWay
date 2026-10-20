/**
 * The reconciliation log (`oxy_file_reference_reconciliations`) and the
 * inventory a reconciliation sends (Oxy ADR 0043 D6).
 *
 * Nothing here talks to Oxy: `oxy/fileReferences` runs the reconciliation.
 */

import { and, asc, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import type { SelectedRow } from '@oxy.so/db';
import type { OxyFileReferencesPolicy } from '../../config/oxyFileReferences';
import type { Database } from '../postgres';
import { oxyFileReferenceReconciliations, placeMedia } from '../schema';
import type { OxyFileReferenceEntityType } from '../schema/valueSets';

const RUN_COLUMNS = {
  id: oxyFileReferenceReconciliations.id,
  entityType: oxyFileReferenceReconciliations.entityType,
  dryRun: oxyFileReferenceReconciliations.dryRun,
  startedAt: oxyFileReferenceReconciliations.startedAt,
  finishedAt: oxyFileReferenceReconciliations.finishedAt,
  sent: oxyFileReferenceReconciliations.sent,
  added: oxyFileReferenceReconciliations.added,
  removed: oxyFileReferenceReconciliations.removed,
  unchanged: oxyFileReferenceReconciliations.unchanged,
  refused: oxyFileReferenceReconciliations.refused,
  failure: oxyFileReferenceReconciliations.failure,
} as const;

export type ReconciliationRun = SelectedRow<typeof RUN_COLUMNS>;

/**
 * Open a run for `entityType`, or `null` when one is already open (on any
 * task) or — with `onlyIfDue` — when the last one started within
 * `reconcileEveryHours`. A run left open past `reconcileAbandonAfterHours` is
 * closed as `abandoned` first: its task died, and it must not block every
 * night after.
 */
export async function openReconciliation(
  db: Database,
  entityType: OxyFileReferenceEntityType,
  options: { dryRun: boolean; onlyIfDue: boolean; now: Date; policy: OxyFileReferencesPolicy },
): Promise<string | null> {
  const { now, policy } = options;
  return db.transaction(async (tx) => {
    await tx
      .update(oxyFileReferenceReconciliations)
      .set({ finishedAt: now, failure: 'abandoned', updatedAt: now })
      .where(
        and(
          eq(oxyFileReferenceReconciliations.entityType, entityType),
          isNull(oxyFileReferenceReconciliations.finishedAt),
          lt(
            oxyFileReferenceReconciliations.startedAt,
            new Date(now.getTime() - policy.reconcileAbandonAfterHours * 3_600_000),
          ),
        ),
      );
    if (options.onlyIfDue) {
      const [recent] = await tx
        .select({ id: oxyFileReferenceReconciliations.id })
        .from(oxyFileReferenceReconciliations)
        .where(
          and(
            eq(oxyFileReferenceReconciliations.entityType, entityType),
            gt(
              oxyFileReferenceReconciliations.startedAt,
              new Date(now.getTime() - policy.reconcileEveryHours * 3_600_000),
            ),
          ),
        )
        .limit(1);
      if (recent) return null;
    }
    // The partial unique index refuses a second open run; that is "busy", not an error.
    const [opened] = await tx
      .insert(oxyFileReferenceReconciliations)
      .values({ entityType, dryRun: options.dryRun, startedAt: now })
      .onConflictDoNothing()
      .returning({ id: oxyFileReferenceReconciliations.id });
    return opened?.id ?? null;
  });
}

/** Close a run with Oxy's counts, or with why it failed. */
export async function closeReconciliation(
  db: Database,
  id: string,
  outcome:
    | {
        readonly sent: number;
        readonly added: number;
        readonly removed: number;
        readonly unchanged: number;
        readonly refused: number;
      }
    | { readonly sent: number; readonly failure: string },
  now: Date,
): Promise<void> {
  await db
    .update(oxyFileReferenceReconciliations)
    .set({
      ...outcome,
      ...('failure' in outcome ? { failure: outcome.failure.slice(0, 120) } : {}),
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(oxyFileReferenceReconciliations.id, id));
}

/** The latest runs, newest first. */
export async function recentReconciliations(
  db: Database,
  limit: number,
): Promise<ReconciliationRun[]> {
  return db
    .select(RUN_COLUMNS)
    .from(oxyFileReferenceReconciliations)
    .orderBy(desc(oxyFileReferenceReconciliations.startedAt))
    .limit(limit);
}

/**
 * Every `{ fileId, entityId }` a place gallery uses — each item that is not
 * withdrawn (a hidden one keeps its reference: hiding is reversible), under
 * the place that SHOWS it. Read in keyset pages, never one huge result.
 */
export async function* placeReferenceInventory(
  db: Database,
  pageSize = 1000,
): AsyncGenerator<{ fileId: string; entityId: string }> {
  let after: string | null = null;
  for (;;) {
    const page = await db
      .select({ id: placeMedia.id, fileId: placeMedia.oxyFileId, entityId: placeMedia.placeId })
      .from(placeMedia)
      .where(
        and(ne(placeMedia.state, 'removed'), after === null ? undefined : gt(placeMedia.id, after)),
      )
      .orderBy(asc(placeMedia.id))
      .limit(pageSize);
    for (const row of page) yield { fileId: row.fileId, entityId: row.entityId };
    const last = page.at(-1);
    if (!last || page.length < pageSize) return;
    after = last.id;
  }
}

/**
 * After a REAL reconciliation Oxy references every live item under the place
 * that shows it, so an item still naming an older place — moved by a merge
 * before merges moved references — now names that place too, and its later
 * withdrawal removes the right reference. (A merge since keeps the two equal.)
 * Returns how many rows changed.
 */
export async function alignReferencedPlaces(db: Database): Promise<number> {
  const rows = await db
    .update(placeMedia)
    .set({ oxyLinkPlaceId: sql`${placeMedia.placeId}` })
    .where(and(ne(placeMedia.state, 'removed'), ne(placeMedia.oxyLinkPlaceId, placeMedia.placeId)))
    .returning({ id: placeMedia.id });
  return rows.length;
}
