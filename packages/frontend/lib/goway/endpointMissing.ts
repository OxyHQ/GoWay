/**
 * Whether a failure means "this deployment has no such API".
 *
 * A 404 that GoWay did not write (the SDK's plain `GoWayApiError`, never
 * `GoWayNotFoundError`) is a route that does not exist — an older backend, or
 * the feature switched off — so an optional map layer (Street 3D, cameras)
 * stops asking for the rest of the session. A GoWay `not_found` is an answer
 * about one scene or camera, not that.
 */
import { GoWayApiError, GoWayNotFoundError } from '@goway.to/sdk';

export function isEndpointMissing(error: unknown): boolean {
  return (
    error instanceof GoWayApiError && !(error instanceof GoWayNotFoundError) && error.status === 404
  );
}
