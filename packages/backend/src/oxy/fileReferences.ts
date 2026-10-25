/**
 * GoWay's Oxy file references, delivered durably and reconciled nightly
 * (Oxy ADR 0043 D4, D6).
 *
 * Every reference GoWay holds is made and removed with GoWay's OWN service
 * token (`OxyServer#assets.references`, Oxy ADR 0049), never
 * a person's session — see `oxy/placeFiles` for why. Adding one to a gallery
 * is synchronous (`placeFiles.attach`: the answer decides whether the item is
 * recorded at all). Every other change — a withdrawal, the rollback of an add,
 * a merge moving a gallery to the surviving place — is written to the outbox
 * (`db/oxyFiles/referenceChanges`) in the transaction of the write that caused
 * it and delivered here:
 *
 *  - {@link FileReferenceWorker.deliver} right after that write commits, so a
 *    withdrawal reaches Oxy at once when Oxy answers;
 *  - {@link FileReferenceWorker.drain} from the in-process loop
 *    ({@link startFileReferenceWorker}), every `drainIntervalSeconds`, for
 *    whatever is due: retries with doubling backoff, merges, and anything a
 *    crashed task left claimed. After `maxAttempts` a change is `dead`, logged
 *    at `error`, and waits for an operator (`bun run oxy-references:admin`).
 *
 * A move adds the new reference before removing the old, so the file is never
 * unreferenced in between; both calls are idempotent, so a move retried after
 * its add succeeded is harmless.
 *
 * ## Reconciliation, the net
 *
 * {@link FileReferenceWorker.reconcile} sends Oxy the full inventory of
 * `place` references — every gallery item not withdrawn, under the place that
 * shows it — and Oxy adds the missing ones and removes the stale ones. The
 * loop starts one when the last began `reconcileEveryHours` ago, as a DRY RUN
 * while `OXY_FILE_REFERENCES_POLICY.reconcileDryRun` holds; each run is
 * logged in `oxy_file_reference_reconciliations` with Oxy's counts. A real run
 * also re-points items moved by a merge before merges moved references.
 */

import {
  OxyApiError,
  type ServiceFileReference,
  type ServiceFileReferenceResult,
  type ServiceReferenceInventoryItem,
  type ServiceReferenceReconcileResult,
} from '@oxy.so/core';
import { OxyServer, type WorkloadCredentialProvider } from '@oxy.so/core/server';
import { workloadCredentials } from './workload';
import {
  OXY_FILE_REFERENCES_POLICY,
  type OxyFileReferencesPolicy,
} from '../config/oxyFileReferences';
import {
  claimFileReferenceChanges,
  completeFileReferenceChange,
  failFileReferenceChange,
  type FileReferenceChangeRow,
} from '../db/oxyFiles/referenceChanges';
import {
  alignReferencedPlaces,
  closeReconciliation,
  openReconciliation,
  placeReferenceInventory,
} from '../db/oxyFiles/reconciliations';
import type { Database } from '../db/postgres';
import type { OxyFileReferenceEntityType } from '../db/schema/valueSets';

