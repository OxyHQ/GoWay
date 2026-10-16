/**
 * GoWay's side of its Oxy file references (Oxy ADR 0043 D4, D6).
 *
 * Oxy holds the references themselves (`file_references`); GoWay holds only
 * what it still owes Oxy and what its reconciliations found:
 *
 *  - `oxy_file_reference_changes` — the OUTBOX. A reference change that must
 *    not be lost (a withdrawal, a merge moving a gallery) is written here in
 *    the same transaction as the write that caused it, then delivered with
 *    GoWay's service token by `oxy/fileReferences`, retried with backoff, and
 *    left `dead` for an operator when it keeps failing. A delivered change is
 *    deleted.
 *  - `oxy_file_reference_reconciliations` — one row per reconciliation run:
 *    when, whether it was a dry run, and Oxy's counts. A partial unique index
 *    lets only one run per entity type be open at a time, across every task.
 *
 * Neither table has a foreign key to `place_media` or `places`: a change
 * outlives the item it is about (that is the point of a withdrawal), and the
 * file id is Oxy's.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { closedSet, foreignServiceId } from './columns';
import {
  OXY_FILE_REFERENCE_ACTIONS,
  OXY_FILE_REFERENCE_CHANGE_STATES,
  OXY_FILE_REFERENCE_ENTITY_TYPES,
} from './valueSets';

export const oxyFileReferenceChanges = pgTable(
  'oxy_file_reference_changes',
  {
    /** uuidv7: ordered by creation, which is the order one file's changes are delivered in. */
    id: generatedId(),
    action: text().notNull(),
    /** The Oxy file. A foreign service's id: no foreign key. */
    oxyFileId: foreignServiceId().notNull(),
    entityType: text().notNull(),
    /** The entity referenced: added, removed, or — for a move — moved TO. */
    entityId: foreignServiceId().notNull(),
    /** A move's source. Set exactly when `action` is `move`. */
    fromEntityId: foreignServiceId(),
    state: text().notNull().default('pending'),
    /** Delivery attempts started, including one in flight. */
    attempts: integer().notNull().default(0),
    /** When it may next be tried; pushed forward while an attempt holds it. */
    nextAttemptAt: timestamptz().notNull().defaultNow(),
    /** Why the last attempt failed: an HTTP status or an error class. Never a message. */
    lastFailure: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('oxy_file_reference_changes_action_check', table.action, OXY_FILE_REFERENCE_ACTIONS),
    closedSet(
      'oxy_file_reference_changes_entity_type_check',
      table.entityType,
      OXY_FILE_REFERENCE_ENTITY_TYPES,
    ),
    closedSet(
      'oxy_file_reference_changes_state_check',
      table.state,
      OXY_FILE_REFERENCE_CHANGE_STATES,
    ),
    check(
      'oxy_file_reference_changes_move_check',
      sql`(${table.action} = 'move') = (${table.fromEntityId} is not null)`,
    ),
    check('oxy_file_reference_changes_attempts_check', sql`${table.attempts} >= 0`),
    index('oxy_file_reference_changes_due_idx').on(table.state, table.nextAttemptAt),
    index('oxy_file_reference_changes_file_idx').on(table.oxyFileId, table.id),
  ],
);

export const oxyFileReferenceReconciliations = pgTable(
  'oxy_file_reference_reconciliations',
  {
    id: generatedId(),
    entityType: text().notNull(),
    dryRun: boolean().notNull(),
    startedAt: timestamptz().notNull().defaultNow(),
    /** `null` while running. */
    finishedAt: timestamptz(),
    /** Oxy's counts (`ServiceReferenceReconcileResult`); `null` unless it committed. */
    added: integer(),
    removed: integer(),
    unchanged: integer(),
    refused: integer(),
    /** Pairs GoWay sent. */
    sent: integer(),
    /** Why it failed: an HTTP status or an error class. Never a message. */
    failure: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet(
      'oxy_file_reference_reconciliations_entity_type_check',
      table.entityType,
      OXY_FILE_REFERENCE_ENTITY_TYPES,
    ),
    /** One open run per entity type — Oxy allows one, and two tasks must not both start one. */
    uniqueIndex('oxy_file_reference_reconciliations_open_idx')
      .on(table.entityType)
      .where(sql`${table.finishedAt} is null`),
    index('oxy_file_reference_reconciliations_recent_idx').on(table.entityType, table.startedAt),
  ],
);
