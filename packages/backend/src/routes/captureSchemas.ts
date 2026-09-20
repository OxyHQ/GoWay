/**
 * The capture request schemas.
 *
 * These are the OUTER boundary: everything below them — the repository, the
 * anchor resolver, the table CHECK constraints — is entitled to assume a
 * latitude is a latitude and a content hash is 64 hex characters. Each schema
 * is at least as strict as the constraint behind it, so a value the database
 * would refuse is a 422 naming the field rather than a 500 carrying a
 * constraint name.
 *
 * ## A client may describe its media; it may not describe its storage
 *
 * The body says what the media IS — kind, size, hash, type, where it was taken,
 * what the camera was doing. It cannot say where the bytes go, how long they
 * are kept, what the object is called, which retention class it belongs to or
 * whether the privacy gate has passed. Those are server decisions, and the way
 * to keep them server decisions is for there to be no field to put them in: a
 * schema with an ignored `expiresAt` is one refactor away from an honoured one.
 *
 * ## EXIF arrives raw, and is normalized HERE
 *
 * A GPS block may be sent as EXIF's own degrees/minutes/seconds plus a
 * hemisphere ref, and `capture/exif.ts` converts it. Doing it at the boundary
 * means the conversion — the one whose classic bug silently mirrors a photo
 * into the wrong hemisphere — happens once, in tested code, rather than in
 * whatever each client got right.
 */

import { z } from 'zod';
import {
  CAPTURE_LOCATION_ORIGINS,
  CAPTURE_LOCATION_WITNESSES,
  CAPTURE_MEDIA_KINDS,
  CAPTURE_SOURCES,
  type CaptureLocationEvidence,
} from '@goway/shared-types';
import { normalizeExifGps, normalizeExifOrientation } from '../capture/exif';

/** Longest accepted contributor note, in characters. */
const MAX_NOTE_LENGTH = 500;
/** Longest accepted camera make/model/lens string. */
const MAX_CAMERA_STRING = 120;
/** The most pieces of location evidence one contribution may carry. */
const MAX_EVIDENCE = 4;

const latitudeValue = z.number().min(-90).max(90);
const longitudeValue = z.number().min(-180).max(180);

/**
 * An ISO 8601 instant that is actually parseable.
 *
 * `z.iso.datetime()` accepts the spelling; `Date.parse` is what decides whether
 * the value survives the trip into a `timestamptz`. A string that parses to
 * `NaN` would be inserted as an invalid date and only fail deep inside the
 * driver, which reports it as a bind error naming nothing useful.
 */
const instant = z
  .string()
  .trim()
  .refine((value) => Number.isFinite(Date.parse(value)), 'must be an ISO 8601 instant')
  .transform((value) => new Date(value));

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * `consentVersion` is REQUIRED and is not defaulted to the current one.
 *
 * Defaulting would record that a contributor accepted text the client may never
 * have shown them, which is worse than not recording consent at all: it is a
 * false audit trail. A client that has not displayed the consent cannot name
 * its version, and that is the point.
 */
export const createSessionSchema = z.object({
  source: z.enum(CAPTURE_SOURCES),
  consentVersion: z.string().trim().min(1).max(64),
  note: z.string().trim().max(MAX_NOTE_LENGTH).optional(),
  startedAt: instant.optional(),
});

export type CreateSessionBody = z.infer<typeof createSessionSchema>;

// ── Location evidence ───────────────────────────────────────────────────────

/** One EXIF GPS magnitude, as a client reads it out of the file. */
const exifMagnitudeSchema = z.object({
  degrees: z.number().min(0).max(180),
  minutes: z.number().min(0).max(59.999999).optional(),
  seconds: z.number().min(0).max(59.999999).optional(),
  ref: z.string().trim().length(1),
});

const exifGpsSchema = z.object({
  latitude: exifMagnitudeSchema,
  longitude: exifMagnitudeSchema,
  altitude: z.number().min(0).optional(),
  altitudeRef: z.union([z.literal(0), z.literal(1)]).optional(),
  imageDirection: z.number().optional(),
});

/**
 * One position claim.
 *
 * Exactly one of `coordinate` and `exifGps` — a body carrying both is a client
 * that has two answers and has not decided, and picking one for it would be
 * choosing which street the photo is on by coin flip.
 *
 * `witness` is NOT in this schema. Everything arriving over HTTP is witnessed
 * by the client, by definition; a body that could claim `goway_ingest` would be
 * a client laundering its own coordinate into a measurement GoWay never made,
 * which is precisely the distinction the witness field exists to preserve.
 */
