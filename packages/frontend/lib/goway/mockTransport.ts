/**
 * A `GoWayFetch` that answers GoWay's own HTTP routes from local fixtures.
 *
 * ## Why this shape, and not a mock client
 *
 * The obvious stand-in is an object with `places`, `search` and friends that
 * returns fixtures directly. It is also the one that rots: it bypasses the
 * SDK's query serialisation, its response parser and its typed errors, so the
 * UI ends up written against a client that is *similar* to `@goway.to/sdk`
 * rather than identical to it, and the differences only surface the day the
 * backend appears.
 *
 * This intercepts one layer lower — at the single `fetch` seam
 * `createGoWayClient({ fetch })` already exposes — so every request the app
 * makes is built, signed, timed out, parsed and error-classified by the REAL
 * SDK. A fixture that does not satisfy the published contract throws
 * `GoWayResponseError` in development, which is exactly what we want it to do.
 *
 * Swapping in the live backend is therefore the removal of ONE option (see
 * `client.ts`); no call site, hook or component changes.
 *
 * ## What it deliberately simulates
 *
 * Latency and cancellation, because the search box's debounce-and-cancel
 * behaviour is not observable without them, and the fault modes issue #7
 * requires intentional states for (`EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS`).
 */
import {
  API_ERROR_STATUS,
  baseLanguageTag,
  categoryTaxonomy,
  DEFAULT_MEDIA_LIST_LIMIT,
  DEFAULT_PLACE_LIST_LIMIT,
  DEFAULT_REVIEW_LIST_LIMIT,
  localizedLabel,
  normalizeLanguageTag,
  placeMatchesCapabilityFilter,
} from '@goway.to/sdk';
import type {
  ApiErrorCode,
  CategoryPage,
  GoWayFetch,
  GoWayFetchInit,
  GoWayFetchResponse,
  Page,
  Place,
  PlaceMedia,
  PlaceMediaInput,
  PlaceRating,
  PlaceReview,
  PlaceReviewInput,
  PlaceReviewWithStatus,
  SearchResult,
  SearchResults,
  StructuredAddress,
} from '@goway.to/sdk';

import { distanceMeters } from '@/lib/map/geo';

import {
  FIXTURE_CATEGORIES,
  FIXTURE_MEDIA,
  FIXTURE_PLACES,
  FIXTURE_PLACES_BY_ID,
  FIXTURE_REVIEWS,
  FIXTURE_WITHDRAWN_PLACE_IDS,
} from './fixtures';
import { fixtureCoverage, fixtureSceneResponse } from './street3dFixtures';

/** The fixture taxonomy, indexed once: what filters expand through and search labels come from. */
const TAXONOMY = categoryTaxonomy(FIXTURE_CATEGORIES);

/**
 * Which endpoint families can be made to fail, for the degraded states.
 *
 * `mercaria` is not one of GoWay's routes: it is the Mercaria fixture layer
 * (`lib/mercaria/mockTransport.ts`), listed here so ONE variable degrades
 * either side.
 */
export type FixtureFault = 'places' | 'search' | 'geocode' | 'routes' | 'street3d' | 'mercaria';

/** How a faulted endpoint fails. */
export type FixtureFaultMode = 'unavailable' | 'network' | 'degraded';

export interface FixtureFaults {
  places?: FixtureFaultMode;
  search?: FixtureFaultMode;
  geocode?: FixtureFaultMode;
  routes?: FixtureFaultMode;
  /** `street3d:unavailable` is how the map's "hide the layer silently" path is exercised. */
  street3d?: FixtureFaultMode;
  /** `mercaria:unavailable` is how a place's "Products at this store" retry is exercised. */
  mercaria?: FixtureFaultMode;
}

let faults: FixtureFaults = {};

/**
 * Force an endpoint family to fail.
 *
 * Exists so the "search unavailable" and "map data unavailable" states can be
 * driven deliberately — from `EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS`, or from a test
 * — rather than only by unplugging a network cable.
 */
export function setFixtureFaults(next: FixtureFaults): void {
  faults = { ...next };
}

