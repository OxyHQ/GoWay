/**
 * The external worker's contract, as the backend reads and writes it.
 *
 * ## Internal, and deliberately not in `@goway/contracts`
 *
 * These are the JOB shapes: SQS envelopes, input manifests, events and results.
 * They name object keys, capture asset ids, position priors and worker ids —
 * every one of which `AGENTS.md` keeps out of the public SDK. So they live in
 * the backend, and the canonical definition is the set of JSON fixtures in
 * `packages/reconstruction-worker/contract/fixtures/`. This module's test parses
 * every one of those files, and the worker's pydantic models are tested against
 * the same files, so the TypeScript and Python halves cannot drift silently.
 *
 * ## Strict where the backend trusts, permissive where it only stores
 *
 * The worker is GoWay's own code but runs on an external machine and reaches
 * the backend only through SQS and S3. Everything it reports is therefore
 * PARSED, never cast: a missing field, an unknown failure class or a frame id
 * the backend never issued is a refusal rather than a row. Free-text fields the
 * worker sends (`detail`, `workerId`) are length-bounded so a runaway message
 * cannot become a runaway column.
 *
 * Objects are not `.strict()`: an additive field a newer worker emits must not
 * dead-letter every event an older backend reads. `schemaVersion` is the switch
 * for a change that is not additive.
 */

import { z } from 'zod';
import { CAPTURE_PROJECTIONS, STREET_SCENE_ASSET_ROLES, STREET_SCENE_PROFILES } from '@goway/contracts';

export const WORKER_CONTRACT_SCHEMA_VERSION = 1;

const schemaVersion = z.literal(WORKER_CONTRACT_SCHEMA_VERSION);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lower-case hex SHA-256 digest');
const instant = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'must be an ISO 8601 instant');
const objectKey = z
  .string()
  .min(1)
  .max(1024)
  .refine((key) => !key.startsWith('/') && !key.split('/').includes('..'), 'must be a relative object key');
const jobId = z.uuid();
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

/**
 * The stages a worker reports. They double as the job's running states, so a
 * heartbeat moves a job from `leased` to `training` without a translation table.
 */
export const WORKER_STAGES = [
  'preparing',
  'privacy',
  'matching',
  'solving',
  'georeferencing',
  'training',
  'optimizing',
  'uploading',
  'validating',
] as const;
export type WorkerStage = (typeof WORKER_STAGES)[number];

/** Failure classes. See `docs/STREET3D_PIPELINE.md` → Failure classes. */
export const WORKER_FAILURE_CODES = [
  'insufficient_overlap',
  'camera_solve_failed',
  'georeference_failed',
  'privacy_failed',
  'out_of_memory',
  'corrupt_input',
  'quality_failed',
  'worker_interrupted',
  'cancelled',
  'internal',
] as const;
export type WorkerFailureCode = (typeof WORKER_FAILURE_CODES)[number];

/**
 * The classes the BACKEND retries. The worker's own `retryable` flag is
 * advisory: whether GPU time is spent again is a backend decision, and only a
 * transient fault earns it. `insufficient_overlap` in particular never retries
 * — the same inputs will not overlap better on a second attempt.
 */
export const RETRYABLE_FAILURE_CODES: ReadonlySet<WorkerFailureCode> = new Set([
  'out_of_memory',
  'worker_interrupted',
  'internal',
]);

/**
 * A perspective view cut from a 360° panorama: which panorama of the capture
 * (0 for a photo, the keyframe for a video), the view's yaw from the
 * panorama's centre (degrees, clockwise) and its horizontal field of view.
 * Reported by the privacy worker per derivative and handed back to the solve
 * in the manifest, which uses it to treat the views of one panorama as a rig.
 */
export const panoramaViewSchema = z.object({
  index: nonNegativeInt,
  yawDegrees: z.number().min(0).lt(360),
  horizontalFovDegrees: z.number().gt(0).lt(180),
});
export type PanoramaView = z.infer<typeof panoramaViewSchema>;

