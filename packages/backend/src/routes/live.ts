/**
 * `GET /live/sources` — the real-time feeds this deployment re-serves.
 *
 * Public (no session is read: `auth: 'public'` in `API_OPERATIONS`) and in the
 * public CORS lane, because a map that draws a feed's data must be able to
 * show that feed's credit and licence wherever it is embedded. The positions
 * themselves travel over Socket.IO (`live/socket.ts`).
 *
 * Off unless switched on: with no live service (`LIVE_ENABLED` unset, or no
 * source configured) this answers `service_unavailable`, the same answer a
 * client can feature-detect on.
 */

import { Router } from 'express';
import type { LiveService } from '../live';
import { ApiError } from '../http/apiError';

/** Statuses and freshness move every few seconds; a shared cache may hold them briefly. */
const SOURCES_CACHE_CONTROL = 'public, max-age=5';

export function createLiveRouter(live: LiveService | null): Router {
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
  return router;
}
