/**
 * Closed value sets that are INTERNAL to the backend.
 *
 * Every set the API publishes — place status, verification state, capability
 * verification, claim role and claim state, and the duplicate-candidate and
 * report vocabularies the moderation surface reads — is declared once in
 * `@goway/contracts` and imported from there by both the schema and the
 * SDK, so the public contract, the TypeScript union and the database CHECK
 * cannot drift apart. Nothing in that family belongs in this file.
 *
 * What is here is the vocabulary of GoWay's own MACHINERY, which is
 * deliberately not public: object storage state is how bytes are being managed
 * rather than anything a contributor can act on. Publishing it would freeze an
 * object-storage strategy into an SDK contract that a better implementation
 * could not change.
 */

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

// ── Street 3D reconstruction (#11–#16) ──────────────────────────────────────
//
// The job, scene and derivative machinery is INTERNAL. What a viewer may see is
// `@goway/contracts/street3d` (manifests, coverage areas, reports); the
// states below are how the backend gets there, and publishing them would freeze
// the scheduler's design into an SDK contract.

/** The two job kinds. A privacy pass over one capture, or one scene version. */
export const STREET3D_JOB_KINDS = ['capture_privacy', 'scene_reconstruct'] as const;
export type Street3dJobKind = (typeof STREET3D_JOB_KINDS)[number];

/**
 * Where a job is.
 *
 * `queued` → (`leased` → one of the worker's stages)* → `completed`, with
 * `retry_wait` between attempts and `failed`/`cancelled` as the other two
 * terminal states. The stage names are the worker's own (see
 * `street3d/workerContract.ts`), so a heartbeat moves a job between them
 * without a translation table.
 */
export const STREET3D_JOB_STATES = [
  'queued',
  'leased',
  'preparing',
  'privacy',
  'matching',
  'solving',
  'georeferencing',
  'training',
  'optimizing',
  'uploading',
  'validating',
  'completed',
  'retry_wait',
  'failed',
  'cancelled',
] as const;
export type Street3dJobState = (typeof STREET3D_JOB_STATES)[number];

/** States in which a job is finished and accepts no further event. */
export const STREET3D_TERMINAL_JOB_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly Street3dJobState[];

/** States in which the external worker holds the job and must heartbeat. */
export const STREET3D_RUNNING_JOB_STATES = [
  'leased',
  'preparing',
  'privacy',
  'matching',
  'solving',
  'georeferencing',
  'training',
  'optimizing',
  'uploading',
  'validating',
] as const satisfies readonly Street3dJobState[];

/**
 * Where a scene is.
 *
 * `candidate` has overlapping eligible captures but has not been queued;
 * `needs_more_capture` and `failed_quality` are what the last attempt found
 * when nothing is published; `published` has a current version; `disabled` is
 * a moderation decision about the whole scene.
 */
export const STREET3D_SCENE_STATES = [
  'candidate',
  'queued',
  'reconstructing',
  'needs_more_capture',
  'failed_quality',
  'published',
  'disabled',
] as const;
export type Street3dSceneState = (typeof STREET3D_SCENE_STATES)[number];

/** Where one version of a scene is. Exactly one per scene may be `published`. */
export const STREET3D_SCENE_VERSION_STATES = [
  'validating',
  'failed_quality',
  'published',
  'superseded',
  'disabled',
] as const;
export type Street3dSceneVersionState = (typeof STREET3D_SCENE_VERSION_STATES)[number];

/**
 * Where a derivative's bytes are. As `capture_media_objects`, minus `expected`:
 * a derivative row is written only after the worker reported its bytes.
 */
export const DERIVATIVE_STORAGE_STATES = ['stored', 'deleting', 'deleted'] as const;
export type DerivativeStorageState = (typeof DERIVATIVE_STORAGE_STATES)[number];