/** Absent from a party that predates 360° captures, for which everything is perspective. */
const projection = z.enum(CAPTURE_PROJECTIONS).default('perspective');

// ── Job envelopes (backend → SQS jobs queue) ───────────────────────────────

export const keyframeSettingsSchema = z.object({
  maxFrames: positiveInt,
  minIntervalSeconds: z.number().positive(),
  maxLongEdgePixels: positiveInt,
});

export const capturePrivacyJobSchema = z.object({
  schemaVersion,
  jobId,
  jobType: z.literal('capture_privacy'),
  issuedAt: instant,
  assetId: z.string().min(1),
  mediaKind: z.enum(['photo', 'video']),
  input: z.object({
    key: objectKey,
    contentType: z.string().min(1),
    byteSize: positiveInt,
    sha256,
  }),
  outputPrefix: objectKey,
  keyframes: keyframeSettingsSchema,
  /** The DECLARED projection. The worker verifies it against the media and fails closed. */
  projection,
});
export type CapturePrivacyJob = z.infer<typeof capturePrivacyJobSchema>;

export const sceneReconstructJobSchema = z.object({
  schemaVersion,
  jobId,
  jobType: z.literal('scene_reconstruct'),
  issuedAt: instant,
  sceneId: z.string().min(1),
  sceneVersion: positiveInt,
  profile: z.enum(STREET_SCENE_PROFILES),
  inputManifestKey: objectKey,
  inputManifestSha256: sha256,
  outputPrefix: objectKey,
});
export type SceneReconstructJob = z.infer<typeof sceneReconstructJobSchema>;

export const jobEnvelopeSchema = z.discriminatedUnion('jobType', [capturePrivacyJobSchema, sceneReconstructJobSchema]);
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

// ── Input manifest (backend → S3 jobs/<jobId>/input.json) ──────────────────

export const manifestFrameSchema = z.object({
  frameId: z.string().min(1),
  captureAssetId: z.string().min(1),
  imageKey: objectKey,
  imageSha256: sha256,
  maskKey: objectKey.optional(),
  maskSha256: sha256.optional(),
  width: positiveInt,
  height: positiveInt,
  privacyPipelineVersion: z.string().min(1),
  /** Opaque per job. Never a session id, never a user id. */
  sequenceGroup: z.string().min(1).max(64),
  sequenceIndex: nonNegativeInt,
  capturedAt: instant.optional(),
  /**
   * The position prior. Needed by the solve and the georeference; it never
   * appears in any published shape.
   */
  prior: z.object({
    latitude,
    longitude,
    altitudeMeters: z.number().optional(),
    accuracyMeters: z.number().nonnegative().optional(),
    headingDegrees: z.number().min(0).lt(360).optional(),
  }),
  camera: z.object({ focalLength35mm: z.number().positive().optional() }).optional(),
  panorama: panoramaViewSchema.optional(),
});
export type ManifestFrame = z.infer<typeof manifestFrameSchema>;

export const budgetsSchema = z.object({
  maxTrainingIterations: positiveInt,
  maxGaussians: positiveInt,
  maxAssetBytes: positiveInt,
  maxTrainingLongEdgePixels: positiveInt,
});

export const gatesSchema = z.object({
  minRegisteredFrames: nonNegativeInt,
  minRegistrationRatio: z.number().min(0).max(1),
  maxMeanReprojectionErrorPx: z.number().positive(),
  minGeoreferenceInliers: nonNegativeInt,
  maxMedianGeoreferenceResidualMeters: z.number().positive(),
  minHeldOutPsnr: z.number().nonnegative(),
});

export const sceneInputManifestSchema = z.object({
  schemaVersion,
  jobId,
  sceneId: z.string().min(1),
  sceneVersion: positiveInt,
  profile: z.enum(STREET_SCENE_PROFILES),
  anchor: z.object({ latitude, longitude }),
  radiusMeters: z.number().positive(),
  frames: z.array(manifestFrameSchema).min(1),
  budgets: budgetsSchema,
  gates: gatesSchema,
});
export type SceneInputManifest = z.infer<typeof sceneInputManifestSchema>;

