/**
 * The {@link PlacesGateway} backed by the real database.
 *
 * Separated from the interface so that `merge.ts`, `ranking.ts` and
 * `searchService.ts` can be imported — and tested — without pulling in the
 * connection pool. This is the only file in the search layer that touches the
 * repository.
 */

import type { Place } from '@goway/shared-types';
import type { SourceRefInput } from '../db/places/placesRepository';
import {
  findPlaceById,
  findPlaceIdBySourceRef,
  findPlacesInBounds,
  findPlacesNearby,
} from '../db/places/placesRepository';
import { getDb } from '../db/postgres';
import { sourceRefKey, type PlacesGateway } from './placesGateway';

export interface PlacesGatewayOptions {
  /**
   * The signed-in caller, when there is one. Passed to `findPlaceById` so a
   * claimant sees their own claim details on a place — and so nobody else does.
   */
  viewerOxyAccountId?: string | null;
}

/**
 * The real gateway.
 *
 * `getDb()` is resolved PER CALL rather than captured, so building a router
 * does not require a connection to exist yet — `createApp()` opens none, and a
 * gateway that connected at construction would make that untrue.
 */
export function createPlacesGateway(options: PlacesGatewayOptions = {}): PlacesGateway {
  const viewer = options.viewerOxyAccountId ?? null;

  return {
    async findPlaceIdsBySourceRefs(refs) {
      const resolved = new Map<string, string>();
      // One lookup per distinct reference, issued together. The caller's list is
      // bounded by the result limit (25 by default), so this is a handful of
      // indexed point reads on `places_sources`, not a fan-out worth batching
      // into a hand-written `IN` query the repository does not expose.
      const unique = new Map<string, SourceRefInput>();
      for (const ref of refs) unique.set(sourceRefKey(ref), ref);

      const db = getDb();
      const results = await Promise.all(
        [...unique.entries()].map(async ([key, ref]) => [key, await findPlaceIdBySourceRef(db, ref)] as const),
      );
      for (const [key, placeId] of results) {
        if (placeId !== null) resolved.set(key, placeId);
      }
      return resolved;
    },

    async findPlacesByIds(ids, locale) {
      const db = getDb();
      const unique = [...new Set(ids)];
      const places = await Promise.all(unique.map((id) => findPlaceById(db, id, viewer, locale)));
      const byId = new Map<string, Place>();
      for (const place of places) {
        if (place !== null) byId.set(place.id, place);
      }
      return byId;
    },

    findPlacesNearby(query) {
      return findPlacesNearby(getDb(), query);
    },

    findPlacesInBounds(query) {
      return findPlacesInBounds(getDb(), query);
    },
  };
}
