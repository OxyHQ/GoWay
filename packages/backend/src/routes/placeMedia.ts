/**
 * A place's gallery — `/places/{placeId}/media`.
 *
 *     GET    /places/{placeId}/media                     the visible gallery, in order (signed out)
 *     POST   /places/{placeId}/media                     add an Oxy file you uploaded
 *     PUT    /places/{placeId}/media/order               the business orders it
 *     DELETE /places/{placeId}/media/{mediaId}           its contributor or the business withdraws it
 *     POST   /places/{placeId}/media/{mediaId}/reports   flag it for moderation
 *
 * ## The bytes never come here
 *
 * A client uploads the image to Oxy and sends the file id. This router asks
 * Oxy — on the caller's own session, `oxy/placeFiles` — whether the file is a
 * public image the caller owns, links it to the place, and stores the id.
 * GoWay never fetches, proxies or stores an image; Oxy's CDN serves it. An Oxy
 * outage is a `503` and nothing is recorded.
 *
 * ## Who may do what
 *
 * Anybody signed in may add a photo, a menu, an interior or an exterior — a
 * claimed place is not closed to customers' pictures, for the reason it is not
 * closed to their capability reports: an item at `community_reported` sits
 * beside the business's own and cannot displace it. A `logo` or `cover` on a
 * claimed place is the business's, as an edit of the place is. Withdrawing an
 * item is its contributor's or the business's; ordering the gallery is the
 * business's alone; hiding one is an operator's (`routes/moderation.ts`).
 */

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { z } from 'zod';
import {
  BUSINESS_MEDIA_KINDS,
  contentReportInputSchema,
  mediaListQuerySchema,
  mediaPathSchema,
  placeMediaInputSchema,
  placeMediaOrderInputSchema,
  placePathSchema,
  type PlaceMedia,
  type PlaceMediaKind,
} from '@goway/contracts';
import {
  addPlaceMedia,
  findLivePlaceMedia,
  listPlaceMedia,
  removePlaceMedia,
  reorderPlaceMedia,
} from '../db/places/mediaRepository';
import { createPlaceReport } from '../db/places/moderationRepository';
import {
  findPlaceLifecycle,
  getPlaceAuthorization,
  type PlaceActor,
} from '../db/places/placesRepository';
import { revisionAuthor } from '../db/places/revisions';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { cursorBinding, decodeCursor, pageOf } from '../http/cursor';
import { parseBody, parsePath, parseQuery } from '../http/validation';
import type { AccountRoleResolver } from '../oxy/accountRoles';
import { requiredOxyCaller } from '../oxy/caller';
import type { PlaceFileStore } from '../oxy/placeFiles';
import { assertableVerification, withdrawableVerification } from '../places/capabilityAuthority';
import { standingOn } from '../places/claimAuthority';
import { assertPublished } from '../places/placeLifecycle';

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/** A gallery page resumes at `(position, mediaId)`. */
const mediaKeysetSchema = z.tuple([z.number().int().min(0), z.string().min(1).max(128)]);

const BUSINESS_KINDS: ReadonlySet<PlaceMediaKind> = new Set(BUSINESS_MEDIA_KINDS);

export interface PlaceMediaRouterDependencies {
  optionalAuth: RequestHandler;
  requireAuth: RequestHandler;
  accountRoles: AccountRoleResolver;
  /** Checks, links and unlinks the Oxy files a gallery references. */
  placeFiles: PlaceFileStore;
  /** Applied to reports, in addition to the API-wide limit. */
  reportRateLimit: RequestHandler;
  /** Applied to gallery writes, in addition to the API-wide limit. */
  contributionRateLimit: RequestHandler;
}

