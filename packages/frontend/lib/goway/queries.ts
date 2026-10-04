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
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { GoWayNotFoundError } from '@goway.to/sdk';
import type {
  CategoryKey,
  GeoBoundingBox,
  GeoCoordinate,
  Place,
  PlaceId,
  PlaceMedia,
  PlaceMediaKind,
  PlaceMediaPage,
  PlacePage,
  PlaceReviewInput,
  PlaceReviewPage,
  PlaceReviewWithStatus,
  ReviewSort,
  SearchResults,
} from '@goway.to/sdk';
import type { User } from '@oxy.so/core';

import { oxyServices } from '@/lib/oxyServices';

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
  /** Taxonomy keys; a parent matches every category below it. */
  categories?: readonly CategoryKey[];
  /** `key` or `key:value` filters, a conjunction. */
  capabilities?: readonly string[];
  limit?: number;
  enabled?: boolean;
}

/**
 * The places inside a box — the map-viewport read.
 *
 * ONE page, deliberately: the map draws what the first page holds and never
 * walks `nextCursor`. A viewport dense enough to fill a page is one the user
 * zooms into, and "Search this area" there asks again for a smaller box —
 * paging a pan would pile up pins nobody can tell apart.
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
): UseQueryResult<PlacePage> {
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
      if (!bounds) return { items: [], nextCursor: null };
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
  /** Taxonomy keys; a parent matches every category below it. */
  categories?: readonly CategoryKey[];
  /** `key` or `key:value` filters, a conjunction. */
  capabilities?: readonly string[];
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
 *
 * The first page only: a search box lists the best `limit` matches and never
 * follows `nextCursor`.
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

// ── Gallery and reviews ─────────────────────────────────────────────────────

/** The first page of a place's visible gallery. A detail sheet shows a strip, never the whole archive. */
export function usePlaceMedia(placeId: PlaceId | null): UseQueryResult<PlaceMediaPage> {
  return useQuery({
    queryKey: ['goway', 'place', placeId, 'media'],
    enabled: placeId != null,
    retry: shouldRetryGoWay,
    queryFn: async ({ signal }) => gowayClient.places.media.list(placeId as PlaceId, { limit: 12 }, { signal }),
  });
}

/** The first page of a place's published reviews, in the order asked for. */
export function usePlaceReviews(placeId: PlaceId | null, sort: ReviewSort): UseQueryResult<PlaceReviewPage> {
  return useQuery({
    queryKey: ['goway', 'place', placeId, 'reviews', sort],
    enabled: placeId != null,
    retry: shouldRetryGoWay,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) => gowayClient.places.reviews.list(placeId as PlaceId, { sort, limit: 10 }, { signal }),
  });
}

/**
 * The signed-in person's own review of a place, or `null` when they have none.
 *
 * Enabled only with a session: it is identity-bound, and a signed-out reader
 * has no review to find. `404` is the answer "none", not a failure.
 */
export function useMyPlaceReview(placeId: PlaceId | null, signedIn: boolean): UseQueryResult<PlaceReviewWithStatus | null> {
  return useQuery({
    queryKey: ['goway', 'place', placeId, 'reviews', 'mine'],
    enabled: placeId != null && signedIn,
    retry: shouldRetryGoWay,
    queryFn: async ({ signal }) => {
      try {
        return await gowayClient.places.reviews.mine(placeId as PlaceId, { signal });
      } catch (error) {
        if (error instanceof GoWayNotFoundError) return null;
        throw error;
      }
    },
  });
}

/**
 * The public Oxy profiles of a page of reviewers, by user id.
 *
 * One `users.getMany` for the page rather than one lookup per review. A review
 * names its author's Oxy id; the name and avatar are Oxy's to publish, never a
 * copy GoWay keeps.
 */
export function useReviewAuthors(authorIds: readonly string[]): UseQueryResult<ReadonlyMap<string, User>> {
  const ids = [...new Set(authorIds)].sort();
  return useQuery({
    queryKey: ['oxy', 'users', ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => new Map((await oxyServices.users.getMany(ids)).map((user) => [user.id, user])),
  });
}

/** Everything a review write changes: the lists, your own review, and the place's rating. */
function invalidateReviews(queryClient: ReturnType<typeof useQueryClient>, placeId: PlaceId): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['goway', 'place', placeId] });
}

/** Write or rewrite the signed-in person's review. */
export function useWriteReview(placeId: PlaceId): UseMutationResult<PlaceReviewWithStatus, Error, PlaceReviewInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PlaceReviewInput) => gowayClient.places.reviews.put(placeId, input),
    onSuccess: () => invalidateReviews(queryClient, placeId),
  });
}

/** Withdraw the signed-in person's review. */
export function useWithdrawReview(placeId: PlaceId): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => gowayClient.places.reviews.delete(placeId),
    onSuccess: () => invalidateReviews(queryClient, placeId),
  });
}

/** A picked image, as the Oxy SDK uploads it on web and native alike. */
export interface PickedImage {
  uri: string;
  type: string;
  name: string;
}

/**
 * Add a photo to a place's gallery: upload it to Oxy as PUBLIC with the app's
 * one Oxy client, then hand GoWay the file id. GoWay checks the file with Oxy
 * and links it to the place; the bytes never pass through GoWay.
 */
export function useAddPlacePhoto(placeId: PlaceId): UseMutationResult<PlaceMedia, Error, { image: PickedImage; kind?: PlaceMediaKind }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ image, kind = 'photo' }) => {
      const { file } = await oxyServices.assets.upload(image, { visibility: 'public' });
      return gowayClient.places.media.add(placeId, { fileId: file.id, kind });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['goway', 'place', placeId, 'media'] }),
  });
}
