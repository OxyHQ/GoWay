/**
 * The React Query layer over a person's saved place lists (`goway.lists`).
 *
 * Saved lists are personal and identity-bound: every hook here is disabled
 * without a session (`signedIn`), so a signed-out visitor makes no request at
 * all and the map, search and place details behave exactly as before.
 *
 * ## What is cached, and what invalidates it
 *
 * Everything lives under `['goway', 'saved']`. A list holds place ids and a
 * note; the places themselves are read from `places.getMany` under the
 * ordinary place keys, so a saved place is exactly as fresh as the place. Any
 * write invalidates the whole `saved` prefix — lists, items and the per-place
 * "is it saved" answers — because a count, a cover and a heart all derive
 * from the same write, and the lists are at most a hundred.
 *
 * ## One request for every heart on screen
 *
 * A result list draws a heart per row, and a row asks "is this place saved?"
 * by itself. Asked one by one that is a request per row, so the questions are
 * COALESCED (`savedHolds.ts`): everything asked within a few milliseconds
 * leaves as ONE `GET /saved-places?placeIds=…` (at most 50 ids, the API's
 * limit), and each row gets its own answer.
 */
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { iterateGoWayPages, MAX_PLACE_BATCH_SIZE } from '@goway.to/sdk';
import type { Place, PlaceId, SavedList, SavedListItem, SavedPlace } from '@goway.to/sdk';
import { useMemo } from 'react';

import { gowayClient } from './client';
import { shouldRetryGoWay } from './errors';
import { createHoldBatcher } from './savedHolds';

export const SAVED_QUERY_KEY = ['goway', 'saved'] as const;

const loadHold = createHoldBatcher((placeIds) => gowayClient.lists.saved(placeIds));

/** Every list the person has, oldest first. At most `MAX_SAVED_LISTS_PER_USER`, so all pages are read. */
export function useSavedLists(signedIn: boolean): UseQueryResult<SavedList[]> {
  return useQuery({
    queryKey: [...SAVED_QUERY_KEY, 'lists'],
    enabled: signedIn,
    retry: shouldRetryGoWay,
    queryFn: async ({ signal }) => {
      const all: SavedList[] = [];
      for await (const list of iterateGoWayPages((cursor) =>
        gowayClient.lists.list(cursor === undefined ? {} : { cursor }, { signal }),
      )) {
        all.push(list);
      }
      return all;
    },
  });
}

/** One list. A list that is not the person's rejects with `GoWayNotFoundError`. */
export function useSavedList(listId: string | null, signedIn: boolean): UseQueryResult<SavedList> {
  return useQuery({
    queryKey: [...SAVED_QUERY_KEY, 'list', listId],
    enabled: signedIn && listId != null,
    retry: shouldRetryGoWay,
    queryFn: ({ signal }) => gowayClient.lists.get(listId as string, { signal }),
  });
}

/** Every item of a list, in the person's order. At most `MAX_SAVED_LIST_ITEMS`, so all pages are read. */
export function useSavedListItems(
  listId: string | null,
  signedIn: boolean,
): UseQueryResult<SavedListItem[]> {
  return useQuery({
    queryKey: [...SAVED_QUERY_KEY, 'items', listId],
    enabled: signedIn && listId != null,
    retry: shouldRetryGoWay,
    queryFn: async ({ signal }) => {
      const all: SavedListItem[] = [];
      for await (const item of iterateGoWayPages((cursor) =>
        gowayClient.lists.items.list(listId as string, cursor === undefined ? {} : { cursor }, {
          signal,
        }),
      )) {
        all.push(item);
      }
      return all;
    },
  });
}

/**
 * Which of the person's lists hold this place: `null` when none does.
 *
 * Questions from every heart on screen share one request (`savedHolds.ts`).
 */
export function useSavedHold(
  placeId: PlaceId | null,
  signedIn: boolean,
): UseQueryResult<SavedPlace | null> {
  return useQuery({
    queryKey: [...SAVED_QUERY_KEY, 'hold', placeId],
    enabled: signedIn && placeId != null,
    retry: shouldRetryGoWay,
    queryFn: () => loadHold(placeId as string),
  });
}

