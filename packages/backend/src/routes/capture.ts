/**
 * The Street 3D capture HTTP surface.
 *
 * ## The flow, and the one thing it never does
 *
 *     GET  /captures/policy                    what may be contributed, and for how long
 *     POST /captures/sessions                  open a contribution act, recording consent
 *     POST /captures/sessions/:id/assets       register a contribution, get an upload target
 *     PUT  <the object store, directly>        the bytes, never through this process
 *     POST /captures/assets/:id/finalize       confirm the bytes landed
 *     GET  /captures/sessions/:id[/assets]     what GoWay is holding, and until when
 *     GET  /captures/assets/:id
 *
 * The API NEVER proxies media. There is no route here that accepts a file, and
 * adding one would make a single Express worker the bandwidth bill and the
 * bottleneck for every contribution — and put a half-gigabyte video in the
 * memory of the process that also answers map reads.
 *
 * ## Everything here requires an Oxy session, and that is not an oversight
 *
 * GoWay's map opens without an account and browsing, search and routing must
 * answer a signed-out visitor. Contribution is the opposite case and #9 says so
 * explicitly: submitting requires an authenticated account so consent, deletion
 * requests, abuse controls and attribution can be handled at all. An anonymous
 * contribution is one nobody can withdraw and nobody can be accountable for.
 *
 * The one exception is `GET /captures/policy`, which is behind `optionalAuth`:
 * a visitor reading about contributing — before they have an account — is
 * entitled to know what GoWay would keep and for how long. Telling somebody the
 * retention policy only after they have signed in would be an odd way to obtain
 * informed consent.
 *
 * ## Nothing here touches the ORM
 *
 * Every statement goes through `db/capture/captureRepository`, which is also the
 * only thing that maps a row to the published contract. A handler that reached
 * for a drizzle table would be one `select(captureMediaObjects)` away from
 * serving an object key — a durable path into raw imagery — as an API field.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { CaptureUploadIntent, CaptureUploadPolicy, CaptureUploadTicket } from '@goway/shared-types';
import { captureConfig } from '../config/capture';
import {
  createCaptureSession,
  finalizeAsset,
  findOwnedAsset,
  findOwnedSession,
  listSessionAssets,
  objectKeyForOwnedAsset,
  registerAsset,
} from '../db/capture/captureRepository';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { parseBody } from '../http/validation';
import type { CaptureObjectStore } from '../storage/objectStore';
import {
  createSessionSchema,
  finalizeAssetSchema,
  normalizedCamera,
  registerAssetSchema,
} from './captureSchemas';

/**
 * Forward a rejected handler to the error middleware.
 *
 * Express 5 does this for a returned promise on its own. It is spelled out
 * anyway because the failure mode when it does not is a request that hangs
 * until the client's timeout with nothing logged.
 */
function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/** The Oxy session on the request. Never read from the body or the query. */
function requiredCallerId(request: Request): string {
  const id = request.userId;
  if (typeof id !== 'string' || id.length === 0) {
    // Behind `requireAuth` this is unreachable; if it is ever reached, the
    // middleware has been rewired and a contribution is about to be recorded
    // against nobody.
    throw new ApiError('unauthorized', 'Contributing requires an Oxy session.');
  }
  return id;
}

/**
 * A single path parameter as a string.
 *
 * Express 5 types a route parameter as `string | string[]`, and the array case
 * is reachable. An id is one segment, so anything else is a malformed request
 * rather than a capture that does not exist.
 */
function idParam(request: Request, name: string, what: string): string {
  const value = request.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('bad_request', `A ${what} id must be a single path segment.`);
  }
  return value;
}

/** The current upload policy, as the contract publishes it. */
export function currentUploadPolicy(): CaptureUploadPolicy {
  return {
    consentVersion: captureConfig.consentVersion,
    contentHashAlgorithm: 'sha256',
    photo: {
      contentTypes: [...captureConfig.photoContentTypes],
      maxByteSize: captureConfig.maxPhotoBytes,
    },
    video: {
      contentTypes: [...captureConfig.videoContentTypes],
      maxByteSize: captureConfig.maxVideoBytes,
      maxDurationSeconds: captureConfig.maxVideoDurationSeconds,
    },
    retentionDays: { ...captureConfig.retentionDays },
  };
}

/**
 * Refuse media this deployment does not accept, BEFORE anything is stored.
 *
 * Size is `payload_too_large` and type is `validation_failed`, and the two are
 * different advice: the first means "send a smaller file", the second means
 * "GoWay cannot read this format at all". A client that cannot tell them apart
 * retries the unretryable one.
 *
 * Checked server-side even though the policy is published, because a published
 * policy is a courtesy to a well-behaved client and this is the enforcement.
 */
