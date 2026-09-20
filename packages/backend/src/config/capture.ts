/**
 * Street 3D capture configuration, parsed ONCE at module load.
 *
 * Kept OUT of `src/config/index.ts` for the same reason routing is: the core
 * parse there refuses to start the process when a value is wrong, and capture
 * must not have that power. A GoWay deployment with no object store configured
 * still serves the map, Places, search and routing — contribution is one
 * feature, not the product — so "no store configured" is a per-request
 * `service_unavailable` on the upload-intent route rather than a boot failure.
 *
 * ## The retention numbers live here because they are POLICY, not contract
 *
 * #10 is explicit: exact durations must be configuration-driven, not hardcoded
 * throughout the codebase, and they are never a public guarantee. So they are
 * env-overridable defaults in ONE module, the API publishes them as a
 * {@link CaptureUploadPolicy} so a contributor can be told before they submit,
 * and the database enforces a separate, much coarser CEILING
 * (`ABSOLUTE_RETENTION_CEILING_DAYS`) that no configuration can raise. Policy
 * moves; the backstop does not.
 *
 * The defaults are the conservative end of the epic's stated posture: ~90 days
 * for an original photo, far less for raw video, and derived reconstruction
 * inputs outliving the originals they replaced — which is the whole point of
 * deriving them.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import type { CaptureRetentionClass } from '@goway/shared-types';
import type { EnvironmentSource } from './index';

// Type-only import above, so this module does not pull the core configuration
// parse in as a side effect. dotenv never overrides an already-set variable, so
// calling it a second time is free.
loadDotenv();

/**
 * Default retention windows, in days, per capture retention class.
 *
 * A TOTAL `Record<CaptureRetentionClass, number>` rather than a partial map with
 * a fallback: a class added to the tuple in `@goway/shared-types` and forgotten
 * here is a compile error, instead of a new kind of stored object silently
 * inheriting somebody else's window — which is precisely how a temporary store
 * grows a permanent corner.
 *
 * - `raw_photo` 90 days — the long end of the epic's 60–90 day posture, because
 *   a photo's value is that a second contributor may photograph the same
 *   façade weeks later.
 * - `raw_video` 30 days — a video is a DERIVATION SOURCE. Its useful content is
 *   its keyframes, it costs an order of magnitude more per second of coverage
 *   than a photo, and #10 asks for it to go substantially earlier. The
 *   `deletionEligibleAt` below usually retires it long before this.
 * - the derived classes 180 days — they exist BECAUSE they are smaller and
 *   privacy-processed. Expiring them on the originals' schedule would throw
 *   away the cheap thing to keep the expensive one.
 */
const DEFAULT_RETENTION_DAYS: Readonly<Record<CaptureRetentionClass, number>> = {
  raw_photo: 90,
  raw_video: 30,
  extracted_keyframe: 180,
  privacy_safe_proxy: 180,
  thumbnail: 180,
};

/**
 * How long a raw video is protected from the sweeper before its keyframes can
 * retire it, in days.
 *
 * Not "delete as soon as keyframes exist": #10 asks for a short window to
 * validate the upload, complete privacy processing and troubleshoot. Three days
 * is long enough that a failed keyframe extraction can be diagnosed against the
 * original, and short enough that the expensive bytes do not sit for a month.
 */
const DEFAULT_VIDEO_DELETION_ELIGIBLE_DAYS = 3;

/** How long a presigned upload target stays valid, in seconds. */
const DEFAULT_UPLOAD_INTENT_TTL_SECONDS = 900;

/**
 * Ceilings on one contributed file.
 *
 * Both are rollout dials rather than truths, which is why they are published in
 * the upload policy: a client must be able to refuse a file BEFORE a contributor
 * waits through an upload that the API was always going to reject.
 */
const DEFAULT_MAX_PHOTO_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_DURATION_SECONDS = 600;

