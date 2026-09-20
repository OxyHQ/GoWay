/**
 * GoWay Street 3D capture — the public contract for contributed imagery.
 *
 * ## What a capture is, and what it is not
 *
 * A capture is CONTENT a signed-in contributor deliberately submitted so that
 * GoWay can reconstruct a community 3D view of a street. It has a position
 * because the scene requires one. That is the whole of the reason, and it is
 * why nothing in this file is keyed by user and time: a browsable personal
 * travel timeline is a different product, GoWay does not build one, and the
 * shapes here must not be usable as one. Every position below hangs off a
 * SUBMITTED ASSET, never off an account.
 *
 * ## Raw media is temporary, and the contract says so out loud
 *
 * Every stored object carries {@link StoredObjectLifecycle} — the retention
 * class it belongs to, the reason it is being kept RIGHT NOW, and the instant
 * it dies. There is no shape in this file that can describe a permanent raw
 * upload, because `expiresAt` is required and `retentionClass` is required.
 * The backend's schema enforces the same thing with NOT NULL columns and a
 * ceiling CHECK; this file is the half a consumer can see.
 *
 * ## A position is evidence, not a fact
 *
 * {@link CaptureLocationEvidence} is modelled the way `place.ts` models a
 * capability: the value, WHERE it came from, and WHO observed it. A coordinate
 * the app read out of a photo's EXIF and a coordinate GoWay's own ingest read
 * out of the stored bytes are both "the photo's GPS" and they are not equally
 * trustworthy — a client can send anything. The two are stored side by side
 * and the resolved {@link CaptureAnchor} says which one won, so #13's privacy
 * work and #11's georeferencing can weigh a position instead of believing it.
 *
 * These are *contracts*, not rows. The canonical Drizzle/PostGIS schema lives
 * in `packages/backend` and is deliberately not published, and neither is the
 * geographic bucketing key the backend indexes captures by — #11 must stay free
 * to change how it retrieves neighbours without a public contract change.
 */

import type { GeoCoordinate } from './geo';

/** A stable GoWay capture session identifier. */
export type CaptureSessionId = string;

/** A stable GoWay capture asset identifier. */
export type CaptureAssetId = string;

// ── What was contributed ────────────────────────────────────────────────────

/**
 * The two kinds of media a contribution can be.
 *
 * Deliberately not a MIME type: the accepted codecs are a rollout decision that
 * changes without a contract change (see {@link CaptureUploadPolicy}), while
 * "photo or video" decides the entire lifecycle — a video's original bytes are
 * deleted far earlier than a photo's, because keyframes replace them.
 */
export const CAPTURE_MEDIA_KINDS = ['photo', 'video'] as const;
export type CaptureMediaKind = (typeof CAPTURE_MEDIA_KINDS)[number];

/**
 * Where the contributor got the media.
 *
 * This is not a device fingerprint and must not grow into one. It exists
 * because it predicts metadata quality: `camera` media was shot moments ago
 * with GoWay's own permission-gated position beside it, `library` media may be
 * years old with EXIF a photo editor already stripped, and a future
 * `guided_session` is a deliberate multi-shot walk whose frames are related to
 * each other.
 */