function assertAcceptableMedia(body: { mediaKind: 'photo' | 'video'; contentType: string; byteSize: number; camera?: { durationSeconds?: number } }): void {
  const limits =
    body.mediaKind === 'video'
      ? { types: captureConfig.videoContentTypes, maxBytes: captureConfig.maxVideoBytes }
      : { types: captureConfig.photoContentTypes, maxBytes: captureConfig.maxPhotoBytes };

  if (!limits.types.includes(body.contentType)) {
    throw new ApiError('validation_failed', `GoWay does not accept ${body.contentType} for a ${body.mediaKind}.`, {
      field: 'contentType',
      mediaKind: body.mediaKind,
    });
  }
  if (body.byteSize > limits.maxBytes) {
    throw new ApiError('payload_too_large', `A ${body.mediaKind} may not exceed ${limits.maxBytes} bytes.`, {
      field: 'byteSize',
      maxByteSize: limits.maxBytes,
    });
  }
  const duration = body.camera?.durationSeconds;
  if (duration !== undefined && duration > captureConfig.maxVideoDurationSeconds) {
    throw new ApiError('validation_failed', 'The video is longer than GoWay currently accepts.', {
      field: 'camera.durationSeconds',
      maxDurationSeconds: captureConfig.maxVideoDurationSeconds,
    });
  }
}

export interface CaptureRouterDependencies {
  /** Fail-closed: refuses the request unless it carries a valid Oxy session. */
  requireAuth: RequestHandler;
  /** Resolves a session when one is present and continues regardless. */
  optionalAuth: RequestHandler;
  /**
   * The object store, or `null` when this deployment has none configured.
   *
   * Nullable rather than absent, so a GoWay without contribution storage still
   * serves the map: the upload-intent route answers `service_unavailable` and
   * nothing else changes. A backend that refused to boot without an S3 bucket
   * would make one optional feature a hard dependency of the whole product.
   */
  objectStore: CaptureObjectStore | null;
}

