/**
 * Saved place lists for the fixture layer (`mockTransport.ts`).
 *
 * The fixture layer has no sessions, so there is one person: a signed-in
 * request (any `Authorization` header) owns every list here, and a request
 * without one is `unauthorized`, as the API answers. The rules are the API's
 * (`@goway.to/sdk` constants, never a copy): at most `MAX_SAVED_LISTS_PER_USER`
 * lists with case-blind distinct names, at most `MAX_SAVED_LIST_ITEMS` places in
 * one, a place once per list, a published place only, one default list.
 *
 * It answers with plain `{ status, body }` so `mockTransport.ts` wraps it in
 * the transport's own envelope; the SDK parses every body with the contract's
 * schemas, so a fixture that drifts from the contract fails the first read.
 */
import {
  API_ERROR_STATUS,
  DEFAULT_SAVED_ITEM_PAGE_LIMIT,
  DEFAULT_SAVED_LIST_PAGE_LIMIT,
  MAX_SAVED_LIST_ITEMS,
  MAX_SAVED_LISTS_PER_USER,
  SAVED_LIST_CONFLICT_DETAIL,
  SAVED_LIST_COVER_PLACES,
} from '@goway.to/sdk';
import type {
  ApiErrorCode,
  GoWayFetchInit,
  SavedList,
  SavedListConflictReason,
  SavedListItem,
  SavedPlace,
} from '@goway.to/sdk';

import { FIXTURE_PLACES_BY_ID, FIXTURE_WITHDRAWN_PLACE_IDS } from './fixtures';

export interface SavedFixtureAnswer {
  status: number;
  body?: unknown;
}

