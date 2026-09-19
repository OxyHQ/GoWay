/**
 * The React Query layer over `@goway.to/sdk`.
 *
 * Three jobs, none of which belong in a screen:
 *
 *  - **Cancellation.** React Query hands every `queryFn` an `AbortSignal`, and
 *    the SDK accepts one on every call, so a superseded search is genuinely
 *    cancelled rather than merely ignored. `classifyGoWayError` maps the
 *    resulting `GoWayAbortError` to `aborted`, which renders as nothing.
 *  - **Retry policy.** The app-wide default is "retry twice", which is wrong
 *    for a 404 and for a malformed response. The SDK already knows which of its
 *    errors are retryable, so the policy reads that rather than guessing.
 *  - **Query keys that are stable.** Bounds arrive from the renderer as floats
 *    with fifteen digits; keyed raw, two visually identical viewports are two
 *    cache entries. They are rounded to ~1 m before they become a key.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  CapabilityKey,
  GeoBoundingBox,
  GeoCoordinate,
  Place,
  PlaceId,
  SearchResults,
} from '@goway.to/sdk';

import { gowayClient } from './client';
import { shouldRetryGoWay } from './errors';

/** ~1 m at the equator. Enough precision for a viewport, few enough digits to key on. */
function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function boundsKey(bounds: GeoBoundingBox): [number, number, number, number] {
  return [round(bounds.west), round(bounds.south), round(bounds.east), round(bounds.north)];
}

export interface PlacesInBoundsOptions {
  categories?: readonly string[];
  capabilities?: readonly CapabilityKey[];
  limit?: number;
  enabled?: boolean;
}

/**
 * The places inside a box — the map-viewport read.
 *
 * `bounds` is the box the user has COMMITTED to (the opening view, or the one
 * they pressed "Search this area" on), never the live camera: refetching on
 * every frame of a pan is both a bad network citizen and a UI that never
 * settles. The "Search this area" control is what turns a moved camera into a
 * new value here.
 */
export function usePlacesInBounds(
  bounds: GeoBoundingBox | null,
  options: PlacesInBoundsOptions = {},
): UseQueryResult<Place[]> {
  const { categories, capabilities, limit, enabled = true } = options;

  return useQuery({
    queryKey: [
      'goway',
      'places',
      'bounds',
      bounds ? boundsKey(bounds) : null,
      categories ?? null,
      capabilities ?? null,
      limit ?? null,
    ],
    enabled: enabled && bounds != null,
    retry: shouldRetryGoWay,
    queryFn: async ({ signal }) => {
      if (!bounds) return [];
      return gowayClient.places.inBounds(
        {
          west: bounds.west,
          south: bounds.south,
          east: bounds.east,
          north: bounds.north,
          ...(categories && categories.length > 0 ? { categories: [...categories] } : {}),
          ...(capabilities && capabilities.length > 0 ? { capabilities: [...capabilities] } : {}),
          ...(limit ? { limit } : {}),
        },
        { signal },
      );
    },
  });
}

export interface SearchOptions {
  /** Bias toward the user (strongest). */
  near?: GeoCoordinate | null;
  /** Bias toward the visible map. Ignored by the API when `near` is set. */
  viewport?: GeoBoundingBox | null;
  categories?: readonly string[];
  capabilities?: readonly CapabilityKey[];
  limit?: number;
  enabled?: boolean;
}

/** The shortest query worth sending. One character matches half a city. */
export const MIN_SEARCH_LENGTH = 2;

/**
 * Free-text search across GoWay Places and the active geocoders.
 *
 * Pass an ALREADY-DEBOUNCED string (see `useDebouncedValue`). Debouncing inside
 * the hook would make the query key lag the input by a render, which is the
 * shape that produces a stale result list flashing over a fresh one.
 */
export function useSearch(query: string, options: SearchOptions = {}): UseQueryResult<SearchResults> {
  const { near, viewport, categories, capabilities, limit, enabled = true } = options;
  const trimmed = query.trim();
  const long = trimmed.length >= MIN_SEARCH_LENGTH;

  return useQuery({
    queryKey: [
      'goway',
      'search',
      trimmed,
      near ? [round(near.latitude), round(near.longitude)] : null,
      viewport ? boundsKey(viewport) : null,
      categories ?? null,
      capabilities ?? null,
    ],
    enabled: enabled && long,
    retry: shouldRetryGoWay,
    // A result list that is one keystroke old is better than an empty one.
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) =>
      gowayClient.search.query(
        {
          query: trimmed,
          ...(near ? { near } : {}),
          ...(!near && viewport ? { viewport } : {}),
          ...(categories && categories.length > 0 ? { categories: [...categories] } : {}),
          ...(capabilities && capabilities.length > 0 ? { capabilities: [...capabilities] } : {}),
          limit: limit ?? 20,
        },
        { signal },
      ),
  });
}

/**
 * One place by its stable GoWay Place ID.
 *
 * `initialData` is how a selection from a search result opens instantly: the
 * result already carries the reconciled `place`, so the details view paints
 * from it and this query only refreshes it.
 */
export function usePlace(placeId: PlaceId | null, initialData?: Place): UseQueryResult<Place> {
  return useQuery({
    queryKey: ['goway', 'place', placeId],
    enabled: placeId != null,
    retry: shouldRetryGoWay,
    ...(initialData && initialData.id === placeId ? { initialData } : {}),
    queryFn: async ({ signal }) => gowayClient.places.get(placeId as PlaceId, { signal }),
  });
}