const FIXTURE_FAULTS: readonly FixtureFault[] = [
  'places',
  'search',
  'geocode',
  'routes',
  'street3d',
  'mercaria',
];

/** Parse `EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS=search,places:network`. */
export function parseFixtureFaults(spec: string | undefined): FixtureFaults {
  if (!spec) return {};
  const parsed: FixtureFaults = {};
  for (const entry of spec.split(',')) {
    const [rawName, rawMode] = entry.trim().split(':');
    const name = rawName as FixtureFault;
    if (!FIXTURE_FAULTS.includes(name)) continue;
    const mode = rawMode as FixtureFaultMode | undefined;
    parsed[name] = mode === 'network' || mode === 'degraded' ? mode : 'unavailable';
  }
  return parsed;
}

// ── Galleries and reviews ───────────────────────────────────────────────────

/**
 * The account every fixture write is made as. The fixture layer has no
 * sessions; a review written locally is "yours", and reads it back as such.
 */
export const FIXTURE_REVIEWER = 'fixture-you';

/**
 * The galleries and reviews, copied from the fixtures so a local write changes
 * this session's copy and never the dataset. Reset by `createFixtureFetch`.
 */
let mediaByPlace = new Map<string, PlaceMedia[]>();
let reviewsByPlace = new Map<string, PlaceReview[]>();

function resetContent(): void {
  mediaByPlace = new Map([...FIXTURE_MEDIA].map(([placeId, items]) => [placeId, [...items]]));
  reviewsByPlace = new Map([...FIXTURE_REVIEWS].map(([placeId, items]) => [placeId, [...items]]));
}

/** `Place.rating`, DERIVED from the reviews as the API derives it — never stated beside them. */
function ratingOf(placeId: string): PlaceRating | undefined {
  const reviews = reviewsByPlace.get(placeId) ?? [];
  if (reviews.length === 0) return undefined;
  const sum = reviews.reduce((total, review) => total + review.rating, 0);
  return { average: Math.round((sum / reviews.length) * 10) / 10, count: reviews.length };
}

/** The published reviews in the order asked for, newest first within a rating, as the API orders them. */
function sortedReviews(placeId: string, sort: string | undefined): PlaceReview[] {
  const newestFirst = (a: PlaceReview, b: PlaceReview) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  const reviews = [...(reviewsByPlace.get(placeId) ?? [])];
  if (sort === 'highest') return reviews.sort((a, b) => b.rating - a.rating || newestFirst(a, b));
  if (sort === 'lowest') return reviews.sort((a, b) => a.rating - b.rating || newestFirst(a, b));
  return reviews.sort(newestFirst);
}

function withStatus(review: PlaceReview): PlaceReviewWithStatus {
  return { ...review, status: 'published' };
}