/**
 * The media types GoWay accepts.
 *
 * Server-side and authoritative — a client's declared content type is a claim,
 * and the presigned target pins it so the stored object cannot be something
 * else. HEIC is here because it is what an iPhone actually produces; leaving it
 * out would make "contribute a photo from your library" fail for most iOS
 * contributors on their first try.
 */
const DEFAULT_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'] as const;
const DEFAULT_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime'] as const;

/**
 * The version of the contribution consent text a new session must accept.
 *
 * A bare string rather than a boolean, because "they consented" is not a fact
 * that survives the text changing. Recorded per session (see
 * `capture_sessions.consent_version`) so what somebody agreed to stays legible
 * afterwards.
 */
const DEFAULT_CONSENT_VERSION = '2026-09-01';

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const positiveInteger = (fallback: number, maximum: number) =>
  z.preprocess(emptyAsUndefined, z.coerce.number().int().min(1).max(maximum).default(fallback));

/** A comma- or whitespace-separated media-type list. */
const mediaTypeList = (fallback: readonly string[]) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return [...fallback];
      if (Array.isArray(value)) return value;
      return String(value)
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    },
    z.array(z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/, 'must be a media type')).min(1),
  );

/**
 * A retention window in days.
 *
 * Bounded ABOVE by 365 rather than left open, and the bound is not cosmetic: a
 * typo in a task definition is the most likely way a "temporary" store acquires
 * a permanent corner, and a configuration that a human reviewed is still a
 * configuration. The database's own ceiling sits above this at 400 days and is
 * the part no environment variable can move.
 */
const retentionDays = (fallback: number) => positiveInteger(fallback, 365);

/** `s3://`-free: a bucket NAME, because the scheme, region and endpoint are separate knobs. */
const bucketName = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be an S3 bucket name')
  .optional();

const schema = z.object({
  /** The bucket contributed media is written to. Absent means contribution is unavailable. */
  bucket: z.preprocess(emptyAsUndefined, bucketName),
  region: z.preprocess(emptyAsUndefined, z.string().trim().min(1).optional()),
  /**
   * An explicit S3 endpoint, for a non-AWS store or a local MinIO.
   *
   * Configuration rather than a hardcoded development endpoint: the object
   * store is an adapter behind {@link import('../storage/objectStore')}, and
   * nothing in product code may name one.
   */
  endpoint: z.preprocess(emptyAsUndefined, z.string().trim().url().optional()),
  /**
   * The key prefix every contributed object lands under.
   *
   * One prefix, server-chosen, because the object-store lifecycle backstop is
   * configured per prefix: an object written outside it is an object the
   * backstop will never reap if the application's own sweeper misses it.
   */
  keyPrefix: z.preprocess(
    emptyAsUndefined,
    z.string().trim().regex(/^[a-z0-9][a-z0-9/_-]*$/, 'must be a simple key prefix').default('captures'),
  ),
  uploadIntentTtlSeconds: positiveInteger(DEFAULT_UPLOAD_INTENT_TTL_SECONDS, 3600),

  consentVersion: z.preprocess(emptyAsUndefined, z.string().trim().min(1).default(DEFAULT_CONSENT_VERSION)),

  maxPhotoBytes: positiveInteger(DEFAULT_MAX_PHOTO_BYTES, 1024 * 1024 * 1024),
  maxVideoBytes: positiveInteger(DEFAULT_MAX_VIDEO_BYTES, 8 * 1024 * 1024 * 1024),
  maxVideoDurationSeconds: positiveInteger(DEFAULT_MAX_VIDEO_DURATION_SECONDS, 3600),
  photoContentTypes: mediaTypeList(DEFAULT_PHOTO_CONTENT_TYPES),
  videoContentTypes: mediaTypeList(DEFAULT_VIDEO_CONTENT_TYPES),

  rawPhotoRetentionDays: retentionDays(DEFAULT_RETENTION_DAYS.raw_photo),
  rawVideoRetentionDays: retentionDays(DEFAULT_RETENTION_DAYS.raw_video),
  keyframeRetentionDays: retentionDays(DEFAULT_RETENTION_DAYS.extracted_keyframe),
  privacyProxyRetentionDays: retentionDays(DEFAULT_RETENTION_DAYS.privacy_safe_proxy),
  thumbnailRetentionDays: retentionDays(DEFAULT_RETENTION_DAYS.thumbnail),
  videoDeletionEligibleDays: positiveInteger(DEFAULT_VIDEO_DELETION_ELIGIBLE_DAYS, 90),
});

