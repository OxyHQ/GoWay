/**
 * `GET /live/sources` — the real-time feeds this deployment re-serves.
 *
 * Public (no session is read: `auth: 'public'` in `API_OPERATIONS`) and in the
 * public CORS lane, because a map that draws a feed's data must be able to
 * show that feed's credit and licence wherever it is embedded. The positions
 * themselves travel over Socket.IO (`live/socket.ts`).
 *
 * On when configured: with no live service (`LIVE_SOURCES` lists no usable
 * source) this answers `service_unavailable`, the same answer a client can
 * feature-detect on.
 */

import { liveShapePathSchema } from '@goway/contracts';
import { type RequestHandler, Router } from 'express';
import type { LiveService } from '../live';
import { ApiError } from '../http/apiError';
import { parsePath } from '../http/validation';

/** A shape changes when the operator republishes its GTFS: daily at most. */
const SHAPE_CACHE_CONTROL = 'public, max-age=3600';

/** Statuses and freshness move every few seconds; a shared cache may hold them briefly. */
const SOURCES_CACHE_CONTROL = 'public, max-age=5';

export function createLiveRouter(
  live: LiveService | null,
  shapeRateLimit?: RequestHandler,
): Router {
  const router: Router = Router();
  router.get('/live/sources', (_request, response) => {
    if (!live) {
      throw new ApiError(
        'service_unavailable',
        'The live layer is not available on this GoWay deployment.',
      );
    }
    response.setHeader('Cache-Control', SOURCES_CACHE_CONTROL);
    response.json({ items: live.hub.sources(), nextCursor: null });
  });
  // An operator's own published route shape, which a vehicle's `track`
  // points into: what the map draws it along.
  const shapeLimit: RequestHandler[] = shapeRateLimit ? [shapeRateLimit] : [];
  router.get('/live/sources/:sourceId/shapes/:shapeId', ...shapeLimit, (request, response) => {
    if (!live) {
      throw new ApiError(
        'service_unavailable',
        'The live layer is not available on this GoWay deployment.',
      );
    }
    const { sourceId, shapeId } = parsePath(liveShapePathSchema, request.params);
    const shape = live.hub.shape(sourceId, shapeId);
    if (!shape) throw new ApiError('not_found', 'No such shape is loaded for that source.');
    response.setHeader('Cache-Control', SHAPE_CACHE_CONTROL);
    response.json(shape);
  });
  return router;
}
