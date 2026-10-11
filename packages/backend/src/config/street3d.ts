/**
 * Street 3D reconstruction configuration, parsed ONCE at module load.
 *
 * ## Inert unless configured, and never a boot dependency of the map
 *
 * Kept out of `src/config/index.ts` for the same reason capture and routing
 * are: the core parse refuses to start the process, and Street 3D must not have
 * that power over the map. Every variable here is optional. With none set:
 *
 *   - the scheduler never starts (`STREET3D_SCHEDULER_ENABLED` defaults false);
 *   - the public Street 3D read API answers `service_unavailable` / `not_found`
 *     (`STREET3D_VIEWING_ENABLED` defaults false);
 *   - `/ready` does not consult a single value here — an SQS outage, a missing
 *     bucket or an external worker that has been offline for a week changes
 *     nothing about whether the map, Places, search and routing can serve.
 *
 * A value that is PRESENT and malformed (a queue URL that is not a URL, a
 * threshold of `-3`) still fails the parse, naming every variable, exactly as
 * `config/capture.ts` does: a deployment that set something wrong should learn
 * it at boot, not on the first tick hours later.
 *
 * ## Thresholds are policy, and the worker receives them as DATA
 *
 * The quality gates and the per-profile budgets are written into every input
 * manifest (`budgets`, `gates`), so the external worker never compiles a
 * threshold in and a change here applies to the next job without a worker
 * release. The backend re-checks the same gates when a result comes back, so a
 * worker that reported `passed` against a laxer reading cannot publish.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { STREET_SCENE_PROFILES, type StreetSceneProfile } from '@goway/contracts';
import type { EnvironmentSource } from './index';

loadDotenv();

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const booleanFlag = z.preprocess((value) => {
  const normalized = emptyAsUndefined(value);
  if (normalized === undefined) return undefined;
  const text = String(normalized).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return normalized;
}, z.boolean().default(false));

const integer = (fallback: number, minimum: number, maximum: number) =>
  z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(minimum).max(maximum).default(fallback),
  );

const decimal = (fallback: number, minimum: number, maximum: number) =>
  z.preprocess(emptyAsUndefined, z.coerce.number().min(minimum).max(maximum).default(fallback));

/** An `https://` URL, or `http://` for a local emulator. Never with credentials. */
const serviceUrl = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .trim()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
        );
      } catch {
        return false;
      }
    }, 'must be an http(s) URL without credentials')
    .optional(),
);

const bucketName = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be an S3 bucket name')
    .optional(),
);

const keyPrefix = (fallback: string) =>
  z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9/_-]*[a-z0-9]$|^[a-z0-9]$/, 'must be a simple key prefix')
      .default(fallback),
  );

/**
 * The per-profile reconstruction budgets, written verbatim into the manifest.
 *
 * Defaults: `draft` is the fast, bounded first pass the fixture describes;
 * `standard` is the normal published budget. Both are ceilings the worker must
 * stay under, and the backend refuses a result whose splat exceeds its own
 * `maxAssetBytes` regardless of what the worker reports.
 */
const DEFAULT_BUDGETS: Readonly<Record<StreetSceneProfile, Street3dBudgets>> = {
  draft: {
    maxTrainingIterations: 7000,
    maxGaussians: 1_500_000,
    maxAssetBytes: 60_000_000,
    maxTrainingLongEdgePixels: 1600,
  },
  standard: {
    maxTrainingIterations: 30_000,
    maxGaussians: 3_000_000,
    maxAssetBytes: 150_000_000,
    maxTrainingLongEdgePixels: 2048,
  },
};

export interface Street3dBudgets {
  maxTrainingIterations: number;
  maxGaussians: number;
  maxAssetBytes: number;
  maxTrainingLongEdgePixels: number;
}

export interface Street3dGates {
  minRegisteredFrames: number;
  minRegistrationRatio: number;
  maxMeanReprojectionErrorPx: number;
  minGeoreferenceInliers: number;
  maxMedianGeoreferenceResidualMeters: number;
  minHeldOutPsnr: number;
}

