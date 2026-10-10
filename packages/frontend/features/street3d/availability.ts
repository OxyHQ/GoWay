/**
 * Whether a Street 3D failure means "this deployment has no Street 3D API".
 *
 * A 404 that GoWay did not write (the SDK's plain `GoWayApiError`, never
 * `GoWayNotFoundError`) is a route that does not exist — an older backend, or
 * Street 3D switched off — so the optional map layer stops asking for the rest
 * of the session. A GoWay `not_found` is an answer about one scene, not that.
 */
import { GoWayApiError, GoWayNotFoundError } from '@goway.to/sdk';

export function isStreet3dEndpointMissing(error: unknown): boolean {
  return (
    error instanceof GoWayApiError && !(error instanceof GoWayNotFoundError) && error.status === 404
  );
}