// ── Events (worker → SQS events queue) ─────────────────────────────────────

const objectReferenceSchema = z.object({ key: objectKey, sha256, byteSize: positiveInt });

const eventBase = {
  schemaVersion,
  eventId: z.uuid(),
  jobId,
  attempt: positiveInt,
  workerId: z.string().min(1).max(64),
  at: instant,
};

export const heartbeatEventSchema = z.object({
  ...eventBase,
  type: z.literal('heartbeat'),
  stage: z.enum(WORKER_STAGES).optional(),
  progress: z.number().min(0).max(1).optional(),
  leaseExpiresAt: instant.optional(),
});

export const completedEventSchema = z.object({
  ...eventBase,
  type: z.literal('completed'),
  result: objectReferenceSchema,
});

export const failedEventSchema = z.object({
  ...eventBase,
  type: z.literal('failed'),
  stage: z.enum(WORKER_STAGES).optional(),
  failure: z.object({
    code: z.enum(WORKER_FAILURE_CODES),
    retryable: z.boolean(),
    /** Sanitized and short. Stored truncated; never logged. */
    detail: z.string().max(2000).optional(),
  }),
  result: objectReferenceSchema.optional(),
});

export const workerEventSchema = z.discriminatedUnion('type', [
  heartbeatEventSchema,
  completedEventSchema,
  failedEventSchema,
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;

// ── Results (worker → S3, referenced by a `completed` event) ───────────────

export const privacyFrameSchema = z.object({
  frameIndex: nonNegativeInt,
  imageKey: objectKey,
  imageSha256: sha256,
  imageByteSize: positiveInt,
  maskKey: objectKey.optional(),
  maskSha256: sha256.optional(),
  maskByteSize: positiveInt.optional(),
  width: positiveInt,
  height: positiveInt,
  detections: z.record(z.string(), nonNegativeInt).optional(),
  maskedFraction: z.number().min(0).max(1).optional(),
  sharpness: z.number().nonnegative().optional(),
  panorama: panoramaViewSchema.optional(),
});
export type PrivacyFrame = z.infer<typeof privacyFrameSchema>;

export const capturePrivacyResultSchema = z
  .object({
    schemaVersion,
    jobId,
    jobType: z.literal('capture_privacy'),
    attempt: positiveInt,
    assetId: z.string().min(1),
    verdict: z.enum(['passed', 'failed']),
    privacyPipelineVersion: z.string().min(1).max(120),
    /** The projection the worker VERIFIED. The backend compares it with the declaration. */
    projection,
    models: z.array(z.object({ name: z.string().min(1), version: z.string().min(1), sha256 })),
    metadataStripped: z.boolean(),
    frames: z.array(privacyFrameSchema),
    rejectedFrames: nonNegativeInt,
  })
  .refine(
    // Fail closed: a pass must carry frames and stripped metadata. A pass with
    // no frames or with surviving metadata is not a pass this backend accepts.
    (result) => result.verdict === 'failed' || (result.frames.length > 0 && result.metadataStripped),
    { message: 'a passed verdict requires frames and stripped metadata', path: ['verdict'] },
  )
  .refine((result) => new Set(result.frames.map((frame) => frame.frameIndex)).size === result.frames.length, {
    message: 'frame indexes must be unique',
    path: ['frames'],
  })
  .refine(
    // A panorama is only ever reported as views, and a view only for a panorama.
    (result) => result.frames.every((frame) => (frame.panorama !== undefined) === (result.projection === 'equirectangular')),
    { message: 'panorama views must match the verified projection', path: ['frames'] },
  );
export type CapturePrivacyResult = z.infer<typeof capturePrivacyResultSchema>;

const sceneAssetSchema = z.object({
  role: z.enum(STREET_SCENE_ASSET_ROLES),
  format: z.enum(['spz', 'jpeg']),
  key: objectKey,
  sha256,
  byteSize: positiveInt,
  contentType: z.string().min(1).max(120),
  gaussians: positiveInt.optional(),
});
export type SceneResultAsset = z.infer<typeof sceneAssetSchema>;

const finiteNumber = z.number().refine(Number.isFinite, 'must be finite');
const sceneVector = z.tuple([finiteNumber, finiteNumber, finiteNumber]);

/** The most capture viewpoints one result may report. The backend decimates further before storing. */
export const MAX_RESULT_VIEWPOINTS = 2000;

/**
 * A solved camera position and facing, in scene coordinates (metric ENU, z
 * up). `forward` is approximately unit length. Internal input to the published
 * navigation, which is decimated and reordered before it is stored.
 */
const sceneViewpointSchema = z.object({ position: sceneVector, forward: sceneVector });
export type SceneResultViewpoint = z.infer<typeof sceneViewpointSchema>;

const captureFieldOfViewSchema = z.object({
  horizontalDegrees: z.number().min(1).max(179),
  verticalDegrees: z.number().min(1).max(179),
});

export const sceneReconstructResultSchema = z.object({
  schemaVersion,
  jobId,
  jobType: z.literal('scene_reconstruct'),
  attempt: positiveInt,
  sceneId: z.string().min(1),
  sceneVersion: positiveInt,
  profile: z.enum(STREET_SCENE_PROFILES),
  inputManifestSha256: sha256,
  worldTransform: z.object({
    anchor: z.object({ latitude, longitude, altitudeMeters: finiteNumber }),
    frame: z.literal('enu'),
    enuFromScene: z.array(finiteNumber).length(16),
  }),
  bounds: z
    .object({ west: longitude, south: latitude, east: longitude, north: latitude })
    .refine((box) => box.south <= box.north, 'south must not be north of north'),
  footprint: z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([longitude, latitude])).min(4)).min(1),
  }),
  frames: z.object({
    input: nonNegativeInt,
    registered: nonNegativeInt,
    registeredFrameIds: z.array(z.string().min(1)),
  }),
  edges: z.array(z.object({ a: z.string().min(1), b: z.string().min(1), inliers: positiveInt })),
  metrics: z
    .object({
      registrationRatio: z.number().min(0).max(1),
      meanReprojectionErrorPx: z.number().nonnegative(),
      georeferenceInliers: nonNegativeInt,
      medianGeoreferenceResidualMeters: z.number().nonnegative(),
      heldOutPsnr: z.number(),
      gaussians: nonNegativeInt.optional(),
      gpuSeconds: z.number().nonnegative().optional(),
      wallSeconds: z.number().nonnegative().optional(),
      inputBytesDownloaded: z.number().nonnegative().optional(),
      cacheHitRatio: z.number().min(0).max(1).optional(),
      outputBytes: z.number().nonnegative().optional(),
    })
    .catchall(finiteNumber),
  gates: z.object({ passed: z.boolean(), failures: z.array(z.string().max(200)) }),
  assets: z.array(sceneAssetSchema),
  initialView: z.object({ position: sceneVector, target: sceneVector }),
  /** Optional: a worker that predates guided navigation omits both. */
  viewpoints: z.array(sceneViewpointSchema).max(MAX_RESULT_VIEWPOINTS).optional(),
  captureFieldOfView: captureFieldOfViewSchema.optional(),
  observedFrom: instant,
  observedTo: instant,
  provenance: z.object({
    pipelineVersion: z.string().min(1).max(120),
    privacyPipelineVersions: z.array(z.string().min(1)).min(1),
    components: z.record(z.string(), z.string().max(200)),
    inputs: z.array(z.object({ frameId: z.string().min(1), imageSha256: sha256 })),
  }),
});
export type SceneReconstructResult = z.infer<typeof sceneReconstructResultSchema>;