const budgetSchema = (profile: StreetSceneProfile) =>
  z.object({
    maxTrainingIterations: integer(DEFAULT_BUDGETS[profile].maxTrainingIterations, 100, 1_000_000),
    maxGaussians: integer(DEFAULT_BUDGETS[profile].maxGaussians, 1000, 100_000_000),
    maxAssetBytes: integer(DEFAULT_BUDGETS[profile].maxAssetBytes, 1_000_000, 4_000_000_000),
    maxTrainingLongEdgePixels: integer(
      DEFAULT_BUDGETS[profile].maxTrainingLongEdgePixels,
      256,
      8192,
    ),
  });

const schema = z.object({
  schedulerEnabled: booleanFlag,
  schedulerIntervalSeconds: integer(60, 10, 3600),
  viewingEnabled: booleanFlag,

  /** Region of the queues, the scene bucket and the temporary bucket's own region fallback. */
  region: z.preprocess(emptyAsUndefined, z.string().trim().min(1).optional()),
  jobsQueueUrl: serviceUrl,
  eventsQueueUrl: serviceUrl,
  /** The jobs queue's dead-letter queue. Optional: read for `status` and to fail dead-lettered jobs. */
  jobsDeadLetterQueueUrl: serviceUrl,
  /** An explicit SQS endpoint for a local emulator; absent means the queue URL's own origin. */
  sqsEndpoint: serviceUrl,

  sceneBucket: bucketName,
  sceneKeyPrefix: keyPrefix('scenes'),
  /** An explicit S3 endpoint for the scene bucket, for a local store. */
  sceneEndpoint: serviceUrl,
  /** Public origin (and optional path) the scene bucket is served from, e.g. a CDN. */
  publicAssetBaseUrl: serviceUrl,
  cdnDistributionId: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{8,32}$/, 'must be a CloudFront distribution id')
      .optional(),
  ),

  // ── Scheduling ──────────────────────────────────────────────────────────
  clusterRadiusMeters: decimal(90, 10, 1000),
  minEligibleFrames: integer(12, 2, 10_000),
  /** Distinct 45° heading sectors required when the frames report headings at all. */
  minHeadingSectors: integer(2, 1, 8),
  /** New frames, versus the last queued job, that justify another reconstruction. */
  rebuildMinNewFrames: integer(8, 1, 10_000),
  /** New frames, versus a job still waiting for the worker, that justify superseding it. */
  supersedeMinNewFrames: integer(24, 1, 10_000),
  defaultProfile: z.preprocess(emptyAsUndefined, z.enum(STREET_SCENE_PROFILES).default('draft')),
  atRiskWindowDays: integer(14, 1, 180),
  rescueExtensionDays: integer(30, 1, 180),
  /** A raw photo stays this long after its privacy-safe derivative exists, for audit. */
  rawAuditWindowDays: integer(3, 0, 90),
  privacyMaxAttempts: integer(3, 1, 20),
  jobMaxAttempts: integer(4, 1, 20),
  heartbeatStaleSeconds: integer(1800, 60, 86_400),
  /** Bounded protection a job holds on its inputs, refreshed by heartbeats. */
  inputProtectionHours: integer(48, 1, 720),
  /** A derivative expiring within this window is not put into a new manifest. */
  jobWindowHours: integer(72, 1, 720),
  /** `jobs/` artifacts of finished jobs are deleted after this many days. */
  jobArtifactRetentionDays: integer(7, 1, 90),
  privacyBatchSize: integer(50, 1, 1000),
  eventBatchSize: integer(100, 1, 1000),
  eventWaitSeconds: integer(1, 0, 20),
  maxResultBytes: integer(1024 * 1024, 1024, 16 * 1024 * 1024),

  // ── Privacy job settings ────────────────────────────────────────────────
  keyframeMaxFrames: integer(60, 1, 1000),
  keyframeMinIntervalSeconds: decimal(0.5, 0.05, 60),
  keyframeMaxLongEdgePixels: integer(2048, 256, 8192),

  // ── Quality gates ───────────────────────────────────────────────────────
  gateMinRegisteredFrames: integer(8, 2, 10_000),
  gateMinRegistrationRatio: decimal(0.5, 0, 1),
  gateMaxMeanReprojectionErrorPx: decimal(2.0, 0.01, 100),
  gateMinGeoreferenceInliers: integer(5, 0, 10_000),
  gateMaxMedianGeoreferenceResidualMeters: decimal(8.0, 0.01, 1000),
  gateMinHeldOutPsnr: decimal(17.0, 0, 100),
  /** Alignment residual at or under which a scene is presented as `precise`. */
  precisePlacementResidualMeters: decimal(3.0, 0.01, 1000),

  draftBudgets: budgetSchema('draft'),
  standardBudgets: budgetSchema('standard'),

  // ── Coverage ────────────────────────────────────────────────────────────
  coverageCellPrecision: integer(7, 5, 8),
  coverageMaxSpanDegrees: decimal(0.5, 0.01, 10),
});

