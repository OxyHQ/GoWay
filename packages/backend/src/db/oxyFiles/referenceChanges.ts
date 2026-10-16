/**
 * The outbox of reference changes GoWay owes Oxy (`oxy_file_reference_changes`).
 *
 * Nothing here talks to Oxy: `oxy/fileReferences` delivers. A change is
 * ENQUEUED inside the transaction of the write that caused it, so the two
 * commit or roll back together — a withdrawn photo cannot keep its reference
 * because the process died between the commit and the call.
 *
 * ## Claiming
 *
 * A due change is claimed by pushing its `nextAttemptAt` past the attempt's
 * lease and counting the attempt, in one short transaction with `FOR UPDATE
 * SKIP LOCKED` — so the HTTP call holds no transaction, two tasks never
 * deliver one change at once, and a task that dies mid-attempt only delays it
 * by the lease.
 *
 * ## One file's changes go in order
 *
 * A change is claimable only while no OLDER pending change names the same
 * file: a gallery item merged A→B and then B→C must reach Oxy as A→B before
 * B→C, or a retried first move would leave B's reference behind. A `dead`
 * change does not block — it waits for an operator, and the next change is
 * already the newer truth.
 */

import { and, asc, eq, inArray, lt, lte, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { qualified, type SelectedRow } from '@oxy.so/db';
import type { OxyFileReferencesPolicy } from '../../config/oxyFileReferences';
import type { Database, DatabaseOrTransaction } from '../postgres';
import { oxyFileReferenceChanges } from '../schema';
import type { OxyFileReferenceEntityType } from '../schema/valueSets';

/** One change to enqueue. */
export type FileReferenceChange =
  | {
      readonly action: 'add' | 'remove';
      readonly fileId: string;
      readonly entityType: OxyFileReferenceEntityType;
      readonly entityId: string;
    }
  | {
      readonly action: 'move';
      readonly fileId: string;
      readonly entityType: OxyFileReferenceEntityType;
      readonly fromEntityId: string;
      readonly entityId: string;
    };

const CHANGE_COLUMNS = {
  id: oxyFileReferenceChanges.id,
  action: oxyFileReferenceChanges.action,
  oxyFileId: oxyFileReferenceChanges.oxyFileId,
  entityType: oxyFileReferenceChanges.entityType,
  entityId: oxyFileReferenceChanges.entityId,
  fromEntityId: oxyFileReferenceChanges.fromEntityId,
  state: oxyFileReferenceChanges.state,
  attempts: oxyFileReferenceChanges.attempts,
  nextAttemptAt: oxyFileReferenceChanges.nextAttemptAt,
  lastFailure: oxyFileReferenceChanges.lastFailure,
  createdAt: oxyFileReferenceChanges.createdAt,
} as const;

export type FileReferenceChangeRow = SelectedRow<typeof CHANGE_COLUMNS>;

/**
 * Queue `changes`, in order, on `db` — the caller's transaction whenever the
 * change belongs to a write. Returns their ids, for an immediate delivery.
 */
export async function enqueueFileReferenceChanges(
  db: DatabaseOrTransaction,
  changes: readonly FileReferenceChange[],
): Promise<string[]> {
  if (changes.length === 0) return [];
  const rows = await db
    .insert(oxyFileReferenceChanges)
    .values(
      changes.map((change) => ({
        action: change.action,
        oxyFileId: change.fileId,
        entityType: change.entityType,
        entityId: change.entityId,
        fromEntityId: change.action === 'move' ? change.fromEntityId : null,
      })),
    )
    .returning({ id: oxyFileReferenceChanges.id });
  return rows.map((row) => row.id);
}

/**
 * Claim up to `limit` due pending changes — or, with `ids`, those of them that
 * are due — for one attempt each. Oldest first.
 */
export async function claimFileReferenceChanges(
  db: Database,
  now: Date,
  policy: OxyFileReferencesPolicy,
  options: { limit: number; ids?: readonly string[] },
): Promise<FileReferenceChangeRow[]> {
  if (options.ids?.length === 0) return [];
  return db.transaction(async (tx) => {
    // Correlated: the outer row's columns are qualified, or they would bind to `earlier`.
    const earlier = alias(oxyFileReferenceChanges, 'earlier');
    const olderPending = tx
      .select({ one: sql`1` })
      .from(earlier)
      .where(
        and(
          eq(earlier.oxyFileId, qualified(oxyFileReferenceChanges.oxyFileId)),
          eq(earlier.state, 'pending'),
          lt(earlier.id, qualified(oxyFileReferenceChanges.id)),
        ),
      );
    const due = await tx
      .select({ id: oxyFileReferenceChanges.id })
      .from(oxyFileReferenceChanges)
      .where(
        and(
          eq(oxyFileReferenceChanges.state, 'pending'),
          lte(oxyFileReferenceChanges.nextAttemptAt, now),
          notExists(olderPending),
          options.ids ? inArray(oxyFileReferenceChanges.id, [...options.ids]) : undefined,
        ),
      )
      .orderBy(asc(oxyFileReferenceChanges.id))
      .limit(options.limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(oxyFileReferenceChanges)
      .set({
        attempts: sql`${oxyFileReferenceChanges.attempts} + 1`,
        nextAttemptAt: new Date(now.getTime() + policy.attemptLeaseSeconds * 1000),
        updatedAt: now,
      })
      .where(
        inArray(
          oxyFileReferenceChanges.id,
          due.map((row) => row.id),
        ),
      )
      .returning(CHANGE_COLUMNS)
      .then((rows) => rows.sort((a, b) => (a.id < b.id ? -1 : 1)));
  });
}

/** A delivered change is gone. */
export async function completeFileReferenceChange(db: Database, id: string): Promise<void> {
  await db.delete(oxyFileReferenceChanges).where(eq(oxyFileReferenceChanges.id, id));
}

/** The delay before attempt `attempts + 1`, in milliseconds. */
export function retryDelayMs(attempts: number, policy: OxyFileReferencesPolicy): number {
  const seconds = Math.min(
    policy.retryBaseSeconds * 2 ** Math.max(0, attempts - 1),
    policy.retryMaxSeconds,
  );
  return seconds * 1000;
}

/**
 * Record a failed attempt: retried after the backoff, or `dead` once the
 * attempts are spent. Says which.
 */
export async function failFileReferenceChange(
  db: Database,
  change: FileReferenceChangeRow,
  failure: string,
  now: Date,
  policy: OxyFileReferencesPolicy,
): Promise<'retrying' | 'dead'> {
  const dead = change.attempts >= policy.maxAttempts;
  await db
    .update(oxyFileReferenceChanges)
    .set({
      state: dead ? 'dead' : 'pending',
      lastFailure: failure.slice(0, 120),
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(change.attempts, policy)),
      updatedAt: now,
    })
    .where(eq(oxyFileReferenceChanges.id, change.id));
  return dead ? 'dead' : 'retrying';
}

/** How the outbox stands, for an operator. */
export interface FileReferenceOutboxStatus {
  readonly pending: number;
  readonly dead: number;
  /** The oldest pending change's age, in seconds; `null` when none is pending. */
  readonly oldestPendingSeconds: number | null;
}

export async function fileReferenceOutboxStatus(
  db: Database,
  now: Date,
): Promise<FileReferenceOutboxStatus> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${oxyFileReferenceChanges.state} = 'pending')::int`,
      dead: sql<number>`count(*) filter (where ${oxyFileReferenceChanges.state} = 'dead')::int`,
      oldestPending: sql<Date | null>`min(${oxyFileReferenceChanges.createdAt}) filter (where ${oxyFileReferenceChanges.state} = 'pending')`,
    })
    .from(oxyFileReferenceChanges);
  const oldest = row?.oldestPending ? new Date(row.oldestPending) : null;
  return {
    pending: row?.pending ?? 0,
    dead: row?.dead ?? 0,
    oldestPendingSeconds: oldest
      ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000))
      : null,
  };
}

/** Dead changes, oldest first. */
export async function listDeadFileReferenceChanges(
  db: Database,
  limit: number,
): Promise<FileReferenceChangeRow[]> {
  return db
    .select(CHANGE_COLUMNS)
    .from(oxyFileReferenceChanges)
    .where(eq(oxyFileReferenceChanges.state, 'dead'))
    .orderBy(asc(oxyFileReferenceChanges.id))
    .limit(limit);
}

/**
 * Put dead changes back in the queue with fresh attempts — the named ones, or
 * every one. Returns how many.
 */
export async function retryDeadFileReferenceChanges(
  db: Database,
  now: Date,
  ids?: readonly string[],
): Promise<number> {
  const rows = await db
    .update(oxyFileReferenceChanges)
    .set({ state: 'pending', attempts: 0, nextAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(oxyFileReferenceChanges.state, 'dead'),
        ids ? inArray(oxyFileReferenceChanges.id, [...ids]) : undefined,
      ),
    )
    .returning({ id: oxyFileReferenceChanges.id });
  return rows.length;
}
