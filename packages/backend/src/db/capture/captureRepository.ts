/**
 * Every database access the capture API makes.
 *
 * Routes call these functions and nothing else — no route imports a drizzle
 * table, builds a predicate or sees a row. Two things follow that are worth
 * more than the indirection costs:
 *
 *  - Every read goes out through `captureMapper`, so the published shape is the
 *    contract in `@goway/shared-types` and never a table. The object key, the
 *    contributor's Oxy id and the internal geographic bucketing key cannot
 *    reach a consumer by being spread into a response, because nothing here
 *    spreads a row.
 *  - Every WRITE decides retention in `capture/retention.ts` and nowhere else,
 *    so "what is this, why is it kept, when does it die" is answered once per
 *    object rather than once per call site.
 *
 * ## Registering an asset is one transaction, and it has to be
 *
 * The object row, the asset row and its location evidence are written together.
 * A crash between them would leave either an object nothing references — an
 * upload target issued for bytes no contribution claims — or an asset pointing
 * at nothing. The first is the orphan class this design exists to make
 * detectable; creating one on the happy path would be an odd way to start.
 */

import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type {
  CaptureAsset,
  CaptureCameraMetadata,
  CaptureLocationEvidence,
  CaptureMediaKind,
  CaptureRetentionClass,
  CaptureSession,
  CaptureSource,
  CaptureStorageUsage,
} from '@goway/shared-types';
import { CAPTURE_RETENTION_CLASSES } from '@goway/shared-types';
import { evidenceDistanceMeters, resolveCaptureAnchor } from '../../capture/anchor';
import { extendedExpiry, planOriginalRetention, uploadIntentExpiry } from '../../capture/retention';
import { ApiError } from '../../http/apiError';
import { logger } from '../../utils/logger';
import type { Database, DatabaseOrTransaction } from '../postgres';
import { captureAssets, captureLocationEvidence, captureMediaObjects, captureSessions } from '../schema';
import {
  ASSET_COLUMNS,
  EVIDENCE_COLUMNS,
  MEDIA_OBJECT_COLUMNS,
  SESSION_COLUMNS,
  toCaptureAsset,
  toCaptureSession,
  type AssetRow,
  type EvidenceRow,
  type MediaObjectRow,
} from './captureMapper';

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  source: CaptureSource;
  consentVersion: string;
  note?: string;
  startedAt?: Date;
}

/**
 * A contribution as the API accepts it.
 *
 * `contentHash` and `byteSize` are declared BEFORE the bytes exist, which is
 * what lets the upload target be signed for exactly these and what makes
 * deduplication a question GoWay can answer before anything is transferred. The
 * client hashing first is not an optimisation, it is the mechanism.
 *
 * There is no object key here and there cannot be: the server generates it.
 */
export interface RegisterAssetInput {
  mediaKind: CaptureMediaKind;
  source: CaptureSource;
  contentHash: string;
  byteSize: number;
  contentType: string;
  capturedAt?: Date;
  /** Every position the client claims. Recorded verbatim with witness `client`. */
  evidence: readonly CaptureLocationEvidence[];
  camera?: CaptureCameraMetadata;
}

/** What `registerAsset` produced, and whether bytes still have to be sent. */
export interface RegisteredAsset {
  asset: CaptureAsset;
  /** The server-generated key, for signing an upload target. NEVER published. */
  objectKey: string;
  /** False when these bytes were already stored and no upload is needed. */
  uploadRequired: boolean;
  byteSize: number;
  contentType: string;
}

/**
 * How far two position claims may disagree before it is worth noticing, in
 * metres.
 *
 * 250 m is a street or two. Inside that, a phone's fix and a photo's EXIF
 * routinely differ and the anchor resolution is doing its job. Past it, one of
 * the two is about somewhere else — a stale last-known fix, a library photo
 * whose metadata belongs to a different trip — and that is a signal #11's
 * georeferencing will want.
 */
const EVIDENCE_DISAGREEMENT_METERS = 250;

