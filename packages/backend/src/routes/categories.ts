/**
 * `GET /api/v1/categories?locale=` — the place category taxonomy, for clients.
 *
 * Every category a place can carry, deprecated ones included (a place may still
 * carry one, and a client has to be able to label it), depth-first with
 * siblings in presentation order. Each carries every label GoWay holds and
 * `label`, resolved for `locale` by the rule every GoWay label follows — so a
 * client renders a picker, a chip or a pin caption without restating the
 * fallback, and one that wants another language has them all.
 *
 * One page, always: the taxonomy is a few hundred entries, so `nextCursor` is
 * `null` and there is no `limit`. Public, and cacheable for five minutes — it
 * describes the API, not a caller, and `locale` is in the URL rather than in
 * `Accept-Language`, so a shared cache keys it correctly. A moderator's edit
 * reaches a client within that, plus one catalog TTL on a process that did not
 * make it (`categories/catalog`).
 */

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { categoryListQuerySchema } from '@goway/contracts';
import { categoryCatalog } from '../categories/catalog';
import { getDb } from '../db/postgres';
import { parseQuery } from '../http/validation';

const CATEGORIES_CACHE_CONTROL = 'public, max-age=300';

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

export function createCategoriesRouter(): Router {
  const router: Router = Router();
  router.get(
    '/categories',
    route(async (request, response) => {
      const { locale } = parseQuery(categoryListQuerySchema, request.query);
      const catalog = await categoryCatalog(getDb());
      response.setHeader('Cache-Control', CATEGORIES_CACHE_CONTROL);
      response.json(catalog.page(locale));
    }),
  );
  return router;
}
