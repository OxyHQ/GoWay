/**
 * Street 3D reconstruction configuration, parsed ONCE at module load.
 *
 * ## On when configured, and never a boot dependency of the map
 *
 * Kept out of `src/config/index.ts` for the same reason capture and routing
 * are: the core parse refuses to start the process, and Street 3D must not have
 * that power over the map. Every variable here is optional, and none is an
 * on/off switch:
 *
 *   - the public Street 3D read API is always on: it serves what is published,
 *     which is nothing until a scene is;
 *   - the scheduler runs in the server whenever the pipeline is configured —
 *     the queues, the scene bucket, its public origin and the temporary capture
 *     bucket (`pipelineConfigured` plus `config/capture.ts`) — and not
 *     otherwise;
 *   - `/ready` does not consult a single value here — an SQS outage, a missing
 *     bucket or an external worker that has been offline for a week changes
 *     nothing about whether the map, Places, search and routing can serve.
 *
 * A value that is PRESENT and malformed (a queue URL that is not a URL) still
 * fails the parse, naming every variable, exactly as `config/capture.ts` does:
 * a deployment that set something wrong should learn it at boot, not on the
 * first tick hours later.
 *
 * ## Thresholds are policy, in code, and the worker receives them as DATA
 *
 * The scheduling rules, quality gates and per-profile budgets are
 * {@link STREET3D_POLICY}: constants, reviewed with the code that reads them,
 * never per-deployment configuration. The gates and budgets are written into
 * every input manifest (`budgets`, `gates`), so the external worker never
 * compiles a threshold in and a change here applies to the next job without a
 * worker release. The backend re-checks the same gates when a result comes
 * back, so a worker that reported `passed` against a laxer reading cannot
 * publish.
 */

import { z } from 'zod';
import type { StreetSceneProfile } from '@goway/contracts';
import type { EnvironmentSource } from './index';

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

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

export interface Street3dPolicy {
  schedulerIntervalSeconds: number;
  sceneKeyPrefix: string;
  clusterRadiusMeters: number;
  minEligibleFrames: number;
  minHeadingSectors: number;
  rebuildMinNewFrames: number;
  supersedeMinNewFrames: number;
  defaultProfile: StreetSceneProfile;
  atRiskWindowDays: number;
  rescueExtensionDays: number;
  rawAuditWindowDays: number;
  privacyMaxAttempts: number;
  jobMaxAttempts: number;
  heartbeatStaleSeconds: number;
  inputProtectionHours: number;
  jobWindowHours: number;
  jobArtifactRetentionDays: number;
  privacyBatchSize: number;
  eventBatchSize: number;
  eventWaitSeconds: number;
  maxResultBytes: number;
  keyframeMaxFrames: number;
  keyframeMinIntervalSeconds: number;
  keyframeMaxLongEdgePixels: number;
  gates: Street3dGates;
  precisePlacementResidualMeters: number;
  budgets: Record<StreetSceneProfile, Street3dBudgets>;
  coverageCellPrecision: number;
  coverageMaxSpanDegrees: number;
}

/**
 * Street 3D's policy: how often the scheduler ticks, when a scene is formed,
 * how hard a job may try, what a published scene must pass and what it may
 * cost. Constants on purpose — a threshold is changed in a reviewed commit,
 * not in a task definition.
 */
export const STREET3D_POLICY: Street3dPolicy = {
  /** How often the in-process scheduler ticks. `bun run street3d:tick` runs one tick instead. */
  schedulerIntervalSeconds: 60,
  /** The key prefix published scene assets land under in the scene bucket. */
  sceneKeyPrefix: 'scenes',

  // ── Scheduling: a scene is queued only on information gain (`street3d/formation.ts`)
  clusterRadiusMeters: 90,
  minEligibleFrames: 12,
  /** Distinct 45° heading sectors required when the frames report headings at all. */
  minHeadingSectors: 2,
  /** New frames, versus the last queued job, that justify another reconstruction. */
  rebuildMinNewFrames: 8,
  /** New frames, versus a job still waiting for the worker, that justify superseding it. */
  supersedeMinNewFrames: 24,
  defaultProfile: 'draft',
  atRiskWindowDays: 14,
  rescueExtensionDays: 30,
  /** A raw photo stays this long after its privacy-safe derivative exists, for audit. */
  rawAuditWindowDays: 3,
  privacyMaxAttempts: 3,
  jobMaxAttempts: 4,
  heartbeatStaleSeconds: 1800,
  /** Bounded protection a job holds on its inputs, refreshed by heartbeats. */
  inputProtectionHours: 48,
  /** A derivative expiring within this window is not put into a new manifest. */
  jobWindowHours: 72,
  /** `jobs/` artifacts of finished jobs are deleted after this many days. */
  jobArtifactRetentionDays: 7,
  privacyBatchSize: 50,
  eventBatchSize: 100,
  eventWaitSeconds: 1,
  maxResultBytes: 1024 * 1024,

  // ── Privacy job settings, sent in every capture_privacy envelope
  /**
   * A video's keyframes tile its WHOLE length: one per `minIntervalSeconds`,
   * up to `maxFrames` (wider windows beyond), so a 10-minute walk gets one
   * every 2.5 s rather than its first 30 s. At most 600, the worker's own bound.
   */
  keyframeMaxFrames: 240,
  keyframeMinIntervalSeconds: 0.5,
  /** A phone photo (4032 px) keeps its resolution; the solve and trainer downscale on their own. */
  keyframeMaxLongEdgePixels: 4096,

  // ── Quality gates, written into every input manifest AND re-checked before publication
  gates: {
    minRegisteredFrames: 8,
    minRegistrationRatio: 0.5,
    maxMeanReprojectionErrorPx: 2.0,
    minGeoreferenceInliers: 5,
    maxMedianGeoreferenceResidualMeters: 8.0,
    minHeldOutPsnr: 17.0,
  },
  /** Alignment residual at or under which a scene is presented as `precise`. */
  precisePlacementResidualMeters: 3.0,

  /**
   * The per-profile reconstruction budgets, written verbatim into the manifest.
   * `draft` is the fast, bounded first pass; `standard` is the normal published
   * budget. Both are ceilings the worker must stay under, and the backend
   * refuses a result whose splat exceeds its own `maxAssetBytes` regardless of
   * what the worker reports.
   */
  budgets: {
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
  },

  // ── Public coverage
  /** Geohash precision of a coverage cell (7 ≈ 150 m). */
  coverageCellPrecision: 7,
  /** The widest box `GET /street3d/coverage` accepts, in degrees. */
  coverageMaxSpanDegrees: 0.5,
};

