/**
 * `GET /api/v1/openapi.json` — the API describing itself.
 *
 * Built ONCE, at router construction, from `@goway/contracts`: the same route
 * registry and schemas every handler validates with, so the served document
 * cannot describe an API this process does not run. It is byte-identical to the
 * committed `packages/contracts/openapi.json`, which
 * `scripts/check-openapi-fresh.mjs` holds to the same generator in CI.
 *
 * Public and cacheable: it describes the API, not any caller, and a doc tool or
 * a code generator fetches it from anywhere.
 */

import { Router } from 'express';
import { buildOpenApiDocument } from '@goway/contracts';

const OPENAPI_CACHE_CONTROL = 'public, max-age=300';

export function createOpenApiRouter(): Router {
  const document = buildOpenApiDocument();
  const router: Router = Router();
  router.get('/openapi.json', (_request, response) => {
    response.setHeader('Cache-Control', OPENAPI_CACHE_CONTROL);
    response.json(document);
  });
  return router;
}
