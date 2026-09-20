/**
 * The wall between the capture tables and the published contract.
 *
 * Every row that leaves the capture repository passes through here and becomes
 * a `@goway/shared-types` shape. Nothing spreads a row: the mapper READS the
 * columns the contract names and WRITES a fresh object holding exactly those,
 * so a column added tomorrow cannot reach a consumer by accident.
 *
 * That matters more here than it does for Places, because three of these
 * columns must NEVER leave the backend:
 *
 *  - `capture_media_objects.object_key` — raw imagery is never a public URL
 *    (#13), and a durable path is the one thing the access controls exist to
 *    withhold. It is absent from the selections below, not merely skipped when
 *    building the object.
 *  - `capture_assets.oxy_user_id` — contributor identity is kept for consent,
 *    abuse and deletion, and is not published. A capture is only ever returned
 *    to the contributor who submitted it, who does not need to be told their
 *    own id back.
 *  - `capture_assets.geo_cell` — the internal bucketing key. Publishing it
 *    would freeze GoWay's geographic indexing strategy into a contract that #11
 *    then could not change.
 *
 * ## Absent is not empty
 *
 * An optional field the database has no value for is OMITTED, never emitted as
 * `null` and never invented. `privacy.pipelineVersion` in particular is absent
 * until a verdict names one, and the absence is the honest statement that
 * nobody has cleared these pixels.
 */

import type {
  CaptureAnchor,
  CaptureAsset,
  CaptureAssetState,
  CaptureCameraMetadata,
  CaptureLocationEvidence,
  CaptureLocationOrigin,
  CaptureLocationWitness,
  CaptureMediaKind,
  CaptureMediaObject,
  CapturePrivacyGate,
  CapturePrivacyState,
  CaptureRetentionClass,
  CaptureSession,
  CaptureSource,
  DeletionReason,
  RetentionReason,
  StoredObjectLifecycle,
} from '@goway/shared-types';
import { CAPTURE_CONTENT_HASH_ALGORITHM } from '@goway/shared-types';
import type { SelectedRow } from '@oxy.so/db';
import { captureAssets, captureLocationEvidence, captureMediaObjects, captureSessions } from '../schema';

export const SESSION_COLUMNS = {
  id: captureSessions.id,
  source: captureSessions.source,
  consentVersion: captureSessions.consentVersion,
  note: captureSessions.note,
  startedAt: captureSessions.startedAt,
  endedAt: captureSessions.endedAt,
  createdAt: captureSessions.createdAt,
  updatedAt: captureSessions.updatedAt,
} as const;

export type SessionRow = SelectedRow<typeof SESSION_COLUMNS>;

/**
 * The asset columns a read selects.
 *
 * `anchorGeo` is absent for the same reason `places.geo` is: it is a PostGIS
 * blob no consumer can use and it is derivable from the two ordinates that ARE
 * selected. `geoCell` and `oxyUserId` are absent because they must not be
 * published at all — see this module's header.
 */
export const ASSET_COLUMNS = {
  id: captureAssets.id,
  sessionId: captureAssets.sessionId,
  mediaObjectId: captureAssets.mediaObjectId,
  mediaKind: captureAssets.mediaKind,
  source: captureAssets.source,
  state: captureAssets.state,
  capturedAt: captureAssets.capturedAt,
  anchorLatitude: captureAssets.anchorLatitude,
  anchorLongitude: captureAssets.anchorLongitude,
  anchorOrigin: captureAssets.anchorOrigin,
  anchorWitness: captureAssets.anchorWitness,
  anchorAccuracyMeters: captureAssets.anchorAccuracyMeters,
  privacyState: captureAssets.privacyState,
  privacyPipelineVersion: captureAssets.privacyPipelineVersion,
  privacyCompletedAt: captureAssets.privacyCompletedAt,
  reconstructionEligible: captureAssets.reconstructionEligible,
  cameraWidthPixels: captureAssets.cameraWidthPixels,
  cameraHeightPixels: captureAssets.cameraHeightPixels,
  exifOrientation: captureAssets.exifOrientation,
  focalLengthMm: captureAssets.focalLengthMm,
  focalLengthEquivalentMm: captureAssets.focalLengthEquivalentMm,
  cameraMake: captureAssets.cameraMake,
  cameraModel: captureAssets.cameraModel,
  cameraLens: captureAssets.cameraLens,
  durationSeconds: captureAssets.durationSeconds,
  frameRate: captureAssets.frameRate,
  createdAt: captureAssets.createdAt,
  updatedAt: captureAssets.updatedAt,
} as const;

