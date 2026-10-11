/**
 * The Oxy files a place's gallery references — checked, linked and unlinked
 * with Oxy, never fetched.
 *
 * A gallery item is an Oxy file id. The client uploads the image to Oxy
 * itself; GoWay's part is to make sure the id it is handed is a file it may
 * publish, and to tell Oxy the place uses it. GoWay never downloads, proxies or
 * stores an image: Oxy's CDN serves the bytes to whoever renders the gallery.
 *
 * ## Asked with the CALLER's bearer, on a short-lived client
 *
 * The same shape as `oxy/accountRoles`, for the same reason: what is being
 * established is something about THIS caller ("the file is mine"), and the
 * process-wide client must never carry a caller's token. Three questions, one
 * client, disposed after:
 *
 *  1. `GET /assets/:id` — the file exists, is `active`, is an image, and its
 *     `ownerUserId` is the session's account or the person operating it. Oxy
 *     answers this for any signed-in caller, so the OWNER comparison is GoWay's
 *     and is the whole of the check — nothing else stops somebody publishing a
 *     file id they merely saw.
 *  2. `POST /assets/batch-access` — the file's `visibility` is `public`. The
 *     record above does not carry it.
 *  3. `POST /assets/:id/links` — `{ app: 'goway', entityType: 'place',
 *     entityId: placeId }`, with `visibility: 'public'` restated: Oxy's link
 *     SETS the visibility it is given (and infers `private` for a place when
 *     given none), so restating what (2) just established is what keeps the
 *     link from changing it.
 *
 * ## Outcomes, translated once
 *
 *  - a file that is missing, not the caller's, in the trash, not an image or
 *    not public is a refusal the caller can act on (`validation_failed` or
 *    `forbidden`), naming the field and never the file's metadata;
 *  - a `401` is the caller's session failing at Oxy: `unauthorized`;
 *  - anything else is Oxy being unavailable: GoWay FAILS CLOSED with
 *    `503 service_unavailable` and records nothing.
 *
 * ## Unlinking is best effort
 *
 * Removing an item drops its link after the removal committed. A failure is
 * logged, not surfaced: the item is already gone from GoWay, and a link Oxy
 * still holds costs the owner nothing but the file staying alive. A merge does
 * NOT re-link: Oxy's link call rewrites the file's visibility, and a merge is
 * an operator's act on files that are not theirs. The link keeps naming the
 * absorbed place, whose id is a permanent alias of the survivor.
 */

import { OxyApiError, OxyServices } from '@oxy.so/core';
import { PLACE_MEDIA_MIME_TYPES } from '@goway/contracts';
import { ApiError } from '../http/apiError';
import { logger } from '../utils/logger';
import type { OxyCaller } from './accountRoles';

/** The app every GoWay link names. */
export const GOWAY_OXY_APP = 'goway';
/** The entity type a place's gallery links name. */
export const PLACE_ENTITY_TYPE = 'place';

/** One question to Oxy may take this long, in milliseconds — as for account roles. */
const OXY_REQUEST_TIMEOUT_MS = 5_000;

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
   * Check that `fileId` is a public image the caller owns, and link it to the
   * place. Throws the refusal or the `503` — never resolves for a file GoWay
   * may not publish.
   */
  attach(caller: OxyCaller, fileId: string, placeId: string): Promise<PlaceFile>;
  /** Drop the place's link to the file. Best effort: logs, never throws. */
  detach(caller: OxyCaller, fileId: string, placeId: string): Promise<void>;
}

export interface PlaceFileStoreOptions {
  /** The Oxy API origin. */
  readonly oxyApiUrl: string;
}

const ACCEPTED_MIME_TYPES: ReadonlySet<string> = new Set(PLACE_MEDIA_MIME_TYPES);

/** A positive integer from Oxy's free-form metadata, or `undefined`. */
function dimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function refused(message: string, issue: string): ApiError {
  return new ApiError('validation_failed', message, { field: 'fileId', issue });
}

/** An Oxy failure as GoWay's answer: `null` for "no such file", throws for everything else. */
function translate(error: unknown): null {
  if (error instanceof ApiError) throw error;
  if (error instanceof OxyApiError && (error.status === 403 || error.status === 404)) return null;
  if (error instanceof OxyApiError && error.status === 401) {
    throw new ApiError('unauthorized', 'Your Oxy session is no longer valid. Sign in again.');
  }
  logger.warn(
    { status: error instanceof OxyApiError ? error.status : undefined },
    'Oxy files unavailable; refusing a gallery write',
  );
  throw new ApiError(
    'service_unavailable',
    'The file cannot be checked right now because Oxy is unavailable. Try again shortly.',
  );
}

export function createOxyPlaceFileStore(options: PlaceFileStoreOptions): PlaceFileStore {
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

  return {
    async attach(caller, fileId, placeId) {
      const client = clientFor(caller);
      try {
        const record = await client.assets.get(fileId).catch(translate);
        if (record === null) throw refused('No Oxy file has that id.', 'not_found');
        const { file } = record;

        const owners = [caller.oxyAccountId, caller.operatedByOxyUserId].filter(
          (id): id is string => id !== null,
        );
        if (!owners.includes(file.ownerUserId)) {
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

        const linked = await client.assets
          .link(
            fileId,
            { app: GOWAY_OXY_APP, entityType: PLACE_ENTITY_TYPE, entityId: placeId },
            { visibility: 'public' },
          )
          .catch(translate);
        if (linked === null) throw refused('No Oxy file has that id.', 'not_found');

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
    },

    async detach(caller, fileId, placeId) {
      let client: OxyServices;
      try {
        client = clientFor(caller);
      } catch {
        return;
      }
      try {
        await client.assets.unlink(fileId, {
          app: GOWAY_OXY_APP,
          entityType: PLACE_ENTITY_TYPE,
          entityId: placeId,
        });
      } catch (error) {
        logger.warn(
          { status: error instanceof OxyApiError ? error.status : undefined },
          'Oxy unlink failed; the file keeps a link to a place that no longer shows it',
        );
      } finally {
        client.dispose();
      }
    },
  };
}
