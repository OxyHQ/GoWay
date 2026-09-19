/**
 * Closed value sets that are INTERNAL to the backend.
 *
 * Every set the API publishes — place status, verification state, capability
 * verification, claim role and claim state — is declared once in
 * `@goway/shared-types` and imported from there by both the schema and the
 * SDK, so the public contract, the TypeScript union and the database CHECK
 * cannot drift apart. Nothing in that family belongs in this file.
 *
 * What is here is the reconciliation vocabulary, which is deliberately NOT
 * public: duplicate candidates are review state, not a place fact, and
 * publishing the reasons would freeze GoWay's matching strategy into an SDK
 * contract that a better matcher could not change.
 */

/**
 * Why two places were flagged as possibly the same place.
 *
 * The set is the whole of the "do not merge on name similarity alone" rule
 * expressed as data. `shared_source_id` is DETERMINISTIC — two GoWay places
 * that both claim the same `(source, sourceId)` are the same real-world record
 * by definition of that source's own identifier — and it is still only a
 * candidate, because deciding which of the two survives is a review, not an
 * inference.
 *
 * `proximity_and_name` requires BOTH: an identical normalized name AND a
 * position within a few tens of metres. Name alone is not on this list and must
 * not be added to it — "Farmacia" matches several thousand real, distinct
 * places in Spain alone, and a merge is not reversible from the outside.
 */
export const DUPLICATE_CANDIDATE_REASONS = [
  'shared_source_id',
  'proximity_and_name',
  'manual_report',
] as const;
export type DuplicateCandidateReason = (typeof DUPLICATE_CANDIDATE_REASONS)[number];

/**
 * Where a duplicate candidate is in review.
 *
 * `open` is the only state this issue's code ever writes. Nothing merges
 * automatically: a candidate is a queue entry for a human or a later reviewed
 * process, which is what keeps a false positive cheap.
 */
export const DUPLICATE_CANDIDATE_STATES = ['open', 'confirmed', 'rejected'] as const;
export type DuplicateCandidateState = (typeof DUPLICATE_CANDIDATE_STATES)[number];