export type AssetRow = SelectedRow<typeof ASSET_COLUMNS>;

/** `objectKey` is deliberately not here. See this module's header. */
export const MEDIA_OBJECT_COLUMNS = {
  id: captureMediaObjects.id,
  contentHash: captureMediaObjects.contentHash,
  contentType: captureMediaObjects.contentType,
  byteSize: captureMediaObjects.byteSize,
  confirmedByteSize: captureMediaObjects.confirmedByteSize,
  storageState: captureMediaObjects.storageState,
  storedAt: captureMediaObjects.storedAt,
  retentionClass: captureMediaObjects.retentionClass,
  retentionReason: captureMediaObjects.retentionReason,
  expiresAt: captureMediaObjects.expiresAt,
  deletionEligibleAt: captureMediaObjects.deletionEligibleAt,
  protectedUntil: captureMediaObjects.protectedUntil,
  retentionExtensionCount: captureMediaObjects.retentionExtensionCount,
  deletedAt: captureMediaObjects.deletedAt,
  deletionReason: captureMediaObjects.deletionReason,
  createdAt: captureMediaObjects.createdAt,
} as const;

export type MediaObjectRow = SelectedRow<typeof MEDIA_OBJECT_COLUMNS>;

export const EVIDENCE_COLUMNS = {
  id: captureLocationEvidence.id,
  assetId: captureLocationEvidence.assetId,
  origin: captureLocationEvidence.origin,
  witness: captureLocationEvidence.witness,
  latitude: captureLocationEvidence.latitude,
  longitude: captureLocationEvidence.longitude,
  accuracyMeters: captureLocationEvidence.accuracyMeters,
  altitudeMeters: captureLocationEvidence.altitudeMeters,
  headingDegrees: captureLocationEvidence.headingDegrees,
  observedAt: captureLocationEvidence.observedAt,
} as const;

export type EvidenceRow = SelectedRow<typeof EVIDENCE_COLUMNS>;

/** Assigns `value` under `key` only when present, so no contract key is ever `undefined`. */
function put<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

const optionalText = (value: string | null): string | undefined => value ?? undefined;
const optionalNumber = (value: number | null): number | undefined => value ?? undefined;
const optionalInstant = (value: Date | null): string | undefined => value?.toISOString();