const schema = z
  .object({
    /** Region of the queues and the scene bucket: the deployment's own (`AWS_REGION`). */
    region: z.preprocess(emptyAsUndefined, z.string().trim().min(1).optional()),
    jobsQueueUrl: serviceUrl,
    eventsQueueUrl: serviceUrl,
    /** The jobs queue's dead-letter queue. Optional: read for `status` and to fail dead-lettered jobs. */
    jobsDeadLetterQueueUrl: serviceUrl,
    /** An explicit SQS endpoint for a local emulator; absent means the queue URL's own origin. */
    sqsEndpoint: serviceUrl,

    sceneBucket: bucketName,
    /** An explicit S3 endpoint for the scene bucket, for a local store. */
    sceneEndpoint: serviceUrl,
    /**
     * A local directory standing in for the scene bucket, for development: an
     * operator's licensed import writes there, and `street3d:serve-assets`
     * serves it at `publicAssetBaseUrl`. Never beside `sceneBucket`.
     */
    sceneLocalDir: z.preprocess(emptyAsUndefined, z.string().trim().min(1).optional()),
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
  })
  .refine((parsed) => !(parsed.sceneBucket && parsed.sceneLocalDir), {
    message: 'set STREET3D_SCENE_BUCKET or STREET3D_SCENE_LOCAL_DIR, not both',
    path: ['sceneLocalDir'],
  });

type Parsed = z.infer<typeof schema>;

export type Street3dConfig = Readonly<Parsed> &
  Readonly<Street3dPolicy> & {
    /** Whether queues and both buckets are configured, so jobs can actually run. */
    readonly pipelineConfigured: boolean;
  };

/**
 * Parse `source` into a {@link Street3dConfig}.
 *
 * @throws {Error} Naming every variable that failed, not just the first.
 */
export function parseStreet3dConfig(source: EnvironmentSource = process.env): Street3dConfig {
  const result = schema.safeParse({
    region: source.AWS_REGION ?? source.CAPTURE_S3_REGION,
    jobsQueueUrl: source.STREET3D_JOBS_QUEUE_URL,
    eventsQueueUrl: source.STREET3D_EVENTS_QUEUE_URL,
    jobsDeadLetterQueueUrl: source.STREET3D_JOBS_DLQ_URL,
    sqsEndpoint: source.STREET3D_SQS_ENDPOINT,
    sceneBucket: source.STREET3D_SCENE_BUCKET,
    sceneEndpoint: source.STREET3D_SCENE_S3_ENDPOINT,
    sceneLocalDir: source.STREET3D_SCENE_LOCAL_DIR,
    publicAssetBaseUrl: source.STREET3D_PUBLIC_ASSET_BASE_URL,
    cdnDistributionId: source.STREET3D_CDN_DISTRIBUTION_ID,
  });

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid Street 3D configuration:\n${problems}\n\n` +
        'See the STREET3D_* block in packages/backend/.env.example. Leaving every ' +
        'STREET3D_* variable unset is valid: viewing then serves what is published ' +
        'and no pipeline runs.',
    );
  }

  const parsed = result.data;
  return {
    ...STREET3D_POLICY,
    ...parsed,
    pipelineConfigured:
      parsed.region !== undefined &&
      parsed.jobsQueueUrl !== undefined &&
      parsed.eventsQueueUrl !== undefined &&
      parsed.sceneBucket !== undefined &&
      parsed.publicAssetBaseUrl !== undefined,
  };
}

/** The one Street 3D parse for this process. */
export const street3dConfig: Street3dConfig = parseStreet3dConfig();
