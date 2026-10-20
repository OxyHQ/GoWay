/**
 * Saved place lists — `/lists` and `/saved-places`. Every route is the
 * caller's own.
 *
 *     GET    /lists                          your lists
 *     POST   /lists                          create one
 *     PUT    /lists/default                  your default "Saved" list, created if you have none
 *     GET    /lists/{listId}                 one of your lists
 *     PATCH  /lists/{listId}                 rename it
 *     DELETE /lists/{listId}                 delete it, and its places
 *     GET    /lists/{listId}/items           the places in it, in your order
 *     POST   /lists/{listId}/items           save a place to it
 *     PUT    /lists/{listId}/items/order     reorder
 *     PATCH  /lists/{listId}/items/{itemId}  set or clear your note
 *     DELETE /lists/{listId}/items/{itemId}  remove a place from it
 *     GET    /saved-places?placeIds=         which of your lists hold these places
 *
 * ## Whose list it is
 *
 * The owner is the PERSON behind the session (Oxy's actor chain), as for a
 * review: a session switched into an organization is refused, because a saved
 * list is personal and an organization's members must not read each other's.
 * The owner is established here, from the verified session, and handed to the
 * repository, which scopes every statement by it (`savedPlacesRepository`).
 * Somebody else's list is `404 not_found`, indistinguishable from none.
 *
 * Nothing on this router is public and nothing reads a place beyond its
 * lifecycle: saving a place records no place revision.
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
  savedDefaultListInputSchema,
  savedListInputSchema,
  savedListItemInputSchema,
  savedListItemOrderInputSchema,
  savedListItemPathSchema,
  savedListItemQuerySchema,
  savedListItemUpdateInputSchema,
  savedListPathSchema,
  savedListQuerySchema,
  savedListUpdateInputSchema,
  savedPlacesQuerySchema,
} from '@goway/contracts';
import { findPlaceLifecycle } from '../db/places/placesRepository';
import {
  addSavedItem,
  createSavedList,
  deleteSavedList,
  ensureDefaultSavedList,
  findSavedList,
  findSavedPlaces,
  listSavedItems,
  listSavedLists,
  orderSavedItems,
  removeSavedItem,
  renameSavedList,
  updateSavedItemNote,
} from '../db/places/savedPlacesRepository';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { cursorBinding, decodeCursor, pageOf, timePageOf, timeWindowOf } from '../http/cursor';
import { parseBody, parsePath, parseQuery } from '../http/validation';
import type { OxyCaller } from '../oxy/accountRoles';
import { requiredOxyCaller } from '../oxy/caller';
import { assertPublished } from '../places/placeLifecycle';

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/** The no-such-list answer, for a list that is missing and for one that is somebody else's alike. */
function noSuchList(): ApiError {
  return new ApiError('not_found', 'You have no list with that id.');
}

/**
 * The person a list belongs to. A session switched into an organization is
 * refused; one whose actor Oxy did not report is its own account, which is the
 * person whenever nobody switched.
 */
function ownerOf(caller: OxyCaller): string {
  if (caller.operatedByOxyUserId !== null && caller.operatedByOxyUserId !== caller.oxyAccountId) {
    throw new ApiError('forbidden', 'Saved lists are personal: use them as yourself.');
  }
  return caller.oxyAccountId;
}

/** An item page resumes at `(position, id)`. */
const itemKeysetSchema = z.tuple([z.number().int().min(0), z.string().min(1).max(128)]);

export interface SavedListsRouterDependencies {
  requireAuth: RequestHandler;
}

