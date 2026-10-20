/**
 * How GoWay delivers its Oxy file references and reconciles them (Oxy ADR
 * 0043 D4, D6; `oxy/fileReferences`).
 *
 * Policy, in code, like every threshold here (`AGENTS.md`: tuning is a
 * constant, and there is no feature on/off variable). In particular
 * {@link OXY_FILE_REFERENCES_POLICY.reconcileDryRun} is the switch between a
 * nightly reconciliation that only REPORTS what it would change and one that
 * changes it: turning it off is a reviewed one-line change, made once a dry
 * run's counts have been read. `bun run oxy-references:admin reconcile
 * --apply` runs one real reconciliation on demand meanwhile.
 */

export interface OxyFileReferencesPolicy {
  /** How often the outbox is drained (and a due reconciliation started), in seconds. */
  readonly drainIntervalSeconds: number;
  /** Changes claimed per drain. */
  readonly drainBatch: number;
  /** How long one attempt holds a change before another task may retry it, in seconds. */
  readonly attemptLeaseSeconds: number;
  /** First retry delay, in seconds; it doubles per failed attempt. */
  readonly retryBaseSeconds: number;
  /** The longest retry delay, in seconds. */
  readonly retryMaxSeconds: number;
  /** Attempts before a change is `dead` and waits for an operator. */
  readonly maxAttempts: number;
  /** A reconciliation is started when the last one began at least this long ago, in hours. */
  readonly reconcileEveryHours: number;
  /** An open reconciliation older than this is abandoned (a task died mid-run), in hours. */
  readonly reconcileAbandonAfterHours: number;
  /** Nightly reconciliations report without changing anything while this is `true`. */
  readonly reconcileDryRun: boolean;
}

export const OXY_FILE_REFERENCES_POLICY: OxyFileReferencesPolicy = {
  drainIntervalSeconds: 30,
  drainBatch: 50,
  attemptLeaseSeconds: 120,
  retryBaseSeconds: 30,
  retryMaxSeconds: 6 * 60 * 60,
  // 30 s doubling to 6 h: about a day of attempts before an operator is needed.
  maxAttempts: 14,
  reconcileEveryHours: 24,
  reconcileAbandonAfterHours: 3,
  reconcileDryRun: true,
};
