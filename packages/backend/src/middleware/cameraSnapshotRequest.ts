import type { Request } from 'express';

/**
 * `GET /api/v1/cameras/{cameraId}/snapshot`: exempt from `apiRateLimit`
 * because it has its own (`cameraSnapshotRateLimit`).
 */
export function isCameraSnapshotRequest(request: Request): boolean {
  return (
    request.method === 'GET' &&
    /^[^?]*\/cameras\/[^/?]+\/snapshot(\?|$)/.test(request.originalUrl ?? request.url)
  );
}
