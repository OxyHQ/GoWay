import { Router, type RequestHandler, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  organizationListPathSchema,
  organizationListEntryPathSchema,
  organizationListQuerySchema,
  organizationListEntryQuerySchema,
  organizationListInputSchema,
  organizationListUpdateSchema,
  organizationListEntryInputSchema,
  organizationListOrderInputSchema,
} from '@goway/contracts';
import { getDb, type Transaction } from '../db/postgres';
import * as repo from '../db/organizationLists';
import { parsePath, parseBody, parseQuery } from '../http/validation';
import { cursorBinding, decodeCursor, pageOf } from '../http/cursor';
import { requiredOxyCaller } from '../oxy/caller';
import type { OrganizationAuthority } from '../oxy/organizationAuthority';

const route =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    fn(req, res).catch(next);
  };
export function createOrganizationListsRouter(deps: {
  requireAuth: RequestHandler;
  authorize: OrganizationAuthority;
}) {
  const router = Router();
  async function mutate(
    req: Request,
    fn: (
      tx: Transaction,
      list: Awaited<ReturnType<typeof repo.getList>>,
      actor: string,
    ) => Promise<unknown>,
  ) {
    const { listId } = parsePath(organizationListPathSchema, { listId: req.params.listId });
    const caller = requiredOxyCaller(req);
    // Authority is checked while holding the aggregate lock: no queued mutation can reuse an earlier membership result.
    return getDb().transaction(async (tx) => {
      const list = await repo.getList(tx, listId, true);
      await deps.authorize(caller, list.oxyAccountId);
      return fn(tx, list, caller.operatedByOxyUserId ?? caller.oxyAccountId);
    });
  }
  router.get(
    '/organization-lists',
    route(async (req, res) => {
      const { cursor, limit, oxyAccountId } = parseQuery(organizationListQuerySchema, req.query);
      const binding = cursorBinding('organization-lists', { oxyAccountId });
      const rows = await repo.listOrganizations(
        getDb(),
        oxyAccountId,
        decodeCursor(cursor, binding, z.string().min(1)),
        limit + 1,
      );
      res.json(
        pageOf(
          rows,
          limit,
          binding,
          (r) => r.id,
          (r) => r,
        ),
      );
    }),
  );
  router.post(
    '/organization-lists',
    deps.requireAuth,
    route(async (req, res) => {
      const input = parseBody(organizationListInputSchema, req.body);
      const caller = requiredOxyCaller(req);
      await deps.authorize(caller, input.oxyAccountId);
      res
        .status(201)
        .json(
          await repo.createList(getDb(), input, caller.operatedByOxyUserId ?? caller.oxyAccountId),
        );
    }),
  );
  router.get(
    '/organization-lists/:listId',
    route(async (req, res) => {
      res.json(
        await repo.getList(getDb(), parsePath(organizationListPathSchema, req.params).listId),
      );
    }),
  );
  router.put(
    '/organization-lists/:listId',
    deps.requireAuth,
    route(async (req, res) => {
      const input = parseBody(organizationListUpdateSchema, req.body);
      res.json(await mutate(req, (tx, list, actor) => repo.touchList(tx, list.id, actor, input)));
    }),
  );
  router.delete(
    '/organization-lists/:listId',
    deps.requireAuth,
    route(async (req, res) => {
      await mutate(req, (tx, list) => repo.deleteList(tx, list.id));
      res.sendStatus(204);
    }),
  );
  router.get(
    '/organization-lists/:listId/entries',
    route(async (req, res) => {
      const { listId } = parsePath(organizationListPathSchema, req.params);
      const { cursor, limit, state } = parseQuery(organizationListEntryQuerySchema, req.query);
      await getDb().transaction(async (tx) => {
        const list = await repo.getList(tx, listId, true);
        const binding = cursorBinding('organization-list-entries', {
          listId,
          state,
          revision: list.revision,
        });
        const after = decodeCursor(
          cursor,
          binding,
          z.tuple([z.number().int().nonnegative(), z.string().min(1)]),
        );
        const rows = await repo.listEntries(tx, listId, state, after, limit + 1, new Date());
        res.json(
          pageOf(
            rows,
            limit,
            binding,
            (r) => [r.position, r.id],
            (r) => r,
          ),
        );
      });
    }),
  );
  router.post(
    '/organization-lists/:listId/entries',
    deps.requireAuth,
    route(async (req, res) => {
      const input = parseBody(organizationListEntryInputSchema, req.body);
      res
        .status(201)
        .json(
          await mutate(req, (tx, list, actor) =>
            repo.writeEntry(tx, list.id, undefined, input, actor),
          ),
        );
    }),
  );
  router.put(
    '/organization-lists/:listId/entries/:entryId',
    deps.requireAuth,
    route(async (req, res) => {
      const { entryId } = parsePath(organizationListEntryPathSchema, req.params);
      const input = parseBody(organizationListEntryInputSchema, req.body);
      res.json(
        await mutate(req, (tx, list, actor) => repo.writeEntry(tx, list.id, entryId, input, actor)),
      );
    }),
  );
  router.post(
    '/organization-lists/:listId/entries/:entryId/complete',
    deps.requireAuth,
    route(async (req, res) => {
      const { entryId } = parsePath(organizationListEntryPathSchema, req.params);
      res.json(
        await mutate(req, (tx, list, actor) => repo.completeEntry(tx, list.id, entryId, actor)),
      );
    }),
  );
  router.delete(
    '/organization-lists/:listId/entries/:entryId',
    deps.requireAuth,
    route(async (req, res) => {
      const { entryId } = parsePath(organizationListEntryPathSchema, req.params);
      await mutate(req, (tx, list, actor) => repo.deleteEntry(tx, list.id, entryId, actor));
      res.sendStatus(204);
    }),
  );
  router.put(
    '/organization-lists/:listId/order',
    deps.requireAuth,
    route(async (req, res) => {
      const input = parseBody(organizationListOrderInputSchema, req.body);
      res.json(
        await mutate(req, (tx, list, actor) =>
          repo.orderEntries(tx, list, input.entryIds, input.revision, actor),
        ),
      );
    }),
  );
  return router;
}