/** GoWay's own references: `OxyServer#assets.references`, on GoWay's service identity. */
export interface OxyFileReferences {
  add(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  remove(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  reconcile(
    entityType: string,
    items: AsyncIterable<ServiceReferenceInventoryItem>,
    options: { dryRun?: boolean },
  ): Promise<ServiceReferenceReconcileResult>;
}

/** One question to Oxy may take this long, in milliseconds — as the caller's checks. */
const OXY_REFERENCE_TIMEOUT_MS = 5_000;
/** A reconciliation's pages and commit may take this long each, in milliseconds. */
const OXY_RECONCILE_TIMEOUT_MS = 120_000;

/**
 * GoWay's references client. Adds and removes go out once, bounded at five
 * seconds: the SDK would retry a DELETE with backoff by default, holding a
 * withdrawal's `204`, and the outbox retries anyway. A reconciliation keeps
 * the SDK's retries (its pages are idempotent) and gets a long bound: Oxy
 * diffs the whole inventory in its commit.
 *
 * GoWay holds no Oxy key pair: in a deployment the token is the ECS task
 * role's attested workload identity (Oxy ADR 0049), whose live binding names
 * the GoWay application and environment. The injected credential provider
 * also supports development roles and the test suite's fake Oxy.
 */
export function createOxyFileReferences(options: {
  baseURL: string;
  workloadCredentials?: WorkloadCredentialProvider;
}): OxyFileReferences {
  const once = new OxyServer({
    baseURL: options.baseURL,
    enableRetry: false,
    requestTimeout: OXY_REFERENCE_TIMEOUT_MS,
    workloadCredentials: options.workloadCredentials ?? workloadCredentials,
  }).assets.references;
  const patient = new OxyServer({
    baseURL: options.baseURL,
    requestTimeout: OXY_RECONCILE_TIMEOUT_MS,
    workloadCredentials: options.workloadCredentials ?? workloadCredentials,
  }).assets.references;
  return { add: once.add, remove: once.remove, reconcile: patient.reconcile };
}

/** Logs ids, counts and failure classes — never a file's metadata or an error message. */
export interface FileReferenceLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface FileReferenceWorkerDeps {
  /** Read at each call: the worker is built before Postgres connects. */
  getDb: () => Database;
  references: OxyFileReferences;
  policy?: OxyFileReferencesPolicy;
  now?: () => Date;
  logger?: FileReferenceLogger;
}

export interface DeliverySummary {
  readonly delivered: number;
  readonly retrying: number;
  readonly dead: number;
}

export type ReconcileSummary =
  | {
      readonly status: 'committed';
      readonly dryRun: boolean;
      readonly sent: number;
      readonly result: ServiceReferenceReconcileResult;
      readonly aligned: number;
    }
  | { readonly status: 'failed'; readonly dryRun: boolean; readonly failure: string }
  /** Another run is open, or (when only due runs were asked for) the last is recent. */
  | { readonly status: 'skipped' };

export interface FileReferenceWorker {
  /** Try these queued changes now, if due; what fails stays queued. Never throws. */
  deliver(ids: readonly string[]): Promise<DeliverySummary>;
  /** Deliver one batch of whatever is due. */
  drain(): Promise<DeliverySummary>;
  /** Reconcile every entity type GoWay references from. */
  reconcile(options: { dryRun: boolean; onlyIfDue: boolean }): Promise<ReconcileSummary>;
}

/** The entity types GoWay reconciles, each with the inventory it sends. */
const PLACE: OxyFileReferenceEntityType = 'place';

/** An HTTP status or an error class: never a message, which may carry a URL or a token. */
export function failureOf(error: unknown): string {
  if (error instanceof OxyApiError) return `http_${String(error.status)}`;
  return error instanceof Error ? error.name : 'Error';
}

export function createFileReferenceWorker(deps: FileReferenceWorkerDeps): FileReferenceWorker {
  const policy = deps.policy ?? OXY_FILE_REFERENCES_POLICY;
  const clock = deps.now ?? (() => new Date());
  const { references } = deps;

  async function apply(change: FileReferenceChangeRow): Promise<void> {
    const reference = (entityId: string): ServiceFileReference => ({
      fileId: change.oxyFileId,
      entityType: change.entityType,
      entityId,
    });
    // Every per-item answer is final: `not_found` on an add is a file that is
    // gone or no longer public, on a remove a reference Oxy does not hold.
    if (change.action === 'add') {
      await references.add([reference(change.entityId)]);
    } else if (change.action === 'remove') {
      await references.remove([reference(change.entityId)]);
    } else {
      // A move: the new reference first, so the file is never unreferenced.
      await references.add([reference(change.entityId)]);
      if (change.fromEntityId !== null && change.fromEntityId !== change.entityId) {
        await references.remove([reference(change.fromEntityId)]);
      }
    }
  }

  async function run(claimed: FileReferenceChangeRow[]): Promise<DeliverySummary> {
    const db = deps.getDb();
    let delivered = 0;
    let retrying = 0;
    let dead = 0;
    for (const change of claimed) {
      try {
        await apply(change);
      } catch (error) {
        const failure = failureOf(error);
        const outcome = await failFileReferenceChange(db, change, failure, clock(), policy);
        if (outcome === 'dead') {
          dead += 1;
          deps.logger?.error(
            { changeId: change.id, action: change.action, attempts: change.attempts, failure },
            'Oxy file reference change dead-lettered; see `bun run oxy-references:admin`',
          );
        } else {
          retrying += 1;
          deps.logger?.warn(
            { changeId: change.id, action: change.action, attempts: change.attempts, failure },
            'Oxy file reference change failed; retrying with backoff',
          );
        }
        continue;
      }
      await completeFileReferenceChange(db, change.id);
      delivered += 1;
    }
    return { delivered, retrying, dead };
  }

  return {
    async deliver(ids) {
      try {
        const claimed = await claimFileReferenceChanges(deps.getDb(), clock(), policy, {
          limit: ids.length,
          ids,
        });
        return await run(claimed);
      } catch (error) {
        // Queued, so not lost: the loop delivers it.
        deps.logger?.warn({ failure: failureOf(error) }, 'Immediate reference delivery failed');
        return { delivered: 0, retrying: 0, dead: 0 };
      }
    },

    async drain() {
      const claimed = await claimFileReferenceChanges(deps.getDb(), clock(), policy, {
        limit: policy.drainBatch,
      });
      return run(claimed);
    },

    async reconcile({ dryRun, onlyIfDue }) {
      const db = deps.getDb();
      const runId = await openReconciliation(db, PLACE, {
        dryRun,
        onlyIfDue,
        now: clock(),
        policy,
      });
      if (runId === null) return { status: 'skipped' };
      let sent = 0;
      async function* counted() {
        for await (const item of placeReferenceInventory(db)) {
          sent += 1;
          yield item;
        }
      }
      try {
        const result = await references.reconcile(PLACE, counted(), { dryRun });
        const aligned = dryRun ? 0 : await alignReferencedPlaces(db);
        await closeReconciliation(
          db,
          runId,
          {
            sent,
            added: result.added,
            removed: result.removed,
            unchanged: result.unchanged,
            refused: result.refused,
          },
          clock(),
        );
        deps.logger?.info(
          {
            entityType: PLACE,
            dryRun,
            sent,
            added: result.added,
            removed: result.removed,
            unchanged: result.unchanged,
            refused: result.refused,
            aligned,
          },
          'Oxy file references reconciled',
        );
        return { status: 'committed', dryRun, sent, result, aligned };
      } catch (error) {
        const failure = failureOf(error);
        await closeReconciliation(db, runId, { sent, failure }, clock());
        deps.logger?.error(
          { entityType: PLACE, dryRun, failure },
          'Oxy file reconciliation failed',
        );
        return { status: 'failed', dryRun, failure };
      }
    },
  };
}

/**
 * Start the in-process loop: drain the outbox every `drainIntervalSeconds`,
 * and start the nightly reconciliation when it is due. Returns a stop
 * function. Iterations never overlap within a process; across processes the
 * claim and the open-run index keep them apart. Never a readiness dependency.
 */
export function startFileReferenceWorker(
  worker: FileReferenceWorker,
  options: { policy?: OxyFileReferencesPolicy; logger?: FileReferenceLogger } = {},
): () => void {
  const policy = options.policy ?? OXY_FILE_REFERENCES_POLICY;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const loop = async () => {
    if (stopped) return;
    try {
      // Drain until a batch comes back short, so a backlog does not wait a tick per batch.
      for (;;) {
        const summary = await worker.drain();
        const handled = summary.delivered + summary.retrying + summary.dead;
        if (stopped || handled < policy.drainBatch) break;
      }
      if (!stopped) await worker.reconcile({ dryRun: policy.reconcileDryRun, onlyIfDue: true });
    } catch (error) {
      options.logger?.error({ failure: failureOf(error) }, 'Oxy file reference loop failed');
    }
    if (!stopped) {
      timer = setTimeout(() => void loop(), policy.drainIntervalSeconds * 1000);
      timer.unref();
    }
  };
  timer = setTimeout(() => void loop(), 1000);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
