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
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { categoryTaxonomy, GoWayNotFoundError } from '@goway.to/sdk';
import type {
  CategoryPage,
  CategoryTaxonomy,
  GeoBoundingBox,
  GeoCoordinate,
  NearbyTransit,
  OrganizationList,
  OrganizationListEntry,
  OrganizationListEntryInput,
  OrganizationListInput,
  OrganizationListUpdate,
  Page,
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
import { useMemo } from 'react';

import { deviceLocale } from '@/lib/i18n';

import { oxyServices } from '@/lib/oxyServices';

import { gowayClient } from './client';
import { LIST_REFRESH_MS, nextListRefreshMs } from './organizationLists';
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
  categories?: readonly string[];
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
  categories?: readonly string[];
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
export function useSearch(
  query: string,
  options: SearchOptions = {},
): UseQueryResult<SearchResults> {
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
 * How long a fetched taxonomy is fresh. The API caches `GET /categories` for
 * five minutes; a moderator's edit is rare and reaching a reader ten minutes
 * later costs nothing, while refetching it on every screen mount would put a
 * request in front of every map paint.
 */
const CATEGORY_TAXONOMY_STALE_MS = 10 * 60_000;

/**
 * The category taxonomy, indexed — or `undefined` while it loads or after it
 * failed.
 *
 * Public, so it runs signed out. `undefined` is a state every caller handles
 * by drawing generic pins and no shortcut chips, never by blocking the map:
 * the taxonomy decorates places, it does not gate them. A refetch keeps the
 * previous list on screen until the new one arrives.
 */
export function useCategoryTaxonomy(): CategoryTaxonomy | undefined {
  const locale = deviceLocale();
  const { data } = useQuery<CategoryPage>({
    queryKey: ['goway', 'categories', locale],
    retry: shouldRetryGoWay,
    staleTime: CATEGORY_TAXONOMY_STALE_MS,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) => gowayClient.categories.list({ locale }, { signal }),
  });
  return useMemo(() => (data ? categoryTaxonomy(data.items) : undefined), [data]);
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

// ── Public transport ────────────────────────────────────────────────────────

/** How long an answer is fresh, and how often a visible one is asked again. */
const TRANSIT_STALE_MS = 20_000;
const TRANSIT_REFRESH_MS = 30_000;
/** While an operator reads its timetable for the first time. */
const TRANSIT_PREPARING_REFRESH_MS = 8_000;

/**
 * The stops around a place and what leaves them next.
 *
 * The position is the PLACE's (public data), never the reader's, and the key
 * rounds it to ~11 m so two reads of one place are one cache entry. Refreshed
 * every 30 s while the place is on screen (live predictions move), and every
 * 8 s while an operator is still preparing its timetable — React Query stops
 * both when the view is gone or the tab hidden.
 *
 * An error is not an empty state: the caller draws nothing for either, because
 * "no transit here" and "transit could not be read" must both leave the place
 * looking like a place.
 */
export function useNearbyTransit(location: GeoCoordinate | null): UseQueryResult<NearbyTransit> {
  const latitude = location ? Math.round(location.latitude * 1e4) / 1e4 : null;
  const longitude = location ? Math.round(location.longitude * 1e4) / 1e4 : null;
  return useQuery<NearbyTransit>({
    queryKey: ['goway', 'transit', latitude, longitude],
    enabled: latitude != null && longitude != null,
    retry: shouldRetryGoWay,
    staleTime: TRANSIT_STALE_MS,
    refetchInterval: (query) =>
      query.state.data?.operators.some((operator) => operator.availability === 'preparing')
        ? TRANSIT_PREPARING_REFRESH_MS
        : TRANSIT_REFRESH_MS,
    queryFn: async ({ signal }) =>
      gowayClient.transit.nearby(
        {
          latitude: latitude as number,
          longitude: longitude as number,
          radiusMeters: 400,
          maxStops: 4,
          maxDepartures: 3,
        },
        { signal },
      ),
  });
}

// ── Gallery and reviews ─────────────────────────────────────────────────────

/** The first page of a place's visible gallery. A detail sheet shows a strip, never the whole archive. */
export function usePlaceMedia(placeId: PlaceId | null): UseQueryResult<PlaceMediaPage> {
  return useQuery({
    queryKey: ['goway', 'place', placeId, 'media'],
    enabled: placeId != null,
    retry: shouldRetryGoWay,
    queryFn: async ({ signal }) =>
      gowayClient.places.media.list(placeId as PlaceId, { limit: 12 }, { signal }),
  });
}

/** The first page of a place's published reviews, in the order asked for. */
export function usePlaceReviews(
  placeId: PlaceId | null,
  sort: ReviewSort,
): UseQueryResult<PlaceReviewPage> {
  return useQuery({
    queryKey: ['goway', 'place', placeId, 'reviews', sort],
    enabled: placeId != null,
    retry: shouldRetryGoWay,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) =>
      gowayClient.places.reviews.list(placeId as PlaceId, { sort, limit: 10 }, { signal }),
  });
}

/**
 * The signed-in person's own review of a place, or `null` when they have none.
 *
 * Enabled only with a session: it is identity-bound, and a signed-out reader
 * has no review to find. `404` is the answer "none", not a failure.
 */
export function useMyPlaceReview(
  placeId: PlaceId | null,
  signedIn: boolean,
): UseQueryResult<PlaceReviewWithStatus | null> {
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
export function useReviewAuthors(
  authorIds: readonly string[],
): UseQueryResult<ReadonlyMap<string, User>> {
  const ids = [...new Set(authorIds)].sort();
  return useQuery({
    queryKey: ['oxy', 'users', ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      new Map((await oxyServices.users.getMany(ids)).map((user) => [user.id, user])),
  });
}

/** Everything a review write changes: the lists, your own review, and the place's rating. */
function invalidateReviews(
  queryClient: ReturnType<typeof useQueryClient>,
  placeId: PlaceId,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['goway', 'place', placeId] });
}

/** Write or rewrite the signed-in person's review. */
export function useWriteReview(
  placeId: PlaceId,
): UseMutationResult<PlaceReviewWithStatus, Error, PlaceReviewInput> {
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
export function useAddPlacePhoto(
  placeId: PlaceId,
): UseMutationResult<PlaceMedia, Error, { image: PickedImage; kind?: PlaceMediaKind }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ image, kind = 'photo' }) => {
      const { file } = await oxyServices.assets.upload(image, { visibility: 'public' });
      return gowayClient.places.media.add(placeId, { fileId: file.id, kind });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['goway', 'place', placeId, 'media'] }),
  });
}

