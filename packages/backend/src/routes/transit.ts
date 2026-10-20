/**
 * `GET /transit/nearby` — the stops around a point and what leaves them next
 * (`docs/TRANSIT_NEARBY.md`).
 *
 * Public: browsing a place works signed out. The position is transient request
 * data: it is read, answered and forgotten. This router logs nothing, caches
 * nothing by position, and the answer is `private` so a shared cache does not
 * hold a coordinate's neighbourhood either.
 *
 * Inert like the live layer it reads (`503 service_unavailable` unless
 * `server.ts` built a live service). A point no served operator covers is a
 * normal, empty answer — not an error.
 */

import { nearbyTransitQuerySchema } from '@goway/contracts';
import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import { ApiError } from '../http/apiError';
import { parseQuery } from '../http/validation';
import type { LiveService } from '../live';

/** Predictions move every ~30 s; a browser may reuse an answer for a moment. */
const NEARBY_CACHE_CONTROL = 'private, max-age=15';

export function createTransitRouter(live: LiveService | null): Router {
  const router: Router = Router();
  const handler: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
    (async () => {
      if (!live) {
        throw new ApiError(
          'service_unavailable',
          'Transit departures are not available on this GoWay deployment.',
        );
      }
      const query = parseQuery(nearbyTransitQuerySchema, request.query);
      const answer = await live.transit.nearby(query);
      response.setHeader('Cache-Control', NEARBY_CACHE_CONTROL);
      response.json(answer);
    })().catch(next);
  };
  router.get('/transit/nearby', handler);
  return router;
}