export function toCaptureSession(row: SessionRow, assetCount: number): CaptureSession {
  const session: CaptureSession = {
    id: row.id,
    source: row.source as CaptureSource,
    consentVersion: row.consentVersion,
    startedAt: row.startedAt.toISOString(),
    assetCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  put(session, 'note', optionalText(row.note));
  put(session, 'endedAt', optionalInstant(row.endedAt));
  return session;
}

export function toLocationEvidence(row: EvidenceRow): CaptureLocationEvidence {
  const evidence: CaptureLocationEvidence = {
    origin: row.origin as CaptureLocationOrigin,
    witness: row.witness as CaptureLocationWitness,
    coordinate: { latitude: row.latitude, longitude: row.longitude },
  };
  put(evidence, 'accuracyMeters', optionalNumber(row.accuracyMeters));
  put(evidence, 'altitudeMeters', optionalNumber(row.altitudeMeters));
  put(evidence, 'headingDegrees', optionalNumber(row.headingDegrees));
  put(evidence, 'observedAt', optionalInstant(row.observedAt));
  return evidence;
}

/**
 * The lifecycle of one stored object.
 *
 * `storedAt` falls back to the row's creation instant while the bytes are still
 * merely expected. The contract requires the field, and "when GoWay started
 * being responsible for this object" is the honest reading of it before the
 * upload lands — the alternative would be publishing a null into a required
 * field, or omitting the one piece of lifecycle a contributor most wants
 * alongside the expiry.
 */
export function toStoredObjectLifecycle(row: MediaObjectRow): StoredObjectLifecycle {
  const lifecycle: StoredObjectLifecycle = {
    retentionClass: row.retentionClass as CaptureRetentionClass,
    retentionReason: row.retentionReason as RetentionReason,
    storedAt: (row.storedAt ?? row.createdAt).toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    extensionCount: row.retentionExtensionCount,
  };
  put(lifecycle, 'deletionEligibleAt', optionalInstant(row.deletionEligibleAt));
  put(lifecycle, 'protectedUntil', optionalInstant(row.protectedUntil));
  put(lifecycle, 'deletedAt', optionalInstant(row.deletedAt));
  put(lifecycle, 'deletionReason', (row.deletionReason ?? undefined) as DeletionReason | undefined);
  return lifecycle;
}

export function toCaptureMediaObject(row: MediaObjectRow, deduplicated: boolean): CaptureMediaObject {
  return {
    contentHashAlgorithm: CAPTURE_CONTENT_HASH_ALGORITHM,
    contentHash: row.contentHash,
    // The store's own count once it has one, the declared count until then. A
    // contributor watching their upload should see what GoWay believes it is
    // holding, not what the client promised before it sent anything.
    byteSize: row.confirmedByteSize ?? row.byteSize,
    contentType: row.contentType,
    deduplicated,
    lifecycle: toStoredObjectLifecycle(row),
  };
}

function toPrivacyGate(row: AssetRow): CapturePrivacyGate {
  const privacy: CapturePrivacyGate = { state: row.privacyState as CapturePrivacyState };
  put(privacy, 'pipelineVersion', optionalText(row.privacyPipelineVersion));
  put(privacy, 'completedAt', optionalInstant(row.privacyCompletedAt));
  return privacy;
}

function toAnchor(row: AssetRow): CaptureAnchor {
  const anchor: CaptureAnchor = {
    coordinate: { latitude: row.anchorLatitude, longitude: row.anchorLongitude },
    origin: row.anchorOrigin as CaptureLocationOrigin,
    witness: row.anchorWitness as CaptureLocationWitness,
  };
  put(anchor, 'accuracyMeters', optionalNumber(row.anchorAccuracyMeters));
  return anchor;
}

function toCameraMetadata(row: AssetRow): CaptureCameraMetadata | undefined {
  const camera: CaptureCameraMetadata = {};
  put(camera, 'widthPixels', optionalNumber(row.cameraWidthPixels));
  put(camera, 'heightPixels', optionalNumber(row.cameraHeightPixels));
  put(camera, 'exifOrientation', optionalNumber(row.exifOrientation));
  put(camera, 'focalLengthMm', optionalNumber(row.focalLengthMm));
  put(camera, 'focalLength35mm', optionalNumber(row.focalLengthEquivalentMm));
  put(camera, 'make', optionalText(row.cameraMake));
  put(camera, 'model', optionalText(row.cameraModel));
  put(camera, 'lens', optionalText(row.cameraLens));
  put(camera, 'durationSeconds', optionalNumber(row.durationSeconds));
  put(camera, 'frameRate', optionalNumber(row.frameRate));
  // No camera facts at all is no camera metadata. `{}` would make every
  // contribution look like it carried intrinsics worth using.
  return Object.keys(camera).length === 0 ? undefined : camera;
}

/** What an asset read hydrates before mapping. */
export interface AssetChildren {
  mediaObject: MediaObjectRow;
  /** True when this asset reuses bytes an earlier contribution already stored. */
  deduplicated: boolean;
  evidence: readonly EvidenceRow[];
}

export function toCaptureAsset(row: AssetRow, children: AssetChildren): CaptureAsset {
  const asset: CaptureAsset = {
    id: row.id,
    sessionId: row.sessionId,
    mediaKind: row.mediaKind as CaptureMediaKind,
    source: row.source as CaptureSource,
    state: row.state as CaptureAssetState,
    privacy: toPrivacyGate(row),
    // Read, never re-derived. The column is GENERATED by the database from the
    // privacy verdict and the state, so this is the one place the gate's answer
    // comes from — a mapper that recomputed the rule would be a second copy of
    // it to fall out of date.
    reconstructionEligible: row.reconstructionEligible,
    anchor: toAnchor(row),
    locationEvidence: children.evidence.map(toLocationEvidence),
    media: toCaptureMediaObject(children.mediaObject, children.deduplicated),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  put(asset, 'capturedAt', optionalInstant(row.capturedAt));
  put(asset, 'camera', toCameraMetadata(row));
  return asset;
}