// ── Organization lists ──────────────────────────────────────────────────────

const ORGANIZATION_LISTS = ['goway', 'organization-lists'] as const;
const ORGANIZATION_LIST_INDEX = [...ORGANIZATION_LISTS, 'index'] as const;

/** Everything cached about one list: its detail, its entry pages and their places. */
function organizationListKey(listId: string) {
  return [...ORGANIZATION_LISTS, 'list', listId] as const;
}

/** The public lists, a page at a time (`fetchNextPage` follows `nextCursor`). */
export function useOrganizationLists(): UseInfiniteQueryResult<
  InfiniteData<Page<OrganizationList>, string | null>
> {
  return useInfiniteQuery({
    queryKey: ORGANIZATION_LIST_INDEX,
    retry: shouldRetryGoWay,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      gowayClient.organizationLists.list(pageParam ? { cursor: pageParam } : {}, { signal }),
    getNextPageParam: (page) => page.nextCursor,
  });
}

/** One list. Re-read every minute while open; its `revision` fences a reorder. */
export function useOrganizationList(listId: string): UseQueryResult<OrganizationList> {
  return useQuery({
    queryKey: organizationListKey(listId),
    retry: shouldRetryGoWay,
    refetchInterval: LIST_REFRESH_MS,
    queryFn: ({ signal }) => gowayClient.organizationLists.get(listId, { signal }),
  });
}

/**
 * A list's entries, a page at a time. Expiry is the server's decision, so an
 * open `active` view re-reads itself just after its earliest entry ends.
 */
export function useOrganizationListEntries(
  listId: string,
  state: 'active' | 'all',
): UseInfiniteQueryResult<InfiniteData<Page<OrganizationListEntry>, string | null>> {
  return useInfiniteQuery({
    queryKey: [...organizationListKey(listId), 'entries', state],
    retry: shouldRetryGoWay,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      gowayClient.organizationLists.entries(
        listId,
        { state, ...(pageParam ? { cursor: pageParam } : {}) },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) =>
      nextListRefreshMs(
        query.state.data?.pages.flatMap((page) => page.items) ?? [],
        state,
        Date.now(),
      ),
  });
}