/**
 * Note that a capture's own claims about where it is disagree.
 *
 * The DISTANCE is logged and the coordinates are NOT. #13 is explicit that
 * precise GPS must stay out of ordinary application logs, and it is also the
 * rule `ApiErrorDetails` already follows — "these two claims are 4 km apart" is
 * the diagnostic; where either of them is, is not.
 */
function noteEvidenceDisagreement(assetId: string, evidence: readonly CaptureLocationEvidence[]): void {
  let worst = 0;
  for (let i = 0; i < evidence.length; i += 1) {
    for (let j = i + 1; j < evidence.length; j += 1) {
      worst = Math.max(worst, evidenceDistanceMeters(evidence[i] as CaptureLocationEvidence, evidence[j] as CaptureLocationEvidence));
    }
  }
  if (worst >= EVIDENCE_DISAGREEMENT_METERS) {
    logger.warn(
      { assetId, disagreementMeters: Math.round(worst), claims: evidence.length },
      'Capture position claims disagree',
    );
  }
}

// ── Object keys ─────────────────────────────────────────────────────────────

/**
 * The key a contributed object lands under.
 *
 * Server-generated, always. Shaped `<prefix>/<yyyy>/<mm>/<object id>` so that:
 *
 *  - every object sits under ONE prefix, which is what an object-store
 *    lifecycle backstop is configured on — an object written outside it would
 *    never be reaped if the application sweeper missed it;
 *  - the date segments keep a listing navigable and let a coarse lifecycle rule
 *    target a month;
 *  - the leaf is the OBJECT ROW'S ID and not the content hash. A hash-derived
 *    key looks tidier and is wrong: once an object has expired and its bytes
 *    are deleted, the identical bytes may be contributed again as a new object
 *    with its own lifecycle, and a hash-derived key would collide with the
 *    tombstone's.
 */
