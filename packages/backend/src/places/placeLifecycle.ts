/**
 * How a route answers for a place that is not published: `404`, `410`, or a
 * `410` that says where a merged place went.
 *
 * One function for every router, so `GET /places/{id}`, a write, the history and
 * a report all answer a merged id the same way — with
 * `details.mergedInto` — and a consumer needs one code path to follow it.
 */

import { GONE_MERGED_INTO_DETAIL, PUBLISHED_PLACE_STATUSES, type PlaceStatus } from '@goway/contracts';
import type { PlaceLifecycle } from '../db/places/placesRepository';
import { ApiError } from '../http/apiError';

/** Whether a stored status is one a place is published in. */
export function isPublishedStatus(status: PlaceStatus): boolean {
  return (PUBLISHED_PLACE_STATUSES as readonly PlaceStatus[]).includes(status);
}

/** The place a MERGED one now lives at — the one hop every `410` names — or `undefined`. */
export function mergedIntoOf(lifecycle: PlaceLifecycle): string | undefined {
  return lifecycle.status === 'merged' && lifecycle.mergedIntoPlaceId !== null ? lifecycle.mergedIntoPlaceId : undefined;
}

/**
 * The refusal for a place that is missing or not published.
 *
 * `not_found` for an id no place has. `gone` for one moderation withdrew, and
 * for a merged one `gone` with `details.mergedInto` naming the survivor: the
 * id existed and is retired, and the pointer is the id to use instead.
 */
export function unpublishedPlace(lifecycle: PlaceLifecycle | null): ApiError {
  if (lifecycle === null) return new ApiError('not_found', 'No place has that id.');
  const mergedInto = mergedIntoOf(lifecycle);
  if (mergedInto !== undefined) {
    return new ApiError('gone', 'This place was merged into another GoWay place.', {
      [GONE_MERGED_INTO_DETAIL]: mergedInto,
    });
  }
  return new ApiError('gone', 'This place was removed from GoWay.');
}

/** Refuse anything but a published place. */
export function assertPublished(lifecycle: PlaceLifecycle | null): asserts lifecycle is PlaceLifecycle {
  if (lifecycle === null || !isPublishedStatus(lifecycle.status)) throw unpublishedPlace(lifecycle);
}
