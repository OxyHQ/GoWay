/**
 * The search layer's view of GoWay Places.
 *
 * Every statement goes through `db/places/placesRepository` — the module that
 * owns the spatial predicates and the row-to-contract mapping. Nothing here
 * builds a query, and nothing here imports a drizzle table: a search handler
 * that reached for one would be a `select(places)` away from serving an
 * internal column as an API field, and a second spelling of `ST_DWithin` away
 * from the planet-wide sequential scan the repository exists to prevent.
 *
 * It is an INTERFACE rather than a set of imports so the merge and ranking
 * logic can be unit-tested against a fake: the alternative is that the only
 * test of duplicate grouping is one that needs PostGIS, which means in practice
 * it is one that does not run. This file holds the interface ALONE and imports
 * nothing at runtime — the implementation lives in `dbPlacesGateway.ts`, so
 * importing the contract does not drag in the database module, its pool or the
 * process configuration behind it.
 */

import type { Place, PlaceWithDistance } from '@goway/shared-types';
import type { BoundsQuery, NearbyQuery, SourceRefInput } from '../db/places/placesRepository';

/** The key a resolved source reference is returned under: `<source>:<sourceId>`. */
export function sourceRefKey(ref: SourceRefInput): string {
  return `${ref.source}:${ref.sourceId}`;
}

export interface PlacesGateway {
  /**
   * The GoWay place each external record is bound to, keyed by
   * {@link sourceRefKey}. Refs with no binding are simply absent.
   */
  findPlaceIdsBySourceRefs(refs: readonly SourceRefInput[]): Promise<Map<string, string>>;
  /**
   * `locale` resolves each place's `localizedName` and is optional so a test
   * fake may ignore it. A reconciled place's label comes from GoWay's row, not
   * from the geocoder's, so without this a Spanish-speaking caller loses the
   * localization Photon already gave them the moment the result reconciles.
   */
  findPlacesByIds(ids: readonly string[], locale?: string): Promise<Map<string, Place>>;
  findPlacesNearby(query: NearbyQuery): Promise<PlaceWithDistance[]>;
  findPlacesInBounds(query: BoundsQuery): Promise<Place[]>;
}