function objectKeyFor(prefix: string, objectId: string, now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}/${year}/${month}/${objectId}`;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createCaptureSession(
  db: Database,
  oxyUserId: string,
  input: CreateSessionInput,
): Promise<CaptureSession> {
  const [row] = await db
    .insert(captureSessions)
    .values({
      oxyUserId,
      source: input.source,
      consentVersion: input.consentVersion,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    })
    .returning(SESSION_COLUMNS);
  if (!row) throw new ApiError('internal_error', 'The capture session was not created.');
  return toCaptureSession(row, 0);
}

/**
 * One session, if it belongs to this contributor.
 *
 * Ownership is part of the LOOKUP rather than a check after it, so there is no
 * shape of this function that returns somebody else's session for a caller to
 * forget to guard. A session a contributor does not own is indistinguishable
 * from one that does not exist, which is also the right answer to give: an
 * enumerable "exists but is not yours" tells a stranger which ids are real.
 */
export async function findOwnedSession(
  db: DatabaseOrTransaction,
  sessionId: string,
  oxyUserId: string,
): Promise<CaptureSession | null> {
  const [row] = await db
    .select(SESSION_COLUMNS)
    .from(captureSessions)
    .where(and(eq(captureSessions.id, sessionId), eq(captureSessions.oxyUserId, oxyUserId)));
  if (!row) return null;
  const [counted] = await db
    .select({ assets: count() })
    .from(captureAssets)
    .where(eq(captureAssets.sessionId, sessionId));
  return toCaptureSession(row, counted?.assets ?? 0);
}

// ── Assets ──────────────────────────────────────────────────────────────────

async function loadEvidence(
  db: DatabaseOrTransaction,
  assetId: string,
): Promise<EvidenceRow[]> {
  return db.select(EVIDENCE_COLUMNS).from(captureLocationEvidence).where(eq(captureLocationEvidence.assetId, assetId));
}

async function loadMediaObject(
  db: DatabaseOrTransaction,
  mediaObjectId: string,
): Promise<MediaObjectRow | null> {
  const [row] = await db
    .select(MEDIA_OBJECT_COLUMNS)
    .from(captureMediaObjects)
    .where(eq(captureMediaObjects.id, mediaObjectId));
  return row ?? null;
}

/** How many OTHER assets already reference this object — the deduplication fact. */
async function referenceCount(db: DatabaseOrTransaction, mediaObjectId: string): Promise<number> {
  const [row] = await db
    .select({ assets: count() })
    .from(captureAssets)
    .where(eq(captureAssets.mediaObjectId, mediaObjectId));
  return row?.assets ?? 0;
}

async function hydrate(db: DatabaseOrTransaction, row: AssetRow): Promise<CaptureAsset> {
  const mediaObject = await loadMediaObject(db, row.mediaObjectId);
  if (!mediaObject) {
    // Unreachable: the foreign key is `restrict`, so an object row cannot be
    // deleted out from under an asset. If it is ever reached, the constraint has
    // been dropped and a capture is about to be published with no lifecycle.
    throw new ApiError('internal_error', 'A capture asset has no media object.');
  }
  const [evidence, references] = await Promise.all([
    loadEvidence(db, row.id),
    referenceCount(db, row.mediaObjectId),
  ]);
  return toCaptureAsset(row, { mediaObject, deduplicated: references > 1, evidence });
}

/**
 * One asset, if it belongs to this contributor. See {@link findOwnedSession}
 * for why ownership is part of the lookup.
 */
export async function findOwnedAsset(
  db: Database,
  assetId: string,
  oxyUserId: string,
): Promise<CaptureAsset | null> {
  const [row] = await db
    .select(ASSET_COLUMNS)
    .from(captureAssets)
    .where(and(eq(captureAssets.id, assetId), eq(captureAssets.oxyUserId, oxyUserId)));
  return row ? hydrate(db, row) : null;
}

/**
 * The object key behind one of the caller's own assets.
 *
 * The ONE function in this module that returns an object key, and it returns
 * the bare string rather than a row — so a caller cannot accidentally spread it
 * into a response. Raw imagery is never a public path (#13): the key exists to
 * be handed to the object store inside this process and is absent from every
 * shape `captureMapper` builds.
 */
export async function objectKeyForOwnedAsset(
  db: Database,
  assetId: string,
  oxyUserId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ objectKey: captureMediaObjects.objectKey })
    .from(captureAssets)
    .innerJoin(captureMediaObjects, eq(captureMediaObjects.id, captureAssets.mediaObjectId))
    .where(and(eq(captureAssets.id, assetId), eq(captureAssets.oxyUserId, oxyUserId)));
  return row?.objectKey ?? null;
}

/** Every asset in one of the contributor's sessions, oldest first. */
export async function listSessionAssets(
  db: Database,
  sessionId: string,
  oxyUserId: string,
): Promise<CaptureAsset[]> {
  const rows = await db
    .select(ASSET_COLUMNS)
    .from(captureAssets)
    .where(and(eq(captureAssets.sessionId, sessionId), eq(captureAssets.oxyUserId, oxyUserId)))
    .orderBy(captureAssets.createdAt);
  return Promise.all(rows.map((row) => hydrate(db, row)));
}

/**
 * Register a contribution and decide whether its bytes need uploading.
 *
 * ## The three cases, and why the middle one is not an error
 *
 *  1. No live object has these bytes — create one as `expected`, and the caller
 *     issues an upload target for it.
 *  2. A live object has them and is still `expected` — another contribution is
 *     mid-upload with the identical file. Reuse the row and RE-ISSUE a target
 *     for the same key. Two concurrent PUTs of identical bytes to one key are
 *     harmless, and refusing the second contributor because somebody else's
 *     upload is in flight would be a race the contributor cannot act on.
 *  3. A live object has them and is `stored` — the bytes are already here.
 *     The asset lands `uploaded` and NO upload target is issued. That is the
 *     whole of exact deduplication, and it happens before a single byte moves.
 *
 * In cases 2 and 3 the object's expiry is raised to the later of the two
 * policies. See `extendedExpiry` for why that is not counted as an extension.
 */
export async function registerAsset(
  db: Database,
  session: { id: string; oxyUserId: string },
  input: RegisterAssetInput,
  options: { keyPrefix: string; now?: Date },
): Promise<RegisteredAsset> {
  const now = options.now ?? new Date();
  const plan = planOriginalRetention(input.mediaKind, now);
  const intentExpiresAt = uploadIntentExpiry(now);

  const anchor = resolveCaptureAnchor(input.evidence);
  if (anchor === null) {
    // #9: a contribution is useful only if GoWay can establish a geographic
    // anchor, and the alternative to refusing is inventing one.
    throw new ApiError(
      'validation_failed',
      'A contribution needs a position: capture-time coordinates, GPS metadata from the media, or a place the contributor selected.',
    );
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ ...MEDIA_OBJECT_COLUMNS, objectKey: captureMediaObjects.objectKey })
      .from(captureMediaObjects)
      .where(and(eq(captureMediaObjects.contentHash, input.contentHash), isNull(captureMediaObjects.deletedAt)))
      // The partial unique index guarantees at most one live row per hash; the
      // lock is against a concurrent registration of the same bytes, which
      // would otherwise both see "no object" and both try to insert one.
      .for('update');

    let objectId: string;
    let objectKey: string;
    let uploadRequired: boolean;

    if (existing) {
      objectId = existing.id;
      objectKey = existing.objectKey;
      uploadRequired = existing.storageState === 'expected';
      await tx
        .update(captureMediaObjects)
        .set({
          expiresAt: extendedExpiry(existing.expiresAt, plan),
          ...(uploadRequired ? { uploadIntentExpiresAt: intentExpiresAt } : {}),
          /**
           * A new contribution CANCELS a pending deletion.
           *
           * `deleting` means the sweeper recorded an intent and has not yet
           * called the store. #10 requires it to re-check that nothing still
           * needs the object before deleting, and a contribution arriving in
           * that window is exactly such a reference: handing this contributor
           * an asset whose bytes are about to disappear would be worse than
           * either deleting or keeping. The row is `stored`, so it already has
           * a `stored_at` and the state CHECK is satisfied.
           */
          ...(existing.storageState === 'deleting' ? { storageState: 'stored' as const } : {}),
          updatedAt: now,
        })
        .where(eq(captureMediaObjects.id, objectId));
    } else {
      objectId = uuidv7();
      objectKey = objectKeyFor(options.keyPrefix, objectId, now);
      uploadRequired = true;
      await tx.insert(captureMediaObjects).values({
        id: objectId,
        contentHash: input.contentHash,
        objectKey,
        contentType: input.contentType,
        byteSize: input.byteSize,
        storageState: 'expected',
        uploadIntentExpiresAt: intentExpiresAt,
        retentionClass: plan.retentionClass,
        retentionReason: plan.retentionReason,
        expiresAt: plan.expiresAt,
        ...(plan.deletionEligibleAt ? { deletionEligibleAt: plan.deletionEligibleAt } : {}),
      });
    }

    const [assetRow] = await tx
      .insert(captureAssets)
      .values({
        sessionId: session.id,
        mediaObjectId: objectId,
        oxyUserId: session.oxyUserId,
        mediaKind: input.mediaKind,
        source: input.source,
        // `uploaded` straight away when the bytes are already here: there is
        // nothing left for the contributor to do, and leaving it `expected`
        // would strand it waiting for an upload that will never happen.
        state: uploadRequired ? 'expected' : 'uploaded',
        ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
        anchorLatitude: anchor.coordinate.latitude,
        anchorLongitude: anchor.coordinate.longitude,
        anchorOrigin: anchor.origin,
        anchorWitness: anchor.witness,
        ...(anchor.accuracyMeters === undefined ? {} : { anchorAccuracyMeters: anchor.accuracyMeters }),
        ...cameraColumns(input.camera),
      })
      .returning(ASSET_COLUMNS);
    if (!assetRow) throw new ApiError('internal_error', 'The capture asset was not created.');

    if (input.evidence.length > 0) {
      await tx.insert(captureLocationEvidence).values(
        input.evidence.map((evidence) => ({
          assetId: assetRow.id,
          origin: evidence.origin,
          witness: evidence.witness,
          latitude: evidence.coordinate.latitude,
          longitude: evidence.coordinate.longitude,
          ...(evidence.accuracyMeters === undefined ? {} : { accuracyMeters: evidence.accuracyMeters }),
          ...(evidence.altitudeMeters === undefined ? {} : { altitudeMeters: evidence.altitudeMeters }),
          ...(evidence.headingDegrees === undefined ? {} : { headingDegrees: evidence.headingDegrees }),
          ...(evidence.observedAt === undefined ? {} : { observedAt: new Date(evidence.observedAt) }),
        })),
      );
    }

    noteEvidenceDisagreement(assetRow.id, input.evidence);

    return {
      asset: await hydrate(tx, assetRow),
      objectKey,
      uploadRequired,
      byteSize: input.byteSize,
      contentType: input.contentType,
    };
  });
}

/** The camera columns for a metadata block, omitting what it does not carry. */
function cameraColumns(camera: CaptureCameraMetadata | undefined) {
  if (!camera) return {};
  return {
    ...(camera.widthPixels === undefined ? {} : { cameraWidthPixels: camera.widthPixels }),
    ...(camera.heightPixels === undefined ? {} : { cameraHeightPixels: camera.heightPixels }),
    ...(camera.exifOrientation === undefined ? {} : { exifOrientation: camera.exifOrientation }),
    ...(camera.focalLengthMm === undefined ? {} : { focalLengthMm: camera.focalLengthMm }),
    ...(camera.focalLength35mm === undefined ? {} : { focalLengthEquivalentMm: camera.focalLength35mm }),
    ...(camera.make === undefined ? {} : { cameraMake: camera.make }),
    ...(camera.model === undefined ? {} : { cameraModel: camera.model }),
    ...(camera.lens === undefined ? {} : { cameraLens: camera.lens }),
    ...(camera.durationSeconds === undefined ? {} : { durationSeconds: camera.durationSeconds }),
    ...(camera.frameRate === undefined ? {} : { frameRate: camera.frameRate }),
  };
}

/**
 * Record that the bytes are actually there.
 *
 * IDEMPOTENT, because a contributor on a flaky connection retries and must not
 * get a second asset, a second object or a 409 for succeeding twice. An asset
 * whose object is already `stored` is returned unchanged — the finalize is a
 * statement of fact, and the fact does not change on the second telling.
 *
 * The caller confirms the bytes with the object store BEFORE calling this. The
 * store's byte count is what is written; the client's declaration is only ever
 * what the upload target was signed for.
 */
export async function finalizeAsset(
  db: Database,
  assetId: string,
  oxyUserId: string,
  confirmed: { byteSize: number; now?: Date },
): Promise<CaptureAsset | null> {
  const now = confirmed.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select(ASSET_COLUMNS)
      .from(captureAssets)
      .where(and(eq(captureAssets.id, assetId), eq(captureAssets.oxyUserId, oxyUserId)));
    if (!row) return null;

    const mediaObject = await loadMediaObject(tx, row.mediaObjectId);
    if (!mediaObject) throw new ApiError('internal_error', 'A capture asset has no media object.');

    if (mediaObject.storageState === 'expected') {
      await tx
        .update(captureMediaObjects)
        .set({
          storageState: 'stored',
          storedAt: now,
          confirmedByteSize: confirmed.byteSize,
          updatedAt: now,
        })
        .where(eq(captureMediaObjects.id, mediaObject.id));
    }

    // Only from `expected`. A later state — accepted, integrated, rejected — is
    // a decision something else already made about this contribution, and a
    // retried finalize must not walk it backwards.
    const [updated] = row.state === 'expected'
      ? await tx
          .update(captureAssets)
          .set({ state: 'uploaded', updatedAt: now })
          .where(eq(captureAssets.id, assetId))
          .returning(ASSET_COLUMNS)
      : [row];
    if (!updated) throw new ApiError('internal_error', 'The capture asset vanished during finalize.');
    return hydrate(tx, updated);
  });
}

// ── Storage reporting ───────────────────────────────────────────────────────

/**
 * Bytes stored, by retention class, with what is about to expire.
 *
 * COMPUTED from the rows rather than read from maintained counters. A counter
 * drifts the first time a delete takes a path that forgot to decrement it, and
 * a budget enforced against a drifted counter is confidently wrong in whichever
 * direction the bug went — which is worse than having no budget, because
 * somebody will trust it.
 *
 * `deduplicatedBytes` is what a second contribution of identical media did NOT
 * cost: `(references - 1) × size`, summed. It is the honest form of "duplicate
 * bytes avoided" from #10's metric list, and it is the number that answers
 * whether hashing before uploading is earning its complexity.
 *
 * `scopeKeyPrefix` narrows to a geographic bucket — one character for a region,
 * nine for a doorway — which is the granularity a per-cell budget is set at.
 */
export async function summarizeCaptureStorage(
  db: Database,
  options: { scopeKeyPrefix?: string; now?: Date } = {},
): Promise<CaptureStorageUsage[]> {
  const now = options.now ?? new Date();
  // ISO strings rather than `Date` objects: these are interpolated into raw
  // `sql` fragments, where drizzle has no column to infer a driver mapping
  // from, and postgres.js refuses to bind a bare Date it was given no type for.
  const withinDays = (days: number) =>
    new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  /**
   * How many contributions each object backs, as a GROUPED subquery rather than
   * a correlated one.
   *
   * A correlated `(select count(*) … where media_object_id = id)` reads
   * naturally and is wrong here: drizzle renders a column in a select list
   * WITHOUT its table prefix, so the outer `capture_media_objects.id` resolves
   * to the inner `capture_assets.id` and the predicate is never true. The bug
   * is silent — every count comes back 0, which looks exactly like "nothing was
   * ever deduplicated".
   */
  const references = db
    .select({
      mediaObjectId: captureAssets.mediaObjectId,
      assets: count().as('assets'),
    })
    .from(captureAssets)
    .groupBy(captureAssets.mediaObjectId)
    .as('references');

  const size = sql`coalesce(${captureMediaObjects.confirmedByteSize}, ${captureMediaObjects.byteSize})`;
  const live = sql`${captureMediaObjects.deletedAt} is null`;
  const scoped = options.scopeKeyPrefix
    ? sql`${live} and exists (
        select 1 from ${captureAssets}
        where ${captureAssets.mediaObjectId} = ${captureMediaObjects.id}
          and ${captureAssets.geoCell} like ${`${options.scopeKeyPrefix}%`}
      )`
    : live;

  const rows = await db
    .select({
      retentionClass: captureMediaObjects.retentionClass,
      storedBytes: sql<string>`coalesce(sum(${size}), 0)::bigint`,
      expiringWithin7dBytes: sql<string>`coalesce(sum(case when ${captureMediaObjects.expiresAt} <= ${withinDays(7)}::timestamptz then ${size} else 0 end), 0)::bigint`,
      expiringWithin30dBytes: sql<string>`coalesce(sum(case when ${captureMediaObjects.expiresAt} <= ${withinDays(30)}::timestamptz then ${size} else 0 end), 0)::bigint`,
      deduplicatedBytes: sql<string>`coalesce(sum(greatest(coalesce(${references.assets}, 0) - 1, 0) * ${size}), 0)::bigint`,
      objectCount: count(),
    })
    .from(captureMediaObjects)
    .leftJoin(references, eq(references.mediaObjectId, captureMediaObjects.id))
    .where(scoped)
    .groupBy(captureMediaObjects.retentionClass);

  const byClass = new Map(rows.map((row) => [row.retentionClass, row]));
  // Every class, always, including the ones with nothing in them. A report that
  // omits an empty class reads as "no data" rather than "no bytes", and the
  // difference matters when the question is whether retention is working.
  return CAPTURE_RETENTION_CLASSES.map((retentionClass: CaptureRetentionClass): CaptureStorageUsage => {
    const row = byClass.get(retentionClass);
    // `bigint` arrives from the driver as a string; `Number` is exact well past
    // any plausible byte total and keeps the contract a plain number.
    return {
      retentionClass,
      storedBytes: Number(row?.storedBytes ?? 0),
      expiringWithin7dBytes: Number(row?.expiringWithin7dBytes ?? 0),
      expiringWithin30dBytes: Number(row?.expiringWithin30dBytes ?? 0),
      deduplicatedBytes: Number(row?.deduplicatedBytes ?? 0),
      objectCount: Number(row?.objectCount ?? 0),
    };
  });
}