/** `/places/<id>/media` and `/places/<id>/reviews[/mine]`, or `null` for a path that is neither. */
function content(
  path: string,
  params: Map<string, string>,
  init: GoWayFetchInit,
): GoWayFetchResponse | null {
  const match = /^\/places\/([^/]+)\/(media|reviews|reviews\/mine)$/.exec(path);
  if (!match) return null;
  const placeId = decodeURIComponent(match[1]!);
  if (FIXTURE_WITHDRAWN_PLACE_IDS.has(placeId))
    return fail('gone', `Place ${placeId} has been withdrawn`);
  if (!FIXTURE_PLACES_BY_ID.has(placeId)) return fail('not_found', `No place with id ${placeId}`);
  const body = init.body ? (JSON.parse(init.body) as unknown) : undefined;

  if (match[2] === 'media') {
    const gallery = mediaByPlace.get(placeId) ?? [];
    if (init.method === 'GET') {
      const kinds = list(params, 'kinds');
      return respond(
        200,
        page(
          kinds.length > 0 ? gallery.filter((item) => kinds.includes(item.kind)) : gallery,
          params,
          DEFAULT_MEDIA_LIST_LIMIT,
        ),
      );
    }
    if (init.method === 'POST') {
      const input = body as PlaceMediaInput;
      if (gallery.some((item) => item.fileId === input.fileId))
        return fail('conflict', 'That file is already in this gallery.');
      const item: PlaceMedia = {
        id: `${placeId}_media_local_${gallery.length}`,
        placeId,
        fileId: input.fileId,
        kind: input.kind,
        verification: 'community_reported',
        position: gallery.length,
        ...(input.caption ? { caption: input.caption } : {}),
        createdAt: new Date().toISOString(),
      };
      mediaByPlace.set(placeId, [...gallery, item]);
      return respond(201, item);
    }
    return fail('method_not_allowed', `${init.method} is not allowed on ${path}`);
  }

  if (match[2] === 'reviews') {
    if (init.method !== 'GET')
      return fail('method_not_allowed', `${init.method} is not allowed on ${path}`);
    return respond(
      200,
      page(sortedReviews(placeId, params.get('sort')), params, DEFAULT_REVIEW_LIST_LIMIT),
    );
  }

  const reviews = reviewsByPlace.get(placeId) ?? [];
  const mine = reviews.find((review) => review.authorOxyUserId === FIXTURE_REVIEWER);
  if (init.method === 'GET')
    return mine
      ? respond(200, withStatus(mine))
      : fail('not_found', 'You have not reviewed this place.');
  if (init.method === 'DELETE') {
    if (!mine) return fail('not_found', 'You have no review of this place to withdraw.');
    reviewsByPlace.set(
      placeId,
      reviews.filter((review) => review !== mine),
    );
    return respond(204, null);
  }
  if (init.method === 'PUT') {
    const input = body as PlaceReviewInput;
    const now = new Date().toISOString();
    const written: PlaceReview = {
      id: mine?.id ?? `${placeId}_review_local`,
      placeId,
      rating: input.rating,
      ...(input.title ? { title: input.title } : {}),
      ...(input.body ? { body: input.body } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      authorOxyUserId: FIXTURE_REVIEWER,
      createdAt: mine?.createdAt ?? now,
      ...(mine ? { editedAt: now } : {}),
    };
    reviewsByPlace.set(placeId, [...reviews.filter((review) => review !== mine), written]);
    return respond(mine ? 200 : 201, withStatus(written));
  }
  return fail('method_not_allowed', `${init.method} is not allowed on ${path}`);
}

// ── Response plumbing ───────────────────────────────────────────────────────

function respond(status: number, body: unknown): GoWayFetchResponse {
  const text = status === 204 ? '' : JSON.stringify(body);
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

/**
 * GoWay's error envelope, exactly as `ApiErrorBody` declares it, at the status
 * the contract assigns its code — never a code outside the closed list.
 */
function fail(code: ApiErrorCode, message: string): GoWayFetchResponse {
  return respond(API_ERROR_STATUS[code], { error: { code, message } });
}

const MIN_LATENCY_MS = 90;
const MAX_LATENCY_MS = 280;

/**
 * Sleep, but honour the abort signal.
 *
 * Without this the mock resolves a cancelled request, so a superseded search
 * still lands and the UI looks like it ignores its own cancellation — the
 * opposite of what the real transport does.
 */
function delay(ms: number, signal: GoWayFetchInit['signal']): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error('aborted'));
      return;
    }
    signal?.addEventListener?.('abort', onAbort);
  });
}

/** One fixture round trip's worth of waiting — shared with the Mercaria fixture layer. */
export function fixtureLatency(signal: GoWayFetchInit['signal']): Promise<void> {
  return delay(MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS), signal);
}

// ── Query helpers ───────────────────────────────────────────────────────────

/**
 * Split a URL the SDK built into its path below `/api/v1` and its parameters.
 *
 * Hand-parsed rather than through `URL`, which is incomplete in React Native —
 * the same reason the SDK serialises its own query string.
 */
function splitUrl(url: string): { path: string; params: Map<string, string> } {
  const [beforeQuery, query = ''] = url.split('?');
  const marker = beforeQuery.indexOf('/api/v1');
  const path = marker >= 0 ? beforeQuery.slice(marker + '/api/v1'.length) : beforeQuery;
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [key, value = ''] = pair.split('=');
    params.set(decodeURIComponent(key), decodeURIComponent(value));
  }
  return { path, params };
}