type Parsed = z.infer<typeof schema>;

export type Street3dConfig = Readonly<Parsed> & {
  /** Whether queues and both buckets are configured, so jobs can actually run. */
  readonly pipelineConfigured: boolean;
  readonly budgets: Readonly<Record<StreetSceneProfile, Street3dBudgets>>;
  readonly gates: Readonly<Street3dGates>;
};

/**
 * Parse `source` into a {@link Street3dConfig}.
 *
 * @throws {Error} Naming every variable that failed, not just the first.
 */
export function parseStreet3dConfig(source: EnvironmentSource = process.env): Street3dConfig {
  const budget = (profile: 'DRAFT' | 'STANDARD') => ({
    maxTrainingIterations: source[`STREET3D_${profile}_MAX_TRAINING_ITERATIONS`],
    maxGaussians: source[`STREET3D_${profile}_MAX_GAUSSIANS`],
    maxAssetBytes: source[`STREET3D_${profile}_MAX_ASSET_BYTES`],
    maxTrainingLongEdgePixels: source[`STREET3D_${profile}_MAX_TRAINING_LONG_EDGE_PIXELS`],
  });
  const result = schema.safeParse({
    schedulerEnabled: source.STREET3D_SCHEDULER_ENABLED,
    schedulerIntervalSeconds: source.STREET3D_SCHEDULER_INTERVAL_SECONDS,
    viewingEnabled: source.STREET3D_VIEWING_ENABLED,
    region: source.STREET3D_AWS_REGION ?? source.AWS_REGION ?? source.CAPTURE_S3_REGION,
    jobsQueueUrl: source.STREET3D_JOBS_QUEUE_URL,
    eventsQueueUrl: source.STREET3D_EVENTS_QUEUE_URL,
    jobsDeadLetterQueueUrl: source.STREET3D_JOBS_DLQ_URL,
    sqsEndpoint: source.STREET3D_SQS_ENDPOINT,
    sceneBucket: source.STREET3D_SCENE_BUCKET,
    sceneKeyPrefix: source.STREET3D_SCENE_KEY_PREFIX,
    sceneEndpoint: source.STREET3D_SCENE_S3_ENDPOINT,
    publicAssetBaseUrl: source.STREET3D_PUBLIC_ASSET_BASE_URL,
    cdnDistributionId: source.STREET3D_CDN_DISTRIBUTION_ID,
    clusterRadiusMeters: source.STREET3D_CLUSTER_RADIUS_METERS,
    minEligibleFrames: source.STREET3D_MIN_ELIGIBLE_FRAMES,
    minHeadingSectors: source.STREET3D_MIN_HEADING_SECTORS,
    rebuildMinNewFrames: source.STREET3D_REBUILD_MIN_NEW_FRAMES,
    supersedeMinNewFrames: source.STREET3D_SUPERSEDE_MIN_NEW_FRAMES,
    defaultProfile: source.STREET3D_DEFAULT_PROFILE,
    atRiskWindowDays: source.STREET3D_AT_RISK_WINDOW_DAYS,
    rescueExtensionDays: source.STREET3D_RESCUE_EXTENSION_DAYS,
    rawAuditWindowDays: source.STREET3D_RAW_AUDIT_WINDOW_DAYS,
    privacyMaxAttempts: source.STREET3D_PRIVACY_MAX_ATTEMPTS,
    jobMaxAttempts: source.STREET3D_JOB_MAX_ATTEMPTS,
    heartbeatStaleSeconds: source.STREET3D_HEARTBEAT_STALE_SECONDS,
    inputProtectionHours: source.STREET3D_INPUT_PROTECTION_HOURS,
    jobWindowHours: source.STREET3D_JOB_WINDOW_HOURS,
    jobArtifactRetentionDays: source.STREET3D_JOB_ARTIFACT_RETENTION_DAYS,
    privacyBatchSize: source.STREET3D_PRIVACY_BATCH_SIZE,
    eventBatchSize: source.STREET3D_EVENT_BATCH_SIZE,
    eventWaitSeconds: source.STREET3D_EVENT_WAIT_SECONDS,
    maxResultBytes: source.STREET3D_MAX_RESULT_BYTES,
    keyframeMaxFrames: source.STREET3D_KEYFRAME_MAX_FRAMES,
    keyframeMinIntervalSeconds: source.STREET3D_KEYFRAME_MIN_INTERVAL_SECONDS,
    keyframeMaxLongEdgePixels: source.STREET3D_KEYFRAME_MAX_LONG_EDGE_PIXELS,
    gateMinRegisteredFrames: source.STREET3D_GATE_MIN_REGISTERED_FRAMES,
    gateMinRegistrationRatio: source.STREET3D_GATE_MIN_REGISTRATION_RATIO,
    gateMaxMeanReprojectionErrorPx: source.STREET3D_GATE_MAX_MEAN_REPROJECTION_ERROR_PX,
    gateMinGeoreferenceInliers: source.STREET3D_GATE_MIN_GEOREFERENCE_INLIERS,
    gateMaxMedianGeoreferenceResidualMeters:
      source.STREET3D_GATE_MAX_MEDIAN_GEOREFERENCE_RESIDUAL_METERS,
    gateMinHeldOutPsnr: source.STREET3D_GATE_MIN_HELD_OUT_PSNR,
    precisePlacementResidualMeters: source.STREET3D_PRECISE_PLACEMENT_RESIDUAL_METERS,
    draftBudgets: budget('DRAFT'),
    standardBudgets: budget('STANDARD'),
    coverageCellPrecision: source.STREET3D_COVERAGE_CELL_PRECISION,
    coverageMaxSpanDegrees: source.STREET3D_COVERAGE_MAX_SPAN_DEGREES,
  });

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid Street 3D configuration:\n${problems}\n\n` +
        'See the STREET3D_* block in packages/backend/.env.example. Leaving every ' +
        'STREET3D_* variable unset is valid: the feature is then inert and the rest ' +
        'of the API is unaffected.',
    );
  }

  const parsed = result.data;
  return {
    ...parsed,
    pipelineConfigured:
      parsed.region !== undefined &&
      parsed.jobsQueueUrl !== undefined &&
      parsed.eventsQueueUrl !== undefined &&
      parsed.sceneBucket !== undefined &&
      parsed.publicAssetBaseUrl !== undefined,
    budgets: { draft: parsed.draftBudgets, standard: parsed.standardBudgets },
    gates: {
      minRegisteredFrames: parsed.gateMinRegisteredFrames,
      minRegistrationRatio: parsed.gateMinRegistrationRatio,
      maxMeanReprojectionErrorPx: parsed.gateMaxMeanReprojectionErrorPx,
      minGeoreferenceInliers: parsed.gateMinGeoreferenceInliers,
      maxMedianGeoreferenceResidualMeters: parsed.gateMaxMedianGeoreferenceResidualMeters,
      minHeldOutPsnr: parsed.gateMinHeldOutPsnr,
    },
  };
}

/** The one Street 3D parse for this process. */
export const street3dConfig: Street3dConfig = parseStreet3dConfig();