interface StoredList {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

let lists: StoredList[] = [];
let items = new Map<string, SavedListItem[]>();
let counter = 0;

/** A new session's state: no lists. Called by `createFixtureFetch`. */
export function resetSavedFixtures(): void {
  lists = [];
  items = new Map();
  counter = 0;
}

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_fixture_${String(counter)}`;
}

function failure(
  code: ApiErrorCode,
  message: string,
  details?: Record<string, string | number>,
): SavedFixtureAnswer {
  return {
    status: API_ERROR_STATUS[code],
    body: { error: { code, message, ...(details ? { details } : {}) } },
  };
}

function conflict(reason: SavedListConflictReason, message: string): SavedFixtureAnswer {
  return failure('conflict', message, { [SAVED_LIST_CONFLICT_DETAIL]: reason });
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function summary(list: StoredList): SavedList {
  const held = items.get(list.id) ?? [];
  return {
    id: list.id,
    name: list.name,
    visibility: 'private',
    isDefault: list.isDefault,
    itemCount: held.length,
    coverPlaceIds: held.slice(0, SAVED_LIST_COVER_PLACES).map((item) => item.placeId),
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
  };
}

function touch(list: StoredList): void {
  list.updatedAt = new Date().toISOString();
}

/** One page of `entries`, resumed from the `o<offset>` cursor the fixture transport mints. */
function paged<T>(entries: readonly T[], params: Map<string, string>, fallback: number) {
  const offset = Number(/^o(\d+)$/.exec(params.get('cursor') ?? '')?.[1] ?? 0);
  const requested = Number(params.get('limit'));
  const end = offset + (Number.isInteger(requested) && requested > 0 ? requested : fallback);
  return { items: entries.slice(offset, end), nextCursor: end < entries.length ? `o${end}` : null };
}

/** The answer for a `/lists` or `/saved-places` request, or `null` for any other path. */
export function serveSavedFixture(
  path: string,
  params: Map<string, string>,
  init: GoWayFetchInit,
): SavedFixtureAnswer | null {
  const fixed = path === '/lists' || path === '/lists/default' || path === '/saved-places';
  const match = fixed ? null : /^\/lists\/([^/]+)(?:\/(items))?(?:\/([^/]+))?$/.exec(path);
  // `/lists/<id>/<something other than items>` is no route of ours.
  if (!fixed && (!match || (match[3] !== undefined && match[2] === undefined))) return null;

  const authorization = init.headers?.Authorization ?? init.headers?.authorization;
  if (!authorization) return failure('unauthorized', 'Sign in to use saved lists.');

  const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const method = init.method;
  const wrong = () => failure('method_not_allowed', `${method} is not allowed on ${path}`);
  const noList = () => failure('not_found', 'You have no list with that id.');
  const noItem = () => failure('not_found', 'You have no saved place with that id in this list.');

  if (path === '/saved-places') {
    if (method !== 'GET') return wrong();
    const ids = (params.get('placeIds') ?? '').split(',').filter(Boolean);
    const holds: SavedPlace[] = ids.flatMap((placeId) => {
      const lists_ = lists.flatMap((list) => {
        const item = (items.get(list.id) ?? []).find((entry) => entry.placeId === placeId);
        return item ? [{ listId: list.id, itemId: item.id }] : [];
      });
      return lists_.length > 0 ? [{ placeId, lists: lists_ }] : [];
    });
    return { status: 200, body: { items: holds } };
  }

  if (path === '/lists') {
    if (method === 'GET') {
      return {
        status: 200,
        body: paged(lists.map(summary), params, DEFAULT_SAVED_LIST_PAGE_LIMIT),
      };
    }
    if (method !== 'POST') return wrong();
    const name = String(body.name ?? '').trim();
    if (lists.length >= MAX_SAVED_LISTS_PER_USER)
      return conflict('list_limit_reached', 'You have reached the most lists you can keep.');
    if (lists.some((list) => same(list.name, name)))
      return conflict('name_taken', 'You already have a list with that name.');
    const now = new Date().toISOString();
    const list: StoredList = {
      id: nextId('list'),
      name,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    lists.push(list);
    return { status: 201, body: summary(list) };
  }

  if (path === '/lists/default') {
    if (method !== 'PUT') return wrong();
    const name = String(body.name ?? '').trim();
    const existing = lists.find((list) => list.isDefault);
    if (existing) return { status: 200, body: summary(existing) };
    const named = lists.find((list) => same(list.name, name));
    if (named) {
      named.isDefault = true;
      touch(named);
      return { status: 200, body: summary(named) };
    }
    if (lists.length >= MAX_SAVED_LISTS_PER_USER)
      return conflict('list_limit_reached', 'You have reached the most lists you can keep.');
    const now = new Date().toISOString();
    const list: StoredList = {
      id: nextId('list'),
      name,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    };
    lists.push(list);
    return { status: 201, body: summary(list) };
  }

  const [, listId = '', tail, itemId] = match ?? [];
  const list = lists.find((entry) => entry.id === decodeURIComponent(listId));
  if (!list) return noList();
  const held = items.get(list.id) ?? [];

  if (tail === undefined) {
    if (method === 'GET') return { status: 200, body: summary(list) };
    if (method === 'PATCH') {
      const name = String(body.name ?? '').trim();
      if (lists.some((other) => other !== list && same(other.name, name)))
        return conflict('name_taken', 'You already have a list with that name.');
      list.name = name;
      touch(list);
      return { status: 200, body: summary(list) };
    }
    if (method === 'DELETE') {
      lists = lists.filter((entry) => entry !== list);
      items.delete(list.id);
      return { status: 204 };
    }
    return wrong();
  }

  if (itemId === undefined) {
    if (method === 'GET')
      return { status: 200, body: paged(held, params, DEFAULT_SAVED_ITEM_PAGE_LIMIT) };
    if (method !== 'POST') return wrong();
    const placeId = String(body.placeId ?? '');
    if (FIXTURE_WITHDRAWN_PLACE_IDS.has(placeId))
      return failure('gone', 'This place was removed from GoWay.');
    if (!FIXTURE_PLACES_BY_ID.has(placeId)) return failure('not_found', 'No place has that id.');
    const present = held.find((entry) => entry.placeId === placeId);
    if (present) return { status: 200, body: present };
    if (held.length >= MAX_SAVED_LIST_ITEMS)
      return conflict('item_limit_reached', 'This list is full.');
    const item: SavedListItem = {
      id: nextId('item'),
      listId: list.id,
      placeId,
      ...(typeof body.note === 'string' ? { note: body.note.trim() } : {}),
      position: held.length === 0 ? 0 : Math.max(...held.map((entry) => entry.position)) + 1,
      addedAt: new Date().toISOString(),
    };
    items.set(list.id, [...held, item]);
    touch(list);
    return { status: 201, body: item };
  }

  if (itemId === 'order') {
    if (method !== 'PUT') return wrong();
    const named = (body.itemIds as string[] | undefined) ?? [];
    const unknown = named.find((id) => !held.some((entry) => entry.id === id));
    if (unknown !== undefined)
      return failure('validation_failed', 'Every item named must be an item of this list.');
    const ordered = [
      ...named.flatMap((id) => held.filter((entry) => entry.id === id)),
      ...held.filter((entry) => !named.includes(entry.id)),
    ].map((entry, position) => ({ ...entry, position }));
    items.set(list.id, ordered);
    touch(list);
    return { status: 204 };
  }

  const item = held.find((entry) => entry.id === decodeURIComponent(itemId));
  if (!item) return noItem();
  if (method === 'PATCH') {
    const { note: _dropped, ...rest } = item;
    const note = body.note;
    const next: SavedListItem = typeof note === 'string' ? { ...rest, note: note.trim() } : rest;
    items.set(
      list.id,
      held.map((entry) => (entry === item ? next : entry)),
    );
    touch(list);
    return { status: 200, body: next };
  }
  if (method === 'DELETE') {
    items.set(
      list.id,
      held.filter((entry) => entry !== item),
    );
    touch(list);
    return { status: 204 };
  }
  return wrong();
}