const num = (params: Map<string, string>, key: string): number | undefined => {
  const raw = params.get(key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const list = (params: Map<string, string>, key: string): string[] =>
  params.get(key)?.split(',').filter(Boolean) ?? [];

/** The cursors this transport mints: an offset into the list, `o<n>`. */
const FIXTURE_CURSOR = /^o(\d+)$/;

/**
 * One page of `entries`, shaped as every GoWay list answers: `{ items,
 * nextCursor }`, with `nextCursor` `null` on the last page.
 *
 * The fixture cursor is an offset. The real API's place lists page by keyset
 * and only its search pages by offset, but a cursor is OPAQUE to a client —
 * pass it back with the same filters — so the difference does not reach the
 * SDK. A cursor this transport did not mint is refused before a handler runs.
 */
function page<T>(
  entries: readonly T[],
  params: Map<string, string>,
  defaultLimit: number,
): Page<T> {
  const offset = Number(FIXTURE_CURSOR.exec(params.get('cursor') ?? '')?.[1] ?? 0);
  const end = offset + (num(params, 'limit') ?? defaultLimit);
  return { items: entries.slice(offset, end), nextCursor: end < entries.length ? `o${end}` : null };
}

/** Lower-case and strip combining marks, so "cafe" finds "Cafès". */
function fold(value: string): string {
  const lowered = value.toLowerCase();
  try {
    return lowered.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    return lowered;
  }
}

/**
 * Every address part as one searchable string.
 *
 * Deliberately NOT `formatAddress` from `./format`: that module reaches into
 * the category table for its subtitle helper, which reaches into Bloom's icon
 * subpaths — so importing it here would put React Native UI in the data layer
 * and make this transport unloadable outside the app.
 */
function addressText(address: StructuredAddress | undefined): string {
  if (!address) return '';
  return [
    address.formatted,
    address.street,
    address.houseNumber,
    address.locality,
    address.city,
    address.region,
    address.postalCode,
    address.country,
  ]
    .filter(Boolean)
    .join(' ');
}

function matchesFilters(
  entry: Place,
  categories: readonly string[],
  capabilities: readonly string[],
): boolean {
  // A parent matches every category below it, as the API expands it.
  if (categories.length > 0) {
    const wanted = new Set<string>(categories.flatMap(TAXONOMY.descendants));
    if (!entry.categories.some((key) => wanted.has(key))) return false;
  }
  // Capabilities are a CONJUNCTION, by the contract's own strongest-assertion
  // rule — the one the server applies in SQL.
  return capabilities.every((filter) => placeMatchesCapabilityFilter(entry, filter));
}

// ── Endpoint handlers ───────────────────────────────────────────────────────

/**
 * Apply the `locale` parameter the way the real API does.
 *
 * Two behaviours worth mirroring rather than approximating, because a fixture
 * that is more generous than the server hides the bug it should surface:
 *
 *  - A LIST read publishes `localizedName` and NOT `names` — nor the
 *    descriptions. A UI that reached for either on a viewport read would
 *    work here and break against `api.goway.to`. `hoursExceptions` is on
 *    every read, `[]` when there are none, because open-now needs it.
 *  - A place with no name in the asked-for language keeps its default name and
 *    gets no `localizedName` at all. That is the common case, not the edge one,
 *    and `placeDisplayName` is what makes it invisible.
 *
 * The resolution itself is the SDK's published normalizer plus the server's
 * order — exact tag, then bare language, then another variety of it.
 */
function localize<T extends Place>(place: T, locale: string | undefined, full: boolean): T {
  const requested = normalizeLanguageTag(locale);
  const base = requested === undefined ? undefined : baseLanguageTag(requested);
  const names = place.names ?? [];
  const resolved =
    requested === undefined
      ? undefined
      : (names.find((name) => name.language === requested) ??
        names.find((name) => name.language === base) ??
        names.find((name) => baseLanguageTag(name.language) === base));

  const {
    names: _all,
    hoursExceptions: _exceptions,
    description: _description,
    descriptions: _descriptions,
    ...rest
  } = place;
  const result = { ...rest } as T;
  if (full && place.names) result.names = place.names;
  result.hoursExceptions = place.hoursExceptions ?? [];
  if (resolved) result.localizedName = resolved;
  // Descriptions are a single-place read's, like `names`, and resolve the same way.
  if (full && place.description) result.description = place.description;
  if (full && place.descriptions) {
    result.descriptions = place.descriptions;
    const description =
      requested === undefined
        ? undefined
        : (place.descriptions.find((entry) => entry.language === requested) ??
          place.descriptions.find((entry) => entry.language === base) ??
          place.descriptions.find((entry) => baseLanguageTag(entry.language) === base));
    if (description) result.localizedDescription = description;
  }
  const rating = ratingOf(place.id);
  if (rating) result.rating = rating;
  return result;
}

function placesInBounds(params: Map<string, string>): Page<Place> {
  const west = num(params, 'west') ?? -180;
  const south = num(params, 'south') ?? -90;
  const east = num(params, 'east') ?? 180;
  const north = num(params, 'north') ?? 90;
  const categories = list(params, 'categories');
  const capabilities = list(params, 'capabilities');

  const matched = FIXTURE_PLACES.filter((entry) => {
    const { latitude, longitude } = entry.location;
    // A box crossing the antimeridian has west > east; the fixture set is in
    // Europe, but getting this wrong silently selects the complement.
    const withinLongitude =
      west <= east
        ? longitude >= west && longitude <= east
        : longitude >= west || longitude <= east;
    return withinLongitude && latitude >= south && latitude <= north;
  })
    .filter((entry) => matchesFilters(entry, categories, capabilities))
    .map((entry) => localize(entry, params.get('locale'), false));
  return page(matched, params, DEFAULT_PLACE_LIST_LIMIT);
}

function placesNearby(params: Map<string, string>) {
  const latitude = num(params, 'latitude') ?? 0;
  const longitude = num(params, 'longitude') ?? 0;
  const radiusMeters = num(params, 'radiusMeters') ?? 1000;
  const categories = list(params, 'categories');
  const capabilities = list(params, 'capabilities');

  const matched = FIXTURE_PLACES.map((entry) => ({
    ...entry,
    distanceMeters: distanceMeters({ latitude, longitude }, entry.location),
  }))
    .filter((entry) => entry.distanceMeters <= radiusMeters)
    .filter((entry) => matchesFilters(entry, categories, capabilities))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .map((entry) => localize(entry, params.get('locale'), false));
  return page(matched, params, DEFAULT_PLACE_LIST_LIMIT);
}

/** A couple of geocoder-only candidates, so results are not all GoWay places. */
const GEOCODED: readonly SearchResult[] = [
  {
    id: 'photon:street:passeig-de-gracia',
    displayName: 'Passeig de Gràcia, Barcelona',
    kind: 'street',
    coordinate: { latitude: 41.3918, longitude: 2.165 },
    boundingBox: { west: 2.162, south: 41.3866, east: 2.168, north: 41.3975 },
    context: { city: 'Barcelona', region: 'Catalonia', country: 'Spain', countryCode: 'ES' },
    source: 'photon',
    sourceId: 'W/7126642',
    relevance: 0.74,
  },
  {
    id: 'photon:locality:gracia',
    displayName: 'Gràcia, Barcelona',
    kind: 'locality',
    coordinate: { latitude: 41.4036, longitude: 2.156 },
    boundingBox: { west: 2.14, south: 41.396, east: 2.172, north: 41.42 },
    context: { city: 'Barcelona', region: 'Catalonia', country: 'Spain', countryCode: 'ES' },
    source: 'photon',
    sourceId: 'R/349055',
    relevance: 0.69,
  },
];

function placeAsResult(entry: Place): SearchResult {
  const result: SearchResult = {
    id: `goway:${entry.id}`,
    displayName: entry.name,
    kind: entry.categories.length > 0 ? 'place' : 'poi',
    coordinate: entry.location,
    source: 'goway',
    sourceId: entry.id,
    placeId: entry.id,
    place: entry,
    relevance: 0.9,
  };
  if (entry.address) result.address = entry.address;
  return result;
}

function search(params: Map<string, string>): SearchResults {
  // `q`, not `query`: the parameter names here are the contract's own
  // (`searchParametersOf` in `@goway/contracts`, which the SDK sends through),
  // and a mock that invents its own stops matching the backend the day it ships.
  const needle = fold(params.get('q') ?? '');
  const categories = list(params, 'categories');
  const capabilities = list(params, 'capabilities');
  // `near` is serialised FLAT as `latitude`/`longitude`; the viewport box uses
  // the same `west/south/east/north` names as the bounds read.
  const nearLatitude = num(params, 'latitude');
  const nearLongitude = num(params, 'longitude');

  const matched = FIXTURE_PLACES.filter((entry) => {
    if (!matchesFilters(entry, categories, capabilities)) return false;
    if (needle === '') return false;
    // A category by its labels, as the server matches it — never by its key.
    const categoryWords = entry.categories.flatMap((key) => {
      const category = TAXONOMY.of(key);
      return category ? Object.values(category.labels) : [];
    });
    const haystack = fold([entry.name, addressText(entry.address), ...categoryWords].join(' '));
    return haystack.includes(needle);
  });

  // `near` only RE-RANKS; it is never a filter (see `SearchQuery`).
  const biased =
    nearLatitude != null && nearLongitude != null
      ? matched
          .slice()
          .sort(
            (a, b) =>
              distanceMeters({ latitude: nearLatitude, longitude: nearLongitude }, a.location) -
              distanceMeters({ latitude: nearLatitude, longitude: nearLongitude }, b.location),
          )
      : matched;

  const geocoded =
    needle === '' ? [] : GEOCODED.filter((entry) => fold(entry.displayName).includes(needle));

  const results = [
    ...biased.map((entry) => placeAsResult(localize(entry, params.get('locale'), true))),
    ...geocoded,
  ];
  const response: SearchResults = { ...page(results, params, 20), providers: ['goway', 'photon'] };
  if (faults.search === 'degraded') {
    response.providers = ['goway'];
    response.degradedProviders = ['photon'];
  }
  return response;
}

function reverseGeocode(params: Map<string, string>): SearchResults {
  const latitude = num(params, 'latitude') ?? 0;
  const longitude = num(params, 'longitude') ?? 0;
  const radiusMeters = num(params, 'radiusMeters') ?? 120;

  const nearest = FIXTURE_PLACES.map((entry) => ({
    entry,
    distance: distanceMeters({ latitude, longitude }, entry.location),
  }))
    .filter((candidate) => candidate.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .map((candidate) => placeAsResult(localize(candidate.entry, params.get('locale'), true)));

  return { ...page(nearest, params, 5), providers: ['goway', 'nominatim'] };
}

/**
 * A straight-line "route", through every stop in order.
 *
 * Deliberately crude, and labelled as such: real routing is the backend's job
 * (Valhalla, issue #6) and this exists so the directions FLOW has something
 * shaped like a route to work against. A fake polyline along real streets would
 * be a worse lie than an obvious one.
 *
 * It does honour the things the planner depends on, because a fixture that does
 * not is a fixture that hides bugs:
 *
 *  - **`waypoints` are visited in the order given.** That is the contract's own
 *    promise, and the whole meaning of reordering a stop.
 *  - **One leg per pair of consecutive stops**, each with its own maneuvers,
 *    so a multi-stop itinerary produces the multi-leg response the panel heads
 *    with "To <stop>".
 *  - **`geometryIndex` is an index into the ROUTE's geometry**, not the leg's,
 *    matching what the contract documents — which is what the step highlight
 *    slices with.
 *  - **A `placeId` resolves through the place table**, so passing a place ID
 *    rather than a coordinate is exercised end to end.
 */
function directions(body: unknown) {
  interface FixtureRouteLocation {
    coordinate?: { latitude: number; longitude: number };
    placeId?: string;
    name?: string;
  }
  const request = body as {
    origin?: FixtureRouteLocation;
    destination?: FixtureRouteLocation;
    waypoints?: FixtureRouteLocation[];
    mode?: string;
  };

  const resolve = (end: FixtureRouteLocation | undefined) => {
    if (end?.coordinate) return { point: end.coordinate, name: end.name };
    if (end?.placeId) {
      const place = FIXTURE_PLACES_BY_ID.get(end.placeId);
      return place ? { point: place.location, name: end.name ?? place.name } : undefined;
    }
    return undefined;
  };

  const stops = [request.origin, ...(request.waypoints ?? []), request.destination].map(resolve);
  // "No route exists" is a normal answer for this domain, not a failure — and
  // an unresolvable stop is exactly how a caller gets one.
  if (stops.length < 2 || stops.some((stop) => stop === undefined)) return { routes: [] };
  const resolved = stops as Array<{
    point: { latitude: number; longitude: number };
    name?: string;
  }>;

  const mode = request.mode === 'drive' || request.mode === 'bike' ? request.mode : 'walk';
  const speed = mode === 'drive' ? 8.3 : mode === 'bike' ? 4.2 : 1.35;

  const legs = resolved.slice(0, -1).map((from, index) => {
    const to = resolved[index + 1];
    // 1.25× the straight line: a road is never the crow's path, and rounding a
    // fixture UP keeps it from reading as suspiciously exact.
    const metres = Math.round(distanceMeters(from.point, to.point) * 1.25);
    const seconds = Math.round(metres / speed);
    const last = index === resolved.length - 2;
    return {
      distanceMeters: metres,
      durationSeconds: seconds,
      maneuvers: [
        {
          type: index === 0 ? 'depart' : 'continue',
          instruction: to.name ? `Head toward ${to.name}` : 'Head toward the next stop',
          distanceMeters: metres,
          durationSeconds: seconds,
          coordinate: from.point,
          geometryIndex: index,
        },
        {
          type: 'arrive',
          instruction: last
            ? `You have arrived${to.name ? ` at ${to.name}` : ''}`
            : `Stop at ${to.name ?? 'your next stop'}`,
          distanceMeters: 0,
          durationSeconds: 0,
          coordinate: to.point,
          geometryIndex: index + 1,
        },
      ],
    };
  });

  return {
    routes: [
      {
        id: `fixture-${mode}-${legs.length}`,
        mode,
        distanceMeters: legs.reduce((total, leg) => total + leg.distanceMeters, 0),
        durationSeconds: legs.reduce((total, leg) => total + leg.durationSeconds, 0),
        geometry: {
          type: 'LineString',
          coordinates: resolved.map(({ point }) => [point.longitude, point.latitude]),
        },
        legs,
      },
    ],
  };
}

/**
 * `GET /categories`, as the API answers it: the whole list in one page, each
 * `label` resolved for `locale` by the same matcher the server uses, every
 * language still in `labels`.
 */
function categoryList(params: Map<string, string>): CategoryPage {
  const locale = params.get('locale');
  return {
    items: FIXTURE_CATEGORIES.map((category) => ({
      ...category,
      label: localizedLabel(category.labels, locale),
    })),
    nextCursor: null,
  };
}

// ── The fetch itself ────────────────────────────────────────────────────────

/** The fixed paths this transport answers, besides `/places/<placeId>`. */
const FIXTURE_ROUTES: ReadonlySet<string> = new Set([
  '/categories',
  '/places/bounds',
  '/places/nearby',
  '/search',
  '/geocode',
  '/geocode/reverse',
  '/geocode/structured',
  '/routes',
]);

function familyOf(path: string): FixtureFault {
  if (path.startsWith('/search')) return 'search';
  if (path.startsWith('/geocode')) return 'geocode';
  if (path.startsWith('/routes')) return 'routes';
  if (path.startsWith('/street3d')) return 'street3d';
  return 'places';
}

/**
 * Build the fixture-backed `fetch`.
 *
 * `initialFaults` seeds the fault table so a caller can construct a client that
 * is degraded from the first request (which is how the env var works).
 */
export function createFixtureFetch(initialFaults: FixtureFaults = {}): GoWayFetch {
  setFixtureFaults(initialFaults);
  resetContent();

  return async function fixtureFetch(
    url: string,
    init: GoWayFetchInit,
  ): Promise<GoWayFetchResponse> {
    const { path, params } = splitUrl(url);
    const family = familyOf(path);

    await fixtureLatency(init.signal);

    const fault = faults[family];
    // A network fault must look like a network fault: the SDK turns a THROWN
    // fetch into `GoWayNetworkError`, which is what "you are offline" reads.
    if (fault === 'network') throw new TypeError('Network request failed');
    if (fault === 'unavailable') {
      // `provider_unavailable` for the two families backed by an upstream
      // geocoder, `service_unavailable` for GoWay's own reads. Both are 503 and
      // both are retryable, but only the first means "the geographic data
      // source is down", which is a different sentence to show a user.
      const code =
        family === 'search' || family === 'geocode'
          ? 'provider_unavailable'
          : 'service_unavailable';
      return fail(code, `${family} is temporarily unavailable`);
    }

    const cursor = params.get('cursor');
    if (cursor !== undefined && !FIXTURE_CURSOR.test(cursor)) {
      return fail('bad_request', 'That cursor was not issued by this list.');
    }

    if (path === '/street3d/coverage') {
      if (init.method !== 'GET')
        return fail('method_not_allowed', `${init.method} is not allowed on ${path}`);
      return respond(
        200,
        fixtureCoverage({
          west: num(params, 'west') ?? -180,
          south: num(params, 'south') ?? -90,
          east: num(params, 'east') ?? 180,
          north: num(params, 'north') ?? 90,
        }),
      );
    }
    const sceneRoute = /^\/street3d\/scenes\/([^/]+)(\/reports)?$/.exec(path);
    if (sceneRoute) {
      const id = decodeURIComponent(sceneRoute[1]);
      const scene = await fixtureSceneResponse(id);
      if (!scene) return fail('not_found', `No scene with id ${id}`);
      if (!sceneRoute[2]) {
        if (init.method !== 'GET')
          return fail('method_not_allowed', `${init.method} is not allowed on ${path}`);
        return respond(200, scene);
      }
      if (init.method !== 'POST')
        return fail('method_not_allowed', `${init.method} is not allowed on ${path}`);
      // Mirrors the API: a report is identity-bound, so no bearer is a 401.
      const authorization = init.headers?.Authorization ?? init.headers?.authorization;
      if (!authorization) return fail('unauthorized', 'Sign in to report a scene');
      const body = init.body ? (JSON.parse(init.body) as { reason?: string }) : {};
      return respond(201, {
        id: `r_fixture_${Math.random().toString(36).slice(2, 10)}`,
        sceneId: id,
        version: scene.version,
        reason: body.reason ?? 'other',
        createdAt: new Date().toISOString(),
      });
    }

    const served = content(path, params, init);
    if (served) return served;

    // Every other fixture route is a read except directions, which is a POST.
    const placeId = /^\/places\/([^/]+)$/.exec(path)?.[1];
    if (placeId === undefined && !FIXTURE_ROUTES.has(path))
      return fail('unknown_route', `No route for ${path}`);
    if (init.method !== (path === '/routes' ? 'POST' : 'GET')) {
      return fail('method_not_allowed', `${init.method} is not allowed on ${path}`);
    }

    if (path === '/categories') return respond(200, categoryList(params));
    if (path === '/places/bounds') return respond(200, placesInBounds(params));
    if (path === '/places/nearby') return respond(200, placesNearby(params));
    if (placeId !== undefined) {
      const id = decodeURIComponent(placeId);
      if (FIXTURE_WITHDRAWN_PLACE_IDS.has(id))
        return fail('gone', `Place ${id} has been withdrawn`);
      const found = FIXTURE_PLACES_BY_ID.get(id);
      return found
        ? respond(200, localize(found, params.get('locale'), true))
        : fail('not_found', `No place with id ${id}`);
    }
    if (path === '/search' || path === '/geocode') return respond(200, search(params));
    if (path === '/geocode/reverse') return respond(200, reverseGeocode(params));
    if (path === '/geocode/structured') {
      return respond(200, {
        items: [],
        nextCursor: null,
        providers: ['nominatim'],
      } satisfies SearchResults);
    }
    return respond(200, directions(init.body ? JSON.parse(init.body) : undefined));
  };
}
