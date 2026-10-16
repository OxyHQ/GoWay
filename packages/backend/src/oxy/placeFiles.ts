/**
 * The Oxy files a place's gallery references — checked with the caller,
 * referenced by GoWay, never fetched.
 *
 * A gallery item is an Oxy file id. The client uploads the image to Oxy
 * itself; GoWay's part is to make sure the id it is handed is a file it may
 * publish, and to tell Oxy the place uses it. GoWay never downloads, proxies or
 * stores an image: Oxy's CDN serves the bytes to whoever renders the gallery.
 *
 * ## Checked with the CALLER's bearer, on a short-lived client
 *
 * The same shape as `oxy/accountRoles`, for the same reason: what is being
 * established is something about THIS caller ("the file is mine"), and the
 * process-wide client must never carry a caller's token. Two questions, one
 * client, disposed after:
 *
 *  1. `GET /assets/:id` — the file exists, is `active`, is an image, and its
 *     `ownerUserId` is the session's account or the person operating it. Oxy
 *     answers this for any signed-in caller, so the OWNER comparison is GoWay's
 *     and is the whole of the check — nothing else stops somebody publishing a
 *     file id they merely saw.
 *  2. `POST /assets/batch-access` — the file's `visibility` is `public`. The
 *     record above does not carry it.
 *
 * ## Referenced and unreferenced as GoWay (Oxy ADR 0043 D4)
 *
 * The place's use of the file is GoWay's, not the caller's: it is recorded and
 * removed with GoWay's OWN service identity (`OxyServer#assets.references`,
 * scope `files:references:write`), as `{ fileId, entityType: 'place',
 * entityId: placeId }` — the application is the token's and is never sent.
 * That is what lets the business withdraw a customer's photo: Oxy lets a
 * session remove only a reference to a file it owns or a reference it made, so
 * the business's session cannot drop the contributor's, and GoWay's token can.
 * One principal makes and removes every reference, so a removal always names
 * what the add created.
 *
 * A reference never changes the file's visibility. The client uploads public,
 * and (2) refuses anything else; GoWay never sets visibility.
 *
 * ## Outcomes, translated once
 *
 *  - a file that is missing, not the caller's, in the trash, not an image or
 *    not public is a refusal the caller can act on (`validation_failed` or
 *    `forbidden`), naming the field and never the file's metadata;
 *  - a `401` on the caller's session is the session failing at Oxy:
 *    `unauthorized`;
 *  - anything else — including GoWay's own token being refused — is Oxy being
 *    unavailable to GoWay: it FAILS CLOSED with `503 service_unavailable` and
 *    records nothing.
 *
 * ## Unreferencing is best effort
 *
 * Removing an item drops its reference after the removal committed. A failure
 * is logged, not surfaced: the item is already gone from GoWay, and a reference
 * Oxy still holds costs the owner nothing but the file staying alive (Oxy's
 * reconciliation, ADR 0043 D6, is the net). A merge does NOT re-reference: the
 * reference keeps naming the absorbed place, whose id is a permanent alias of
 * the survivor (`place_media.oxyLinkPlaceId`).
 */

import {
  OxyApiError,
  OxyServices,
  type ServiceFileReference,
  type ServiceFileReferenceResult,
} from '@oxy.so/core';
import { PLACE_MEDIA_MIME_TYPES } from '@goway/contracts';
import { ApiError } from '../http/apiError';
import { logger } from '../utils/logger';
import type { OxyCaller } from './accountRoles';

/** The entity type a place's gallery references name. */
export const PLACE_ENTITY_TYPE = 'place';

/** One question to Oxy may take this long, in milliseconds — as for account roles. */
const OXY_REQUEST_TIMEOUT_MS = 5_000;

/**
 * How the `OxyServer` behind {@link PlaceFileStoreOptions.references} is built:
 * the caller's checks' bounds — one attempt, five seconds. The SDK retries an
 * idempotent DELETE with backoff by default, and a withdrawal waits for its
 * removal, so a struggling Oxy would hold the caller's `204` for seconds for
 * a removal that is best effort anyway.
 */
export const OXY_REFERENCE_CLIENT_OPTIONS = {
  enableRetry: false,
  requestTimeout: OXY_REQUEST_TIMEOUT_MS,
} as const;

/** What GoWay keeps of a file it may publish. */
export interface PlaceFile {
  readonly fileId: string;
  readonly mime: string;
  readonly width?: number;
  readonly height?: number;
}

/** The Oxy files a place's gallery references. */
export interface PlaceFileStore {
  /**
   * Check that `fileId` is a public image the caller owns, and reference it
   * from the place. Throws the refusal or the `503` — never resolves for a
   * file GoWay may not publish.
   */
  attach(caller: OxyCaller, fileId: string, placeId: string): Promise<PlaceFile>;
  /**
   * Drop the place's reference to the file, as GoWay — whoever withdrew the
   * item. Best effort: logs, never throws.
   */
  detach(fileId: string, placeId: string): Promise<void>;
}