export function createSavedListsRouter(dependencies: SavedListsRouterDependencies): Router {
  const { requireAuth } = dependencies;
  const router: Router = Router();

  router.get(
    '/lists',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const query = parseQuery(savedListQuerySchema, request.query);
      const binding = cursorBinding('saved-lists', {});
      const rows = await listSavedLists(getDb(), owner, timeWindowOf(query, binding));
      response.json(timePageOf(rows, query.limit, binding));
    }),
  );

  router.post(
    '/lists',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { name } = parseBody(savedListInputSchema, request.body);
      response.status(201).json(await createSavedList(getDb(), owner, name));
    }),
  );

  // Before `/lists/:listId`: `default` is a literal segment, not a list id.
  router.put(
    '/lists/default',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { name } = parseBody(savedDefaultListInputSchema, request.body);
      const { list, created } = await ensureDefaultSavedList(getDb(), owner, name);
      response.status(created ? 201 : 200).json(list);
    }),
  );

  router.get(
    '/lists/:listId',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { listId } = parsePath(savedListPathSchema, request.params);
      const list = await findSavedList(getDb(), owner, listId);
      if (!list) throw noSuchList();
      response.json(list);
    }),
  );

  router.patch(
    '/lists/:listId',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { listId } = parsePath(savedListPathSchema, request.params);
      const { name } = parseBody(savedListUpdateInputSchema, request.body);
      const list = await renameSavedList(getDb(), owner, listId, name);
      if (!list) throw noSuchList();
      response.json(list);
    }),
  );

  router.delete(
    '/lists/:listId',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { listId } = parsePath(savedListPathSchema, request.params);
      if (!(await deleteSavedList(getDb(), owner, listId))) throw noSuchList();
      response.status(204).end();
    }),
  );

  router.get(
    '/lists/:listId/items',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { listId } = parsePath(savedListPathSchema, request.params);
      const { limit, cursor } = parseQuery(savedListItemQuerySchema, request.query);
      const binding = cursorBinding('saved-list-items', { listId });
      const after = decodeCursor(cursor, binding, itemKeysetSchema);
      const rows = await listSavedItems(getDb(), owner, listId, { limit: limit + 1, after });
      if (!rows) throw noSuchList();
      response.json(
        pageOf(
          rows,
          limit,
          binding,
          (row) => row.position,
          (row) => row.item,
        ),
      );
    }),
  );

  router.post(
    '/lists/:listId/items',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { listId } = parsePath(savedListPathSchema, request.params);
      const input = parseBody(savedListItemInputSchema, request.body);
      const db = getDb();
      // The list first: whether a place exists is nobody's business who has no such list.
      if (!(await findSavedList(db, owner, listId))) throw noSuchList();
      assertPublished(await findPlaceLifecycle(db, input.placeId));
      const added = await addSavedItem(db, owner, listId, input);
      if (!added) throw noSuchList();
      response.status(added.created ? 201 : 200).json(added.item);
    }),
  );

  // Before `/lists/:listId/items/:itemId`: `order` is a literal segment.
  router.put(
    '/lists/:listId/items/order',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { listId } = parsePath(savedListPathSchema, request.params);
      const { itemIds } = parseBody(savedListItemOrderInputSchema, request.body);
      if (!(await orderSavedItems(getDb(), owner, listId, itemIds))) throw noSuchList();
      response.status(204).end();
    }),
  );

  router.patch(
    '/lists/:listId/items/:itemId',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { listId, itemId } = parsePath(savedListItemPathSchema, request.params);
      const { note } = parseBody(savedListItemUpdateInputSchema, request.body);
      const item = await updateSavedItemNote(getDb(), owner, listId, itemId, note);
      if (!item)
        throw new ApiError('not_found', 'You have no saved place with that id in this list.');
      response.json(item);
    }),
  );

  router.delete(
    '/lists/:listId/items/:itemId',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { listId, itemId } = parsePath(savedListItemPathSchema, request.params);
      if (!(await removeSavedItem(getDb(), owner, listId, itemId))) {
        throw new ApiError('not_found', 'You have no saved place with that id in this list.');
      }
      response.status(204).end();
    }),
  );

  router.get(
    '/saved-places',
    requireAuth,
    route(async (request, response) => {
      const owner = ownerOf(requiredOxyCaller(request));
      const { placeIds } = parseQuery(savedPlacesQuerySchema, request.query);
      response.json({ items: await findSavedPlaces(getDb(), owner, placeIds) });
    }),
  );

  return router;
}