export const CAPTURE_SOURCES = ['camera', 'library', 'guided_session'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

// ── Where it is, and how much to trust that ─────────────────────────────────

/**
 * How a coordinate came to be associated with a capture, best first.
 *
 * The order is issue #9's preference order and it is encoded as data in
 * {@link CAPTURE_LOCATION_ORIGIN_RANK} rather than left to each reader:
 *
 *  1. `device_capture` — GoWay recorded the position at capture time, with the
 *     user's permission, in the contribution flow. Contemporaneous with the
 *     shutter and the only origin that carries a real accuracy estimate.
 *  2. `media_metadata` — EXIF / QuickTime GPS carried by the media itself.
 *     Usually right, occasionally a phone's last fix from a different street,
 *     and trivially editable.
 *  3. `user_placed` — the contributor pointed at a map because the media had no
 *     usable metadata. Honest, coarse, and never inferred: GoWay does not guess
 *     a precise position from anybody's unrelated history.
 */
export const CAPTURE_LOCATION_ORIGINS = ['device_capture', 'media_metadata', 'user_placed'] as const;
export type CaptureLocationOrigin = (typeof CAPTURE_LOCATION_ORIGINS)[number];

/**
 * Preference rank for {@link CaptureLocationOrigin}, higher wins.
 *
 * A total `Record` rather than the tuple's own index, so adding an origin is a
 * compile error here until somebody decides where it sits against the other
 * three — which is the decision that actually matters and the one an implicit
 * ordering would let a contributor make by accident.
 */
export const CAPTURE_LOCATION_ORIGIN_RANK: Readonly<Record<CaptureLocationOrigin, number>> = {
  device_capture: 3,
  media_metadata: 2,
  user_placed: 1,
};

/**
 * Who observed a coordinate — the half of provenance that decides whether
 * GoWay is repeating a claim or reporting a measurement.
 *
 * `client` is the GoWay app saying so. It is a signed-in, deliberate
 * contribution and so it is not adversarial by default, but it is still a
 * CLAIM: the request body is whatever reached the API.
 * `goway_ingest` is GoWay's own ingest reading the stored bytes. That one is
 * evidence GoWay produced itself, and it is the only origin/witness pair a
 * reconstruction may treat as independently checked.
 *
 * Both are recorded, always, and neither overwrites the other — the same rule
 * `places_sources` applies to a place fact.
 */
export const CAPTURE_LOCATION_WITNESSES = ['client', 'goway_ingest'] as const;
export type CaptureLocationWitness = (typeof CAPTURE_LOCATION_WITNESSES)[number];

/**
 * One position claimed or measured for a capture, with its provenance.
 *
 * A capture normally carries several: what the app said when it asked for an
 * upload target, and what ingest later read out of the bytes. They are kept
 * side by side rather than reconciled into one column, so a later privacy or
 * georeferencing pass can see that they disagreed.
 */
export interface CaptureLocationEvidence {
  origin: CaptureLocationOrigin;
  witness: CaptureLocationWitness;
  coordinate: GeoCoordinate;
  /**
   * Horizontal accuracy in metres, as the platform reported it — a radius, not
   * an error bar. Absent means unknown, which is NOT the same as accurate.
   */
  accuracyMeters?: number;
  /** Metres above the WGS 84 ellipsoid, when the source records one. */
  altitudeMeters?: number;
  /** Compass heading in degrees clockwise from true north, `[0, 360)`. */
  headingDegrees?: number;
  /** ISO 8601 instant this position was observed. */
  observedAt?: string;
}

/**
 * The position GoWay actually uses for this capture, and where it came from.
 *
 * Derived from {@link CaptureLocationEvidence} by GoWay and never sent by a
 * client. A consumer that needs to know how much to trust it reads `origin` and
 * `witness`, exactly as a consumer of {@link import('./place').PlaceCapability}
 * reads `verification`.
 */
export interface CaptureAnchor {
  coordinate: GeoCoordinate;
  origin: CaptureLocationOrigin;
  witness: CaptureLocationWitness;
  accuracyMeters?: number;
}

// ── What the camera was doing ───────────────────────────────────────────────

/**
 * The camera facts that help reconstruction, and nothing else.
 *
 * Every field here earns its place by feeding a camera solve: pixel dimensions
 * and focal length give an intrinsics prior, orientation decides which way is
 * up before a pixel is matched, duration and frame rate size the keyframe
 * budget for a video.
 *
 * There is deliberately no serial number, no device identifier and no software
 * build string. `make`/`model` are here because a lens model is a real
 * intrinsics hint; the set stops there, because metadata that identifies a
 * DEVICE rather than a CAMERA is a fingerprint, and #13 forbids assembling one
 * out of contribution metadata.
 */
export interface CaptureCameraMetadata {
  widthPixels?: number;
  heightPixels?: number;
  /** EXIF orientation tag, 1–8. Normalized on ingest; consumers do not reapply it. */
  exifOrientation?: number;
  focalLengthMm?: number;
  /** 35 mm equivalent focal length — the comparable number across sensor sizes. */
  focalLength35mm?: number;
  /** Camera make, e.g. `Apple`. An intrinsics hint, never a device id. */
  make?: string;
  /** Camera model, e.g. `iPhone 15 Pro`. */
  model?: string;
  /** Lens model, where the platform reports one distinctly. */
  lens?: string;
  /** Video only. */
  durationSeconds?: number;
  /** Video only. */
  frameRate?: number;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Where a capture is in ingestion, matching and integration.
 *
 * Explicit states rather than inferred file existence, so a transition is
 * auditable and a retry is safe. Two of them are the ones people forget:
 *
 * - `abandoned` — an upload target was issued and the bytes never arrived
 *   before it expired. The record exists precisely so that an orphaned object,
 *   or the absence of an expected one, is DETECTABLE rather than invisible.
 * - `waiting_for_overlap` — a perfectly good contribution that nothing else
 *   overlaps yet. It is not a failure and must never be shown as one; it is the
 *   state that makes "ordinary photos, whenever they arrive" work at all.
 */
export const CAPTURE_ASSET_STATES = [
  /** The record exists; the bytes do not yet. Written when an upload target is issued. */
  'expected',
  /** The upload target expired with no bytes. An orphan, and a detectable one. */
  'abandoned',
  /** The contributor finalized: the bytes are where GoWay said they would be. */
  'uploaded',
  /** Format, decodability, anchor and duplicate checks are running. */
  'validating',
  /** Usable as a contribution. Still not a reconstruction input — see the privacy gate. */
  'accepted',
  /** Refused: unsupported media, no usable anchor, failed safety checks. */
  'rejected',
  /** Accepted, privacy-cleared, and nothing overlaps it yet. Not a failure. */
  'waiting_for_overlap',
  /** Selected into a candidate set for a reconstruction. */
  'reconstruction_candidate',
  /** Its pixels contributed to a published scene version. */
  'integrated',
  /** Its stored object passed its expiry. Compact provenance may survive it. */
  'expired',
  /** Removed early — contributor request, moderation, redundancy or invalid media. */
  'deleted',
] as const;
export type CaptureAssetState = (typeof CAPTURE_ASSET_STATES)[number];

/**
 * The privacy preprocessing gate (#13).
 *
 * FAIL CLOSED is the whole design: only `passed` opens the gate, and every
 * other value — including the ones that mean "we have not looked yet" — keeps
 * it shut. There is no "unknown" that reads as permission, and there is no path
 * where an unavailable detector lets raw pixels into training.
 */
export const CAPTURE_PRIVACY_STATES = [
  /** Not looked at yet. The default, and it blocks reconstruction. */
  'pending',
  /** A detector is running. Still blocked. */
  'in_progress',
  /** Faces and plates were detected and masked. The ONLY state that opens the gate. */
  'passed',
  /** Processing failed or was unavailable. Blocked, retried boundedly, then expired. */
  'failed',
  /** Moderation refused this source outright. Blocked permanently, including in rebuilds. */
  'blocked',
] as const;
export type CapturePrivacyState = (typeof CAPTURE_PRIVACY_STATES)[number];

/**
 * The privacy gate's state on one capture.
 *
 * `pipelineVersion` is required for a `passed` verdict and absent otherwise,
 * because "this was cleared" is meaningless without "by what" — it is what lets
 * GoWay rebuild old scenes when detection materially improves. The backend's
 * schema refuses a `passed` row that does not name one.
 */
export interface CapturePrivacyGate {
  state: CapturePrivacyState;
  /** The privacy pipeline that produced the verdict. Present exactly when `passed`. */
  pipelineVersion?: string;
  /** ISO 8601 instant the verdict was reached. */
  completedAt?: string;
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Every class of stored artifact GoWay's lifecycle reasons about.
 *
 * The whole vocabulary is declared here even though contributed uploads can
 * only ever be one of {@link CAPTURE_RETENTION_CLASSES}, because a class is
 * also how storage is BUDGETED and REPORTED: "bytes by retention class" is the
 * cost number that decides whether more uploads are worth their storage, and it
 * is meaningless if the published artifacts are missing from the denominator.
 *
 * The later classes have no table yet. #11 and #14 add them; the vocabulary is
 * here first so their rows and these agree.
 */
export const RETENTION_CLASSES = [
  // Contributed originals — temporary, always.
  'raw_photo',
  'raw_video',
  // Derived reconstruction inputs.
  'extracted_keyframe',
  'privacy_safe_proxy',
  'thumbnail',
  // Compact derived knowledge: small, and worth keeping after the pixels go.
  'visual_descriptor',
  'camera_solution',
  'sparse_reconstruction',
  // Reconstruction working state and published output (#11, #14).
  'training_checkpoint',
  'published_splat',
  'published_lod',
  'scene_manifest',
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/**
 * The classes a contributed upload may be stored as.
 *
 * `satisfies readonly RetentionClass[]` makes the subset relationship a
 * compile-time fact rather than a comment: a typo here does not silently create
 * a twelfth class that nothing has a retention policy for. The backend CHECKs
 * its capture object table against exactly this tuple, so a `published_splat`
 * is not merely unlikely in that table — it is unrepresentable.
 */
export const CAPTURE_RETENTION_CLASSES = [
  'raw_photo',
  'raw_video',
  'extracted_keyframe',
  'privacy_safe_proxy',
  'thumbnail',
] as const satisfies readonly RetentionClass[];
export type CaptureRetentionClass = (typeof CAPTURE_RETENTION_CLASSES)[number];

/**
 * Why an object is being kept RIGHT NOW.
 *
 * Separate from the class, and both are required, because they answer different
 * questions: the class says what KIND of thing this is and therefore roughly
 * how long it may live, and the reason says what is still using it — which is
 * what a sweeper has to re-check before deleting, and what a contributor is
 * owed as an explanation.
 *
 * An object whose reason no longer holds is garbage regardless of how much of
 * its window is left. That is the direction this pair is meant to be read in:
 * the expiry is a ceiling, not a plan.
 */
export const RETENTION_REASONS = [
  /** The bytes exist only until the privacy gate has run over them. */
  'awaiting_privacy_processing',
  /** A usable contribution with nothing to match against yet. */
  'awaiting_overlap',
  /** Actively feeding a reconstruction that is running or queued. */
  'reconstruction_input',
  /** Kept only long enough to derive something smaller — a video awaiting keyframes. */
  'derivation_source',
  /** A short window after integration, for troubleshooting and audit. */
  'audit_window',
  /** A bounded, explicit extension for a nearly-reconstructable scene. Never silent. */
  'rescue_extension',
  /** A published derived artifact on its own lifecycle. Survives its inputs. */
  'published_artifact',
] as const;
export type RetentionReason = (typeof RETENTION_REASONS)[number];

/**
 * Why an object was deleted — the tombstone's whole content.
 *
 * A tombstone records the REASON and nothing about the pixels. It exists so a
 * rebuild does not silently re-ingest something moderation removed, and so a
 * contributor can be told what happened to their contribution.
 */
export const DELETION_REASONS = [
  'expired',
  'contributor_request',
  'moderation',
  'duplicate',
  'invalid_media',
  'superseded_by_derivative',
] as const;
export type DeletionReason = (typeof DELETION_REASONS)[number];

/**
 * The lifecycle metadata every stored object carries.
 *
 * `retentionClass`, `retentionReason` and `expiresAt` are all REQUIRED. That is
 * the contract-level half of "no raw media is permanent by accident": there is
 * no value of this type that describes an object with no expiry, so a consumer
 * reading a capture always learns when its bytes die, and a producer cannot
 * build one that does not say.
 *
 * Business lifecycle is NEVER inferred from an S3 object's age. The object
 * store's own lifecycle rules are a backstop underneath these fields, not the
 * source of truth above them.
 */
export interface StoredObjectLifecycle {
  retentionClass: CaptureRetentionClass;
  retentionReason: RetentionReason;
  /** ISO 8601 instant the bytes were first stored. */
  storedAt: string;
  /**
   * ISO 8601 instant the bytes die. A MAXIMUM, never a promise to keep them
   * that long — moderation, a contributor's deletion or successful derivation
   * all remove an object earlier.
   */
  expiresAt: string;
  /**
   * ISO 8601 instant from which the sweeper MAY delete, when that is earlier
   * than expiry. A raw video becomes eligible as soon as its keyframes are
   * safely stored, which is normally weeks before its window runs out.
   */
  deletionEligibleAt?: string;
  /** ISO 8601 floor under an extension — the sweeper must not delete before it. */
  protectedUntil?: string;
  /** How many bounded extensions this object has received. Never unbounded. */
  extensionCount: number;
  /** ISO 8601 instant the bytes were deleted. Present only on a tombstone. */
  deletedAt?: string;
  /** Why they were deleted. Present exactly when `deletedAt` is. */
  deletionReason?: DeletionReason;
}

// ── The published shapes ────────────────────────────────────────────────────

/** The hash algorithm GoWay deduplicates on. One value, named rather than assumed. */
export const CAPTURE_CONTENT_HASH_ALGORITHM = 'sha256' as const;
export type CaptureContentHashAlgorithm = typeof CAPTURE_CONTENT_HASH_ALGORITHM;

/**
 * The stored bytes behind a capture.
 *
 * Deliberately carries NO object key, bucket or URL. Raw imagery is never a
 * public URL (#13); access is short-lived, least-privilege and issued per
 * request, so publishing a durable path would be handing out the one thing the
 * access controls exist to withhold.
 *
 * `deduplicated` is true when these exact bytes were already stored for an
 * earlier contribution and this capture reuses that one object. Two
 * contributions, one object, one lifecycle — which is why the lifecycle lives
 * here and not on the asset.
 */
export interface CaptureMediaObject {
  contentHashAlgorithm: CaptureContentHashAlgorithm;
  /** Lower-case hex digest of the exact bytes. */
  contentHash: string;
  byteSize: number;
  /** The stored media type, e.g. `image/jpeg`. */
  contentType: string;
  deduplicated: boolean;
  lifecycle: StoredObjectLifecycle;
}

/**
 * One contributed photo or video, as GoWay publishes it back to its
 * contributor.
 *
 * `reconstructionEligible` is DERIVED by GoWay from the privacy gate and the
 * asset state — it is not a field anything writes, and the backend generates it
 * in the database for exactly that reason. A consumer should read it rather
 * than re-deriving the rule, because the rule will get stricter and a
 * re-derivation in a client will not.
 */
export interface CaptureAsset {
  id: CaptureAssetId;
  sessionId: CaptureSessionId;
  mediaKind: CaptureMediaKind;
  source: CaptureSource;
  state: CaptureAssetState;
  privacy: CapturePrivacyGate;
  /** Whether this capture may be used as a reconstruction input. Derived; never sent. */
  reconstructionEligible: boolean;
  /** The position GoWay uses, and where it came from. */
  anchor: CaptureAnchor;
  /** Every position GoWay holds for this capture, claimed and measured alike. */
  locationEvidence: CaptureLocationEvidence[];
  /** ISO 8601 instant the media was captured, where that is known. */
  capturedAt?: string;
  camera?: CaptureCameraMetadata;
  media: CaptureMediaObject;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

/**
 * One contribution act: a walk down a street, or a handful of library photos
 * submitted together.
 *
 * A session groups assets that were submitted together and gives the
 * contributor one thing to watch, cancel and be told the retention policy
 * about. It is NOT a track: it holds no positions of its own, no start and end
 * coordinate and no path. Its assets have positions; the session has none, and
 * adding one would be the first step to a location history.
 *
 * `consentVersion` is the version of the contribution consent the contributor
 * accepted when they opened the flow. Recorded per session rather than per
 * account so that what somebody agreed to is legible after the text changes.
 */
export interface CaptureSession {
  id: CaptureSessionId;
  source: CaptureSource;
  /** The consent text version accepted for this contribution. */
  consentVersion: string;
  /** Optional contributor note, e.g. what they were trying to capture. */
  note?: string;
  /** ISO 8601 instant the contributor started capturing. */
  startedAt: string;
  /** ISO 8601 instant they finished. Absent while the session is open. */
  endedAt?: string;
  /** How many assets have been registered against this session. */
  assetCount: number;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

/**
 * A scoped, expiring permission to put exactly one object into GoWay's store.
 *
 * The GoWay API never proxies media bytes — a request-sized upload path would
 * make the API process the bottleneck and the cost centre for every
 * contribution. Instead the backend authorizes, records the asset as
 * {@link CaptureAssetState} `expected`, and hands back a target that expires.
 *
 * The client controls NOTHING about where the bytes land: the object key is
 * server-generated and is not in this shape. `headers` must be sent verbatim —
 * they are part of what was signed, and they pin the content type and the
 * declared length, so a target issued for a 2 MB JPEG cannot be spent on a
 * 2 GB video.
 */
export interface CaptureUploadIntent {
  assetId: CaptureAssetId;
  method: 'PUT';
  url: string;
  /** Send these verbatim. They are covered by the signature. */
  headers: Record<string, string>;
  /** ISO 8601 instant after which this target is refused by the store. */
  expiresAt: string;
  /** The exact byte count this target was signed for. */
  byteSize: number;
  contentType: string;
}

/**
 * What `POST …/assets` answers: the registered asset, and how to upload it.
 *
 * `upload` is ABSENT when these exact bytes are already stored for an earlier
 * contribution. That is not an error and not a rejection — the contribution is
 * registered and points at the existing object. The client should skip the
 * upload and go straight to finalizing, which is the whole point of hashing
 * before asking.
 */
export interface CaptureUploadTicket {
  asset: CaptureAsset;
  /** Absent when the bytes were deduplicated against an object GoWay already has. */
  upload?: CaptureUploadIntent;
}

/**
 * What a client must know BEFORE it asks a contributor to pick a file.
 *
 * Published as a contract rather than hardcoded in the app because every number
 * in it is a rollout decision: accepted codecs, size ceilings and retention
 * windows all move without an SDK release. `retentionDays` in particular is
 * what lets the contribution UI tell somebody how long their photo will be kept
 * BEFORE they submit it — which #9 requires and which a client cannot honestly
 * do from a constant it compiled in months ago.
 *
 * The retention numbers are MAXIMA and are configuration. They are not a
 * guarantee to keep anything that long.
 */
export interface CaptureUploadPolicy {
  /** The consent text version a new session must accept. */
  consentVersion: string;
  contentHashAlgorithm: CaptureContentHashAlgorithm;
  photo: {
    contentTypes: string[];
    maxByteSize: number;
  };
  video: {
    contentTypes: string[];
    maxByteSize: number;
    maxDurationSeconds: number;
  };
  /** Maximum days GoWay keeps each class of stored object. A ceiling, not a promise. */
  retentionDays: Record<CaptureRetentionClass, number>;
}

/**
 * Storage consumed by captures, grouped for cost control.
 *
 * The KPI #10 asks for is not "GB uploaded" — it is bytes retained, by class
 * and by area, so that "did this additional 10 GB materially improve coverage?"
 * has an answer. `scope` is deliberately opaque: the backend's geographic
 * bucketing key is internal, because #11 must be free to change how it buckets
 * without breaking a published shape.
 */
export interface CaptureStorageUsage {
  retentionClass: CaptureRetentionClass;
  /** Bytes currently stored. */
  storedBytes: number;
  /** Bytes whose objects expire within seven days. */
  expiringWithin7dBytes: number;
  /** Bytes whose objects expire within thirty days. */
  expiringWithin30dBytes: number;
  /** Bytes a second contribution of identical media did NOT cost, through deduplication. */
  deduplicatedBytes: number;
  objectCount: number;
}
