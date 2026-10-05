/**
 * The React Query layer over `mercariaClient`: a place's Mercaria shop fronts,
 * and what is on each one's shelf.
 *
 * Price and stock are perishable, so nothing here outlives the app's default
 * freshness: a sheet reopened a minute later asks Mercaria again. Retries read
 * the SDK's own `retryable` (`shouldRetryMercaria`), so a `gone` is never
 * asked twice and an outage is.
 */
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Place } from '@goway.to/sdk';
import type { MercariaLocation, MercariaLocationProduct, MercariaPage } from '@mercaria.co/sdk';

import { mercariaClient } from './client';
import { shouldRetryMercaria } from './errors';
import { placeOffersMercariaStore } from './presentation';

/** Feature code names Mercaria's shapes through the adapter, never the SDK. */
export type { MercariaLocation, MercariaLocationProduct } from '@mercaria.co/sdk';

/** How many products one store's strip shows. Everything else is on mercaria.co. */
export const STORE_STRIP_LIMIT = 12;

/**
 * How many shop fronts one place lists: Mercaria's largest page, read once.
 * Even a big market is well under it, and a place past it shows its first 50
 * rather than paging stores into a sheet.
 */
export const PLACE_LOCATIONS_LIMIT = 50;

/**
 * The Mercaria shop fronts that trade from a place — usually none or one, and
 * several only where the place is shared (a market, a mall).
 *
 * Asked only when the place carries the store capability; see
 * `placeOffersMercariaStore` for why that is a hint and not the answer.
 */
export function usePlaceMercariaLocations(place: Place): UseQueryResult<MercariaPage<MercariaLocation>> {
  return useQuery({
    queryKey: ['mercaria', 'locations', 'place', place.id],
    enabled: placeOffersMercariaStore(place),
    retry: shouldRetryMercaria,
    queryFn: async ({ signal }) => mercariaClient.locations.list({ goWayPlaceId: place.id, limit: PLACE_LOCATIONS_LIMIT, signal }),
  });
}

/**
 * The first page of what is in stock at each location, one query per
 * location and in the same order, so a store whose read fails or is gone
 * drops out alone.
 */
export function useMercariaLocationProducts(
  locations: readonly MercariaLocation[],
): UseQueryResult<MercariaPage<MercariaLocationProduct>>[] {
  return useQueries({
    queries: locations.map((location) => ({
      queryKey: ['mercaria', 'location', location.ref.id, 'products'],
      retry: shouldRetryMercaria,
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        mercariaClient.locations.products(location.ref, { inStock: true, limit: STORE_STRIP_LIMIT, signal }),
    })),
  });
}
