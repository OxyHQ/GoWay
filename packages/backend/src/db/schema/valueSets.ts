/**
 * Closed value sets that are INTERNAL to the backend.
 *
 * Every set the API publishes — place status, verification state, capability
 * verification, claim role and claim state — is declared once in
 * `@goway/shared-types` and imported from there by both the schema and the
 * SDK, so the public contract, the TypeScript union and the database CHECK
 * cannot drift apart. Nothing in that family belongs in this file.
 *
 * What is here is the vocabulary of GoWay's own MACHINERY, which is
 * deliberately not public: duplicate candidates are review state rather than a
 * place fact, and object storage state is how bytes are being managed rather
 * than anything a contributor can act on. Publishing either would freeze a
 * strategy — matching, or object storage — into an SDK contract that a better
 * implementation could not change.
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

/**
 * Where an object's BYTES are, as distinct from what the contribution means.
 *
 * Internal, and it must stay internal: the published contract already tells a
 * contributor everything they can act on through {@link CaptureAssetState} and
 * the object's lifecycle. This set is the storage machine's own vocabulary, and
 * publishing it would freeze GoWay's object-store strategy into an SDK
 * contract that a different store could not satisfy.
 *
 * `expected` is the state that makes an ORPHAN detectable. The row is written
 * before the bytes exist, so an object in the store with no row is a leak the
 * sweeper can see, and a row that never leaves `expected` past its upload
 * window is an abandoned upload rather than an invisible nothing. A store with
 * no such record can only ever be reconciled by listing the whole bucket.
 *
 * `deleting` exists so deletion is IDEMPOTENT across a crash: intent is
 * recorded before the delete call and the tombstone after it, so a sweeper that
 * dies mid-delete resumes rather than either re-deleting blindly or losing the
 * fact that it meant to.
 */
export const CAPTURE_OBJECT_STORAGE_STATES = ['expected', 'stored', 'deleting', 'deleted'] as const;
export type CaptureObjectStorageState = (typeof CAPTURE_OBJECT_STORAGE_STATES)[number];

/**
 * What a storage budget is measured over.
 *
 * `geo_cell` is a PREFIX of the internal geographic bucketing key, so one row
 * can cap a whole city or one square of pavement depending on how many
 * characters the key carries — which is what "do not let one heavily
 * photographed tourist location consume unbounded raw storage" needs, without a
 * second table for each granularity.
 *
 * Internal because the bucketing key itself is internal: #11 must stay free to
 * change how captures are bucketed for retrieval without breaking a published
 * shape.
 */
export const CAPTURE_BUDGET_SCOPES = ['global', 'contributor', 'geo_cell'] as const;
export type CaptureBudgetScope = (typeof CAPTURE_BUDGET_SCOPES)[number];
