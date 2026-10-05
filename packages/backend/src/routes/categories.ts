/**
 * `GET /api/v1/categories` — the place category taxonomy, for clients.
 *
 * Every key a place can carry, its parent, its glyph and its labels, in the
 * contract's own registry order. A client renders a category picker, a filter
 * chip or a localized label from this rather than from a copy of the table it
 * would have to keep in step; the SDK reads the same registry directly.
 *
 * One page, always: the taxonomy is a few hundred entries, fixed per release,
 * so `nextCursor` is `null` and there is no `limit` to page it by. Public and
 * cacheable — it describes the API, not a caller — and built once, at router
 * construction, from `@goway/contracts`.
 */

import { Router } from 'express';
import { CATEGORIES, type CategoryPage } from '@goway/contracts';

const CATEGORIES_CACHE_CONTROL = 'public, max-age=3600';

export function createCategoriesRouter(): Router {
  const page: CategoryPage = { items: [...CATEGORIES], nextCursor: null };
  const router: Router = Router();
  router.get('/categories', (_request, response) => {
    response.setHeader('Cache-Control', CATEGORIES_CACHE_CONTROL);
    response.json(page);
  });
  return router;
}