/** GoWay's own references: `OxyServer#assets.references`, on GoWay's service identity. */
export interface PlaceFileReferences {
  add(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  remove(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
}

export interface PlaceFileStoreOptions {
  /** The Oxy API origin, for the caller's short-lived client. */
  readonly oxyApiUrl: string;
  /**
   * Adds and removes GoWay's references with GoWay's own token: the
   * `assets.references` of an `OxyServer` built with
   * {@link OXY_REFERENCE_CLIENT_OPTIONS}.
   */
  readonly references: PlaceFileReferences;
}

const ACCEPTED_MIME_TYPES: ReadonlySet<string> = new Set(PLACE_MEDIA_MIME_TYPES);

/** A positive integer from Oxy's free-form metadata, or `undefined`. */
function dimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function refused(message: string, issue: string): ApiError {
  return new ApiError('validation_failed', message, { field: 'fileId', issue });
}

function oxyStatus(error: unknown): number | undefined {
  return error instanceof OxyApiError ? error.status : undefined;
}

function unavailable(): ApiError {
  return new ApiError(
    'service_unavailable',
    'The file cannot be checked right now because Oxy is unavailable. Try again shortly.',
  );
}

/** An Oxy failure on the CALLER's session: `null` for "no such file", throws for everything else. */
function translate(error: unknown): null {
  if (error instanceof ApiError) throw error;
  const status = oxyStatus(error);
  if (status === 403 || status === 404) return null;
  if (status === 401) {
    throw new ApiError('unauthorized', 'Your Oxy session is no longer valid. Sign in again.');
  }
  logger.warn({ status }, 'Oxy files unavailable; refusing a gallery write');
  throw unavailable();
}

function placeReference(fileId: string, placeId: string): ServiceFileReference {
  return { fileId, entityType: PLACE_ENTITY_TYPE, entityId: placeId };
}

export function createOxyPlaceFileStore(options: PlaceFileStoreOptions): PlaceFileStore {
  const { references } = options;

  function clientFor(caller: OxyCaller): OxyServices {
    if (caller.accessToken === null) {
      // Behind `requireAuth` a session always carries its token; without one
      // there is nobody to check the file against.
      throw new ApiError('unauthorized', 'This request requires an Oxy session.');
    }
    const client = new OxyServices({
      baseURL: options.oxyApiUrl,
      enableCache: false,
      enableRetry: false,
      requestTimeout: OXY_REQUEST_TIMEOUT_MS,
    });
    client.session.setAccessToken(caller.accessToken);
    return client;
  }

  /** The caller's checks: resolves with what GoWay keeps, or throws the refusal. */
  async function check(caller: OxyCaller, fileId: string): Promise<PlaceFile> {
    const client = clientFor(caller);
    try {
      const record = await client.assets.get(fileId).catch(translate);
      if (record === null) throw refused('No Oxy file has that id.', 'not_found');
      const { file } = record;

      const owners = [caller.oxyAccountId, caller.operatedByOxyUserId].filter(
        (id): id is string => id !== null,
      );
      // An application's or Oxy's own file has no account owner: never the caller's.
      if (typeof file.ownerUserId !== 'string' || !owners.includes(file.ownerUserId)) {
        throw new ApiError('forbidden', 'You can add only a file you uploaded to Oxy yourself.', {
          field: 'fileId',
          issue: 'not_owner',
        });
      }
      if (file.status !== 'active') throw refused('That Oxy file is in the trash.', 'not_active');
      if (!ACCEPTED_MIME_TYPES.has(file.mime))
        throw refused('That Oxy file is not an image a gallery can show.', 'not_an_image');

      const access = await client.assets.access([{ fileId }]).catch(translate);
      if (access?.results[fileId]?.visibility !== 'public') {
        throw refused(
          'Upload the image to Oxy as public before adding it to a place.',
          'not_public',
        );
      }

      const width = dimension(file.metadata?.width);
      const height = dimension(file.metadata?.height);
      return {
        fileId,
        mime: file.mime,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      };
    } finally {
      client.dispose();
    }
  }

  return {
    async attach(caller, fileId, placeId) {
      const file = await check(caller, fileId);

      let results: ServiceFileReferenceResult[];
      try {
        results = await references.add([placeReference(fileId, placeId)]);
      } catch (error) {
        // GoWay's own token, not the caller's session: whatever went wrong —
        // a refused grant included — is GoWay unable to reach Oxy.
        logger.warn(
          { status: oxyStatus(error) },
          'Oxy did not record the gallery reference; refusing a gallery write',
        );
        throw unavailable();
      }
      const result = results.find((entry) => entry.fileId === fileId)?.result;
      if (result !== 'created' && result !== 'exists') {
        // Public and active a moment ago; since then trashed, made private or
        // deleted. The same answer the check gives.
        throw refused('No Oxy file has that id.', 'not_found');
      }
      return file;
    },

    async detach(fileId, placeId) {
      try {
        const [result] = await references.remove([placeReference(fileId, placeId)]);
        if (result?.result !== 'removed') {
          logger.info(
            { result: result?.result },
            'Oxy held no GoWay reference to remove for a withdrawn gallery item',
          );
        }
      } catch (error) {
        logger.warn(
          { status: oxyStatus(error) },
          'Oxy reference removal failed; the file keeps a reference to a place that no longer shows it',
        );
      }
    },
  };
}
