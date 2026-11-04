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
 * What a deployment configures is WHERE contributions go (the bucket, its
 * region, an endpoint for a local store) and, during a closed pilot, WHO may
 * contribute. Everything else is {@link CAPTURE_POLICY}.
 *
 * ## The retention numbers live here because they are POLICY, not contract
 *
 * #10 is explicit: exact durations must be defined in one place, not hardcoded
 * throughout the codebase, and they are never a public guarantee. So they are
 * constants in ONE module, the API publishes them as a
 * {@link CaptureUploadPolicy} so a contributor can be told before they submit,
 * and the database enforces a separate, much coarser CEILING
 * (`ABSOLUTE_RETENTION_CEILING_DAYS`) that no code here can raise. Policy
 * moves, in a reviewed commit; the backstop does not.
 *
 * The defaults are the conservative end of the epic's stated posture: ~90 days
 * for an original photo, far less for raw video, and derived reconstruction
 * inputs outliving the originals they replaced — which is the whole point of
 * deriving them.
 */

import { z } from 'zod';
import type { CaptureRetentionClass } from '@goway/contracts';
import type { EnvironmentSource } from './index';
import { oxyUserIdList } from './oxyUserIds';

/** What GoWay accepts and keeps. Constants: a change is a reviewed commit, not a task definition. */
export interface CapturePolicy {
  /**
   * The single key prefix every contributed object lands under. One prefix,
   * server-chosen, because the object-store lifecycle backstop is configured on
   * it: an object written outside it would never be reaped if the
   * application's own sweeper missed it.
   */
  keyPrefix: string;
  /** How long a presigned upload target stays valid, in seconds. A bearer token in a URL: short. */
  uploadIntentTtlSeconds: number;
  /**
   * The version of the contribution consent text a new session must accept.
   * A string rather than a boolean, because "they consented" is not a fact that
   * survives the text changing. Recorded per session (`capture_sessions.consent_version`).
   */
  consentVersion: string;
  /**
   * Ceilings on one contributed file, published in the upload policy so a
   * client can refuse a file BEFORE a contributor waits through an upload the
   * API was always going to reject.
   */
  maxPhotoBytes: number;
  maxVideoBytes: number;
  maxVideoDurationSeconds: number;
  /**
   * The media types GoWay accepts. Server-side and authoritative — a client's
   * declared content type is a claim, and the presigned target pins it. HEIC
   * is here because it is what an iPhone actually produces.
   */
  photoContentTypes: readonly string[];
  videoContentTypes: readonly string[];
  /**
   * Ceilings on one 360° (equirectangular) file, which replace the ones above.
   * A 360° frame is fourteen views' worth of pixels, so the byte ceilings are
   * higher; the resolution ceilings are what the privacy worker decodes
   * comfortably (an ~72 MP photo, an 8K video). Duration is SHORTER than for a
   * phone video: a minute of 360° video already covers a street from both
   * pavements, and every keyframe becomes fourteen derivatives.
   */
  maxEquirectangularPhotoBytes: number;
  maxEquirectangularPhotoWidthPixels: number;
  maxEquirectangularVideoBytes: number;
  maxEquirectangularVideoDurationSeconds: number;
  maxEquirectangularVideoWidthPixels: number;
  /**
   * Retention window per class, in days — the map the upload policy publishes.
   *
   * A TOTAL `Record<CaptureRetentionClass, number>`: a class added to the tuple
   * in `@goway/contracts` and forgotten here is a compile error, instead of a
   * new kind of stored object silently inheriting somebody else's window.
   *
   * - `raw_photo` 90 days — the long end of the epic's 60–90 day posture,
   *   because a photo's value is that a second contributor may photograph the
   *   same façade weeks later.
   * - `raw_video` 30 days — a video is a DERIVATION SOURCE. Its useful content
   *   is its keyframes, it costs an order of magnitude more per second of
   *   coverage than a photo, and #10 asks for it to go substantially earlier.
   *   `videoDeletionEligibleDays` usually retires it long before this.
   * - the derived classes 180 days — they exist BECAUSE they are smaller and
   *   privacy-processed. Expiring them on the originals' schedule would throw
   *   away the cheap thing to keep the expensive one.
   */
  retentionDays: Readonly<Record<CaptureRetentionClass, number>>;
  /**
   * How long a raw video is protected from the sweeper before its keyframes can
   * retire it, in days. Long enough that a failed keyframe extraction can be
   * diagnosed against the original; short enough that the expensive bytes do
   * not sit for a month.
   */
  videoDeletionEligibleDays: number;
}

export const CAPTURE_POLICY: CapturePolicy = {
  keyPrefix: 'captures',
  uploadIntentTtlSeconds: 900,
  consentVersion: '2026-09-01',
  maxPhotoBytes: 48 * 1024 * 1024,
  maxVideoBytes: 512 * 1024 * 1024,
  maxVideoDurationSeconds: 600,
  photoContentTypes: ['image/jpeg', 'image/png', 'image/heic', 'image/heif'],
  videoContentTypes: ['video/mp4', 'video/quicktime'],
  maxEquirectangularPhotoBytes: 64 * 1024 * 1024,
  maxEquirectangularPhotoWidthPixels: 12_000,
  maxEquirectangularVideoBytes: 2 * 1024 * 1024 * 1024,
  maxEquirectangularVideoDurationSeconds: 300,
  maxEquirectangularVideoWidthPixels: 7_680,
  retentionDays: {
    raw_photo: 90,
    raw_video: 30,
    extracted_keyframe: 180,
    privacy_safe_proxy: 180,
    thumbnail: 180,
  },
  videoDeletionEligibleDays: 3,
};

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

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
   * A closed pilot: when set, ONLY these Oxy user ids may contribute.
   *
   * Contribution reaches a pipeline whose privacy and operational controls are
   * verified end to end in production before anybody else's imagery enters
   * it. A comma-separated list; unset (or empty) means contribution is open to
   * every signed-in account, which is the normal state once verified. Oxy
   * owns identity, so these are foreign ids with nothing in this database to
   * point at.
   */
  pilotOxyUserIds: oxyUserIdList,
});

export type CaptureConfig = Readonly<z.infer<typeof schema>> &
  Readonly<CapturePolicy> & {
    /** Whether an object store is configured at all. */
    readonly enabled: boolean;
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
    pilotOxyUserIds: source.CAPTURE_PILOT_OXY_USER_IDS,
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
    ...CAPTURE_POLICY,
    ...parsed,
    // A bucket without a region cannot be signed for, so both are required
    // before contribution is considered available. Reporting "enabled" on half
    // a configuration would turn a deployment mistake into a 500 per upload.
    enabled: parsed.bucket !== undefined && parsed.region !== undefined,
  };
}

/**
 * Whether `oxyUserId` may contribute under `config`.
 *
 * Contribution needs a configured store, and — while a pilot list is set —
 * membership of it. Without a list an anonymous caller is told contribution is
 * available (they sign in to do it; the routes still require an account); with
 * a list nobody outside it is, signed in or not.
 */
export function mayContribute(config: CaptureConfig, oxyUserId: string | undefined): boolean {
  if (!config.enabled) return false;
  if (config.pilotOxyUserIds.length === 0) return true;
  return oxyUserId !== undefined && config.pilotOxyUserIds.includes(oxyUserId);
}

/** The one capture parse for this process. */
export const captureConfig: CaptureConfig = parseCaptureConfig();