export const locationEvidenceSchema = z
  .object({
    origin: z.enum(CAPTURE_LOCATION_ORIGINS),
    coordinate: z.object({ latitude: latitudeValue, longitude: longitudeValue }).optional(),
    exifGps: exifGpsSchema.optional(),
    accuracyMeters: z.number().min(0).max(100_000).optional(),
    altitudeMeters: z.number().min(-12_000).max(12_000).optional(),
    headingDegrees: z.number().min(0).max(360).optional(),
    observedAt: z.string().trim().optional(),
  })
  .refine(
    (value) => (value.coordinate === undefined) !== (value.exifGps === undefined),
    'exactly one of coordinate and exifGps is required',
  )
  .transform((value, context): CaptureLocationEvidence => {
    let coordinate = value.coordinate;
    let altitudeMeters = value.altitudeMeters;
    let headingDegrees = value.headingDegrees;

    if (value.exifGps) {
      const normalized = normalizeExifGps(value.exifGps);
      if (!normalized) {
        context.addIssue({
          code: 'custom',
          path: ['exifGps'],
          message: 'the GPS tags do not describe a position',
        });
        return z.NEVER;
      }
      coordinate = normalized.coordinate;
      altitudeMeters = altitudeMeters ?? normalized.altitudeMeters;
      headingDegrees = headingDegrees ?? normalized.headingDegrees;
    }

    return {
      origin: value.origin,
      // Always. See this schema's docblock.
      witness: CAPTURE_LOCATION_WITNESSES[0],
      coordinate: coordinate as { latitude: number; longitude: number },
      ...(value.accuracyMeters === undefined ? {} : { accuracyMeters: value.accuracyMeters }),
      ...(altitudeMeters === undefined ? {} : { altitudeMeters }),
      // 360 and 0 are the same direction; the column's CHECK is `[0, 360)`.
      ...(headingDegrees === undefined ? {} : { headingDegrees: headingDegrees % 360 }),
      ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
    };
  });

// ── Assets ──────────────────────────────────────────────────────────────────

const cameraSchema = z.object({
  widthPixels: z.number().int().positive().max(1_000_000).optional(),
  heightPixels: z.number().int().positive().max(1_000_000).optional(),
  exifOrientation: z.number().int().optional(),
  focalLengthMm: z.number().positive().max(10_000).optional(),
  focalLength35mm: z.number().positive().max(10_000).optional(),
  make: z.string().trim().max(MAX_CAMERA_STRING).optional(),
  model: z.string().trim().max(MAX_CAMERA_STRING).optional(),
  lens: z.string().trim().max(MAX_CAMERA_STRING).optional(),
  durationSeconds: z.number().positive().max(86_400).optional(),
  frameRate: z.number().positive().max(1_000).optional(),
});

/**
 * Register a contribution and ask for an upload target.
 *
 * `contentHash` is required and is hashed by the CLIENT before anything is
 * sent. That is what makes deduplication answerable before a byte moves, and it
 * is why a contributor who re-picks the same photo does not upload it twice.
 * The server verifies the byte count against the store afterwards; it cannot
 * verify the hash without reading the object, which is #11's job, not the API's.
 */
export const registerAssetSchema = z.object({
  mediaKind: z.enum(CAPTURE_MEDIA_KINDS),
  source: z.enum(CAPTURE_SOURCES),
  contentHash: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{64}$/, 'must be a lower-case hex SHA-256 digest'),
  byteSize: z.number().int().positive(),
  contentType: z.string().trim().toLowerCase().max(120),
  capturedAt: instant.optional(),
  location: z.array(locationEvidenceSchema).min(1).max(MAX_EVIDENCE),
  camera: cameraSchema.optional(),
});

export type RegisterAssetBody = z.infer<typeof registerAssetSchema>;

/**
 * Finalize an upload.
 *
 * The body is EMPTY on purpose, and an empty object is accepted so a client may
 * send `{}` or nothing. A `byteSize` here would be the client telling GoWay how
 * big the object it just wrote is — which GoWay asks the object store, because
 * the store is the only party that actually knows.
 */
export const finalizeAssetSchema = z.object({}).strict();

/**
 * Camera metadata with its EXIF orientation normalized, or `undefined`.
 *
 * An orientation outside 1–8 is DROPPED rather than defaulted to 1 — see
 * `normalizeExifOrientation`. Defaulting would assert that an image nobody has
 * looked at is already upright, and a reconstruction that believes it matches
 * features against a sideways façade.
 */
export function normalizedCamera(camera: z.infer<typeof cameraSchema> | undefined) {
  if (!camera) return undefined;
  const orientation = normalizeExifOrientation(camera.exifOrientation);
  const rest = { ...camera };
  delete rest.exifOrientation;
  return { ...rest, ...(orientation === undefined ? {} : { exifOrientation: orientation }) };
}