export type CaptureConfig = Readonly<z.infer<typeof schema>> & {
  /** Whether an object store is configured at all. */
  readonly enabled: boolean;
  /** Retention window per class, in days — the map the upload policy publishes. */
  readonly retentionDays: Readonly<Record<CaptureRetentionClass, number>>;
};

/**
 * Parse `source` into a {@link CaptureConfig}.
 *
 * @throws {Error} Naming every variable that failed, not just the first.
 */
export function parseCaptureConfig(source: EnvironmentSource = process.env): CaptureConfig {
  const result = schema.safeParse({
    bucket: source.CAPTURE_S3_BUCKET,
    region: source.CAPTURE_S3_REGION ?? source.AWS_REGION,
    endpoint: source.CAPTURE_S3_ENDPOINT,
    keyPrefix: source.CAPTURE_S3_KEY_PREFIX,
    uploadIntentTtlSeconds: source.CAPTURE_UPLOAD_INTENT_TTL_SECONDS,
    consentVersion: source.CAPTURE_CONSENT_VERSION,
    maxPhotoBytes: source.CAPTURE_MAX_PHOTO_BYTES,
    maxVideoBytes: source.CAPTURE_MAX_VIDEO_BYTES,
    maxVideoDurationSeconds: source.CAPTURE_MAX_VIDEO_DURATION_SECONDS,
    photoContentTypes: source.CAPTURE_PHOTO_CONTENT_TYPES,
    videoContentTypes: source.CAPTURE_VIDEO_CONTENT_TYPES,
    rawPhotoRetentionDays: source.CAPTURE_RETENTION_DAYS_RAW_PHOTO,
    rawVideoRetentionDays: source.CAPTURE_RETENTION_DAYS_RAW_VIDEO,
    keyframeRetentionDays: source.CAPTURE_RETENTION_DAYS_KEYFRAME,
    privacyProxyRetentionDays: source.CAPTURE_RETENTION_DAYS_PRIVACY_PROXY,
    thumbnailRetentionDays: source.CAPTURE_RETENTION_DAYS_THUMBNAIL,
    videoDeletionEligibleDays: source.CAPTURE_VIDEO_DELETION_ELIGIBLE_DAYS,
  });

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid capture configuration:\n${problems}\n\n` +
        'See the CAPTURE_* block in packages/backend/.env.example. Leaving ' +
        'CAPTURE_S3_BUCKET unset is valid: the upload-intent route then answers ' +
        'service_unavailable and the rest of the API is unaffected.',
    );
  }

  const parsed = result.data;
  return {
    ...parsed,
    // A bucket without a region cannot be signed for, so both are required
    // before contribution is considered available. Reporting "enabled" on half
    // a configuration would turn a deployment mistake into a 500 per upload.
    enabled: parsed.bucket !== undefined && parsed.region !== undefined,
    retentionDays: {
      raw_photo: parsed.rawPhotoRetentionDays,
      raw_video: parsed.rawVideoRetentionDays,
      extracted_keyframe: parsed.keyframeRetentionDays,
      privacy_safe_proxy: parsed.privacyProxyRetentionDays,
      thumbnail: parsed.thumbnailRetentionDays,
    },
  };
}

/** The one capture parse for this process. */
export const captureConfig: CaptureConfig = parseCaptureConfig();