export function createCaptureRouter(dependencies: CaptureRouterDependencies): Router {
  const { requireAuth, optionalAuth, objectStore } = dependencies;
  const router: Router = Router();

  /** The store, or a refusal a client can act on. */
  function store(): CaptureObjectStore {
    if (!objectStore) {
      throw new ApiError(
        'service_unavailable',
        'Contribution is not available on this GoWay deployment: no object store is configured.',
      );
    }
    return objectStore;
  }

  /**
   * `GET /captures/policy` — what may be contributed, and for how long.
   *
   * The retention numbers here are what a contribution UI shows somebody BEFORE
   * they submit, which is #9's requirement and is not satisfiable from a
   * constant a client compiled in months ago. They are maxima and configuration,
   * never a guarantee.
   */
  router.get(
    '/captures/policy',
    optionalAuth,
    route(async (_request, response) => {
      response.json(currentUploadPolicy());
    }),
  );

  /**
   * `POST /captures/sessions` — open a contribution act.
   *
   * The body must name the consent version it displayed. A session is refused
   * when that is not the current one: consent to superseded text is not consent
   * to what GoWay does now, and silently accepting it would leave an audit
   * trail that says somebody agreed to something they were never shown.
   */
  router.post(
    '/captures/sessions',
    requireAuth,
    route(async (request, response) => {
      const input = parseBody(createSessionSchema, request.body);
      if (input.consentVersion !== captureConfig.consentVersion) {
        throw new ApiError(
          'conflict',
          'The contribution consent has changed. Show the current version and start a new session.',
          { field: 'consentVersion', expected: captureConfig.consentVersion },
        );
      }
      const session = await createCaptureSession(getDb(), requiredCallerId(request), input);
      response
        .status(201)
        .location(`/api/v1/captures/sessions/${encodeURIComponent(session.id)}`)
        .json(session);
    }),
  );

  /** `GET /captures/sessions/:id` — one of the caller's own sessions. */
  router.get(
    '/captures/sessions/:id',
    requireAuth,
    route(async (request, response) => {
      const session = await findOwnedSession(getDb(), idParam(request, 'id', 'session'), requiredCallerId(request));
      if (!session) throw new ApiError('not_found', 'No capture session of yours has that id.');
      response.json(session);
    }),
  );

  /**
   * `GET /captures/sessions/:id/assets` — everything in one session.
   *
   * This is the contributor-facing history #13 asks for: contribution OBJECTS,
   * each with its state, its privacy gate and its expiry. It is deliberately
   * not a feed of every capture the account has ever made ordered by time —
   * that shape is a travel timeline, and GoWay does not build one.
   */
  router.get(
    '/captures/sessions/:id/assets',
    requireAuth,
    route(async (request, response) => {
      const sessionId = idParam(request, 'id', 'session');
      const oxyUserId = requiredCallerId(request);
      const db = getDb();
      const session = await findOwnedSession(db, sessionId, oxyUserId);
      if (!session) throw new ApiError('not_found', 'No capture session of yours has that id.');
      response.json(await listSessionAssets(db, sessionId, oxyUserId));
    }),
  );

  /**
   * `POST /captures/sessions/:id/assets` — register a contribution and get a
   * scoped, expiring upload target.
   *
   * The asset row and its object row are written BEFORE any bytes exist, which
   * is what makes an orphaned object detectable: an object in the store with no
   * row is a leak, and a row that never leaves `expected` past its upload window
   * is an abandoned upload. Both are visible without listing the bucket.
   *
   * `upload` is absent from the response when these exact bytes are already
   * stored. That is a success, not a rejection — the contribution is registered
   * and points at the existing object, and the client goes straight to
   * finalizing.
   */
  router.post(
    '/captures/sessions/:id/assets',
    requireAuth,
    route(async (request, response) => {
      const sessionId = idParam(request, 'id', 'session');
      const oxyUserId = requiredCallerId(request);
      const input = parseBody(registerAssetSchema, request.body);
      assertAcceptableMedia(input);

      // Checked before anything is written, so an unknown or someone else's
      // session is a 404 rather than the 500 a foreign-key violation produces.
      const db = getDb();
      const session = await findOwnedSession(db, sessionId, oxyUserId);
      if (!session) throw new ApiError('not_found', 'No capture session of yours has that id.');

      // The store is resolved BEFORE the rows are written: a deployment with no
      // object store must not leave an `expected` object nobody can ever upload.
      const objects = store();

      const registered = await registerAsset(
        db,
        { id: sessionId, oxyUserId },
        {
          mediaKind: input.mediaKind,
          source: input.source,
          contentHash: input.contentHash,
          byteSize: input.byteSize,
          contentType: input.contentType,
          ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
          evidence: input.location,
          ...(normalizedCamera(input.camera) ? { camera: normalizedCamera(input.camera) } : {}),
        },
        { keyPrefix: captureConfig.keyPrefix },
      );

      const ticket: CaptureUploadTicket = { asset: registered.asset };
      if (registered.uploadRequired) {
        const target = await objects.createUploadTarget({
          key: registered.objectKey,
          contentType: registered.contentType,
          byteSize: registered.byteSize,
          ttlSeconds: captureConfig.uploadIntentTtlSeconds,
        });
        const upload: CaptureUploadIntent = {
          assetId: registered.asset.id,
          method: 'PUT',
          url: target.url,
          headers: target.headers,
          expiresAt: target.expiresAt.toISOString(),
          byteSize: registered.byteSize,
          contentType: registered.contentType,
        };
        ticket.upload = upload;
      }

      response
        .status(201)
        .location(`/api/v1/captures/assets/${encodeURIComponent(registered.asset.id)}`)
        .json(ticket);
    }),
  );

  /** `GET /captures/assets/:id` — one of the caller's own contributions. */
  router.get(
    '/captures/assets/:id',
    requireAuth,
    route(async (request, response) => {
      const asset = await findOwnedAsset(getDb(), idParam(request, 'id', 'asset'), requiredCallerId(request));
      if (!asset) throw new ApiError('not_found', 'No capture of yours has that id.');
      response.json(asset);
    }),
  );

  /**
   * `POST /captures/assets/:id/finalize` — confirm the bytes landed.
   *
   * GoWay ASKS THE OBJECT STORE rather than believing the client. A finalize is
   * a claim that an upload succeeded, and an upload that did not — cancelled,
   * truncated, refused by the store because the signed length did not match —
   * would otherwise produce an asset GoWay believes in and a reconstruction job
   * that fails far away from the cause.
   *
   * Idempotent: a contributor on a flaky connection retries, and a second
   * finalize of a stored object returns the same asset rather than a 409 for
   * succeeding twice.
   */
  router.post(
    '/captures/assets/:id/finalize',
    requireAuth,
    route(async (request, response) => {
      const assetId = idParam(request, 'id', 'asset');
      const oxyUserId = requiredCallerId(request);
      parseBody(finalizeAssetSchema, request.body ?? {});

      const db = getDb();
      const objects = store();
      const existing = await findOwnedAsset(db, assetId, oxyUserId);
      if (!existing) throw new ApiError('not_found', 'No capture of yours has that id.');

      // Already confirmed: answer with what GoWay holds and do not re-stat.
      if (existing.state !== 'expected') {
        response.json(existing);
        return;
      }

      // The key never leaves this process — `AGENTS.md` and #13 both say raw
      // imagery is never a public path — so it is fetched here, handed to the
      // store, and is absent from every shape the mapper builds.
      const objectKey = await objectKeyForOwnedAsset(db, assetId, oxyUserId);
      if (objectKey === null) throw new ApiError('not_found', 'No capture of yours has that id.');
      const stat = await objects.statObject(objectKey);
      if (!stat) {
        throw new ApiError(
          'conflict',
          'The object store has no bytes for this capture yet. Upload them, then finalize.',
        );
      }
      if (stat.byteSize !== existing.media.byteSize) {
        throw new ApiError('conflict', 'The stored object is not the size this capture was registered for.', {
          field: 'byteSize',
          registeredByteSize: existing.media.byteSize,
          storedByteSize: stat.byteSize,
        });
      }

      const asset = await finalizeAsset(db, assetId, oxyUserId, { byteSize: stat.byteSize });
      if (!asset) throw new ApiError('not_found', 'No capture of yours has that id.');
      response.json(asset);
    }),
  );

  return router;
}
