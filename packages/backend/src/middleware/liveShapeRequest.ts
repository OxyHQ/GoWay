import type { Request } from 'express';

/**
 * `GET /api/v1/live/sources/{sourceId}/shapes/{shapeId}`: exempt from
 * `apiRateLimit` because it has its own (`liveShapeRateLimit`).
 */
export function isLiveShapeRequest(request: Request): boolean {
  return (
    request.method === 'GET' &&
    /^[^?]*\/live\/sources\/[^/?]+\/shapes\/[^/?]+(\?|$)/.test(request.originalUrl ?? request.url)
  );
}