function placesById(results: readonly UseQueryResult<readonly Place[]>[]) {
  return {
    places: new Map(results.flatMap((result) => result.data ?? []).map((p) => [p.id, p] as const)),
    isError: results.some((result) => result.isError),
  };
}

/**
 * The live places an entry list references, one batch per entry page (a page
 * is never larger than a place batch). An entry stores only the place id;
 * name and position are always the place's current ones.
 */
export function useOrganizationListPlaces(
  listId: string,
  pages: readonly (readonly OrganizationListEntry[])[],
): { places: ReadonlyMap<string, Place>; isError: boolean } {
  return useQueries({
    queries: pages.map((entries) => {
      const ids = [...new Set(entries.map((entry) => entry.placeId))].sort();
      return {
        queryKey: [...organizationListKey(listId), 'places', ids],
        enabled: ids.length > 0,
        retry: shouldRetryGoWay,
        refetchInterval: LIST_REFRESH_MS,
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          (await gowayClient.places.getMany(ids, { signal })).items,
      };
    }),
    combine: placesById,
  });
}

/** Re-read one list now: detail, entries and places. */
export function useRefreshOrganizationList(listId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: organizationListKey(listId) });
}

/** Create a list for an organization. Oxy decides, server-side, whether the caller may. */
export function useCreateOrganizationList(): UseMutationResult<
  OrganizationList,
  Error,
  OrganizationListInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: OrganizationListInput) => gowayClient.organizationLists.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ORGANIZATION_LIST_INDEX }),
  });
}

/** Every edit an organization makes to one of its lists. */
export type OrganizationListEdit =
  | { kind: 'update'; input: OrganizationListUpdate }
  | { kind: 'delete' }
  | { kind: 'addEntry'; input: OrganizationListEntryInput }
  | { kind: 'updateEntry'; entryId: string; input: OrganizationListEntryInput }
  | { kind: 'completeEntry'; entryId: string }
  | { kind: 'deleteEntry'; entryId: string }
  | { kind: 'moveEntryUp'; entryId: string; revision: number };

/** Swap an entry with the one before it, over the WHOLE list (every state), fenced by `revision`. */
async function moveEntryUp(listId: string, entryId: string, revision: number): Promise<unknown> {
  const ids: string[] = [];
  for await (const item of gowayClient.organizationLists.iterateEntries(listId, { state: 'all' }))
    ids.push(item.id);
  const index = ids.indexOf(entryId);
  const previous = ids[index - 1];
  if (index <= 0 || previous === undefined) return;
  ids[index - 1] = entryId;
  ids[index] = previous;
  return gowayClient.organizationLists.order(listId, { revision, entryIds: ids });
}

function applyEdit(listId: string, edit: OrganizationListEdit): Promise<unknown> {
  const lists = gowayClient.organizationLists;
  switch (edit.kind) {
    case 'update':
      return lists.update(listId, edit.input);
    case 'delete':
      return lists.delete(listId);
    case 'addEntry':
      return lists.addEntry(listId, edit.input);
    case 'updateEntry':
      return lists.updateEntry(listId, edit.entryId, edit.input);
    case 'completeEntry':
      return lists.completeEntry(listId, edit.entryId);
    case 'deleteEntry':
      return lists.deleteEntry(listId, edit.entryId);
    case 'moveEntryUp':
      return moveEntryUp(listId, edit.entryId, edit.revision);
  }
}

/**
 * Edit one list. One mutation for every kind of edit, so the screen has one
 * pending state and one failure, as an editor works one change at a time.
 * Success re-reads the list (and the index, whose titles may have changed);
 * a deleted list re-reads only the index, since the list itself is gone.
 */
export function useEditOrganizationList(
  listId: string,
): UseMutationResult<unknown, Error, OrganizationListEdit> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: OrganizationListEdit) => applyEdit(listId, edit),
    onSuccess: async (_result, edit) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ORGANIZATION_LIST_INDEX }),
        edit.kind === 'delete'
          ? undefined
          : queryClient.invalidateQueries({ queryKey: organizationListKey(listId) }),
      ]);
    },
  });
}