/** The places of a saved list, by id, in chunks the API accepts. */
export interface SavedListPlaces {
  /** Each published place, by id. */
  places: ReadonlyMap<string, Place>;
  /** Ids that are no longer on GoWay (removed, or never existed). */
  unavailable: ReadonlySet<string>;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useSavedListPlaces(placeIds: readonly string[]): SavedListPlaces {
  const chunks = useMemo(() => {
    const out: string[][] = [];
    for (let start = 0; start < placeIds.length; start += MAX_PLACE_BATCH_SIZE) {
      out.push(placeIds.slice(start, start + MAX_PLACE_BATCH_SIZE));
    }
    return out;
  }, [placeIds]);

  const results = useQueries({
    queries: chunks.map((ids) => ({
      queryKey: ['goway', 'places', 'batch', ids],
      retry: shouldRetryGoWay,
      queryFn: ({ signal }: { signal: AbortSignal }) => gowayClient.places.getMany(ids, { signal }),
    })),
  });

  const places = new Map<string, Place>();
  const unavailable = new Set<string>();
  for (const result of results) {
    for (const place of result.data?.items ?? []) places.set(place.id, place);
    for (const gone of result.data?.gone ?? []) unavailable.add(gone.id);
    for (const missing of result.data?.missing ?? []) unavailable.add(missing);
  }
  return {
    places,
    unavailable,
    isPending: results.some((result) => result.isPending),
    isError: results.some((result) => result.isError),
    refetch: () => {
      for (const result of results) if (result.isError) void result.refetch();
    },
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

function useSavedWrite<TInput, TOutput>(
  write: (input: TInput) => Promise<TOutput>,
): UseMutationResult<TOutput, Error, TInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    // Awaited, so a mutation is "done" only once the lists it changed are fresh.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SAVED_QUERY_KEY }),
  });
}

/** Create a private list. */
export function useCreateList(): UseMutationResult<SavedList, Error, { name: string }> {
  return useSavedWrite((input) => gowayClient.lists.create(input));
}

/** Rename a list. */
export function useRenameList(): UseMutationResult<
  SavedList,
  Error,
  { listId: string; name: string }
> {
  return useSavedWrite(({ listId, name }) => gowayClient.lists.rename(listId, { name }));
}

/** Delete a list and the places saved in it. */
export function useDeleteList(): UseMutationResult<void, Error, { listId: string }> {
  return useSavedWrite(({ listId }) => gowayClient.lists.delete(listId));
}

/**
 * Save a place. With a `listId` it goes to that list; without one it goes to
 * the person's default list, which the server creates on the first save
 * (`defaultName` is the name it is created with, in the reader's language).
 */
export function useSavePlace(): UseMutationResult<
  SavedListItem,
  Error,
  { placeId: PlaceId; listId?: string; defaultName: string }
> {
  return useSavedWrite(async ({ placeId, listId, defaultName }) => {
    const target = listId ?? (await gowayClient.lists.ensureDefault({ name: defaultName })).id;
    return gowayClient.lists.items.add(target, { placeId });
  });
}

/** Remove a place from a list. */
export function useRemoveSavedItem(): UseMutationResult<
  void,
  Error,
  { listId: string; itemId: string }
> {
  return useSavedWrite(({ listId, itemId }) => gowayClient.lists.items.remove(listId, itemId));
}

/**
 * Put the named items first, in this order.
 *
 * Optimistic: a reorder is a button press that must not wait on the network,
 * so the cached order changes at once and is put back if the write fails. The
 * settled state always comes from the server.
 */
export function useOrderSavedItems(): UseMutationResult<
  void,
  Error,
  { listId: string; itemIds: string[] },
  { previous: SavedListItem[] | undefined }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, itemIds }) => gowayClient.lists.items.order(listId, { itemIds }),
    onMutate: async ({ listId, itemIds }) => {
      const key = [...SAVED_QUERY_KEY, 'items', listId];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SavedListItem[]>(key);
      if (previous) {
        const byId = new Map(previous.map((item) => [item.id, item]));
        const named = itemIds.flatMap((id) => byId.get(id) ?? []);
        const rest = previous.filter((item) => !itemIds.includes(item.id));
        queryClient.setQueryData(key, [...named, ...rest]);
      }
      return { previous };
    },
    onError: (_error, { listId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData([...SAVED_QUERY_KEY, 'items', listId], context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SAVED_QUERY_KEY }),
  });
}

/** Set a note on a saved place, or clear it with `null`. */
export function useSetSavedNote(): UseMutationResult<
  SavedListItem,
  Error,
  { listId: string; itemId: string; note: string | null }
> {
  return useSavedWrite(({ listId, itemId, note }) =>
    gowayClient.lists.items.setNote(listId, itemId, { note }),
  );
}