export function createPlaceMediaRouter(dependencies: PlaceMediaRouterDependencies): Router {
  const {
    optionalAuth,
    requireAuth,
    accountRoles,
    placeFiles,
    reportRateLimit,
    contributionRateLimit,
  } = dependencies;
  const router: Router = Router();

  /** `GET /places/{placeId}/media` — the visible gallery, in the business's order. Public. */
  router.get(
    '/places/:placeId/media',
    optionalAuth,
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const { cursor, limit, kinds } = parseQuery(mediaListQuerySchema, request.query);
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      const binding = cursorBinding('place-media', { placeId, kinds });
      const rows = await listPlaceMedia(db, placeId, {
        kinds,
        limit: limit + 1,
        after: decodeCursor(cursor, binding, mediaKeysetSchema),
      });
      response.json(
        pageOf(
          rows,
          limit,
          binding,
          (item) => [item.position, item.id],
          (item) => item,
        ),
      );
    }),
  );

  /**
   * `POST /places/{placeId}/media` — add an image the caller uploaded to Oxy as
   * public. Oxy is asked first and the item recorded after; if recording
   * fails, the link Oxy just made is dropped again.
   */
  router.post(
    '/places/:placeId/media',
    contributionRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const input = parseBody(placeMediaInputSchema, request.body);
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);
      const standing = await standingOn(approvedClaims, caller, accountRoles);
      if (
        BUSINESS_KINDS.has(input.kind) &&
        standing.claimed &&
        withdrawableVerification(standing) === null
      ) {
        throw new ApiError(
          'forbidden',
          'This place is claimed; only the business may add its logo or cover.',
        );
      }

      const file = await placeFiles.attach(caller, input.fileId, placeId);
      const actor: PlaceActor = {
        author: revisionAuthor(caller, 'api'),
        assertedVerification: assertableVerification(standing),
      };
      let item: PlaceMedia | null;
      try {
        item = await addPlaceMedia(
          db,
          placeId,
          {
            fileId: file.fileId,
            kind: input.kind,
            caption: input.caption,
            width: file.width,
            height: file.height,
          },
          actor,
        );
      } catch (error) {
        // A file already in the gallery keeps the link it was relying on.
        if (!(error instanceof ApiError && error.code === 'conflict'))
          await placeFiles.detach(caller, file.fileId, placeId);
        throw error;
      }
      if (!item) {
        await placeFiles.detach(caller, file.fileId, placeId);
        throw new ApiError('not_found', 'No place has that id.');
      }
      response
        .status(201)
        .location(
          `/api/v1/places/${encodeURIComponent(placeId)}/media/${encodeURIComponent(item.id)}`,
        )
        .json(item);
    }),
  );

  /**
   * `PUT /places/{placeId}/media/order` — the business puts the named items
   * first. `204`. Only whoever acts for an approved claim: the order of a
   * shop's photos is the shop's to choose.
   */
  router.put(
    '/places/:placeId/media/order',
    contributionRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const { mediaIds } = parseBody(placeMediaOrderInputSchema, request.body);
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);
      if (
        withdrawableVerification(await standingOn(approvedClaims, caller, accountRoles)) === null
      ) {
        throw new ApiError('forbidden', "Only an approved claimant may order a place's gallery.");
      }
      if (!(await reorderPlaceMedia(db, placeId, mediaIds, revisionAuthor(caller, 'api')))) {
        throw new ApiError('not_found', 'No place has that id.');
      }
      response.status(204).end();
    }),
  );

  /**
   * `DELETE /places/{placeId}/media/{mediaId}` — withdraw an item. `204`.
   *
   * Its contributor may — the account it was added as, or the person who added
   * it — and so may whoever acts for an approved claim. The contributor is
   * asked about first, so withdrawing your own photo never waits on Oxy. The
   * place's Oxy link to the file is dropped after the withdrawal commits.
   */
  router.delete(
    '/places/:placeId/media/:mediaId',
    contributionRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId, mediaId } = parsePath(mediaPathSchema, request.params);
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);
      const item = await findLivePlaceMedia(db, placeId, mediaId);
      if (!item) throw new ApiError('not_found', 'This place has no gallery item with that id.');

      const contributed =
        item.contributorOxyAccountId === caller.oxyAccountId ||
        (item.operatedByOxyUserId !== null &&
          item.operatedByOxyUserId === caller.operatedByOxyUserId);
      if (
        !contributed &&
        withdrawableVerification(await standingOn(approvedClaims, caller, accountRoles)) === null
      ) {
        throw new ApiError(
          'forbidden',
          'Only its contributor or the business may withdraw a gallery item.',
        );
      }

      const removed = await removePlaceMedia(db, placeId, mediaId, revisionAuthor(caller, 'api'));
      if (!removed) throw new ApiError('not_found', 'This place has no gallery item with that id.');
      await placeFiles.detach(caller, removed.oxyFileId, removed.oxyLinkPlaceId);
      response.status(204).end();
    }),
  );

  /**
   * `POST /places/{placeId}/media/{mediaId}/reports` — flag a visible item for
   * moderation, in the place report queue. A repeat while the first is open
   * answers it with `200`.
   */
  router.post(
    '/places/:placeId/media/:mediaId/reports',
    reportRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId, mediaId } = parsePath(mediaPathSchema, request.params);
      const input = parseBody(contentReportInputSchema, request.body ?? {});
      const caller = requiredOxyCaller(request);
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      const item = await findLivePlaceMedia(db, placeId, mediaId);
      if (item?.state !== 'visible')
        throw new ApiError('not_found', 'This place has no gallery item with that id.');
      const { report, created } = await createPlaceReport(
        db,
        placeId,
        caller.operatedByOxyUserId ?? caller.oxyAccountId,
        input,
        { mediaId },
      );
      response.status(created ? 201 : 200).json(report);
    }),
  );

  return router;
}
