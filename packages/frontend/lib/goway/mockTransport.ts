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
import { baseLanguageTag, normalizeLanguageTag } from '@goway.to/sdk';
import type {
  GoWayFetch,
  GoWayFetchInit,
  GoWayFetchResponse,
  Place,
  SearchResult,
  SearchResults,
  StructuredAddress,
} from '@goway.to/sdk';

import { distanceMeters } from '@/lib/map/geo';

import { FIXTURE_PLACES, FIXTURE_PLACES_BY_ID } from './fixtures';

/** Which endpoint families can be made to fail, for the degraded states. */
export type FixtureFault = 'places' | 'search' | 'geocode' | 'routes';

/** How a faulted endpoint fails. */
export type FixtureFaultMode = 'unavailable' | 'network' | 'degraded';

export interface FixtureFaults {
  places?: FixtureFaultMode;
  search?: FixtureFaultMode;
  geocode?: FixtureFaultMode;
  routes?: FixtureFaultMode;
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

/** Parse `EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS=search,places:network`. */
export function parseFixtureFaults(spec: string | undefined): FixtureFaults {
  if (!spec) return {};
  const parsed: FixtureFaults = {};
  for (const entry of spec.split(',')) {
    const [rawName, rawMode] = entry.trim().split(':');
    const name = rawName as FixtureFault;
    if (name !== 'places' && name !== 'search' && name !== 'geocode' && name !== 'routes') continue;
    const mode = rawMode as FixtureFaultMode | undefined;
    parsed[name] = mode === 'network' || mode === 'degraded' ? mode : 'unavailable';
  }
  return parsed;
}

// ── Response plumbing ───────────────────────────────────────────────────────

function respond(status: number, body: unknown): GoWayFetchResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

/** GoWay's error envelope, exactly as `ApiErrorBody` declares it. */
function errorBody(code: string, message: string) {
  return { error: { code, message } };
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

function matchesFilters(entry: Place, categories: readonly string[], capabilities: readonly string[]): boolean {
  if (categories.length > 0 && !entry.categories.some((key) => categories.includes(key))) return false;
  // Capabilities are a CONJUNCTION, as the SDK documents: a place must assert
  // every listed one.
  if (capabilities.length > 0) {
    const asserted = new Set(
      entry.capabilities.filter((capability) => capability.value !== false).map((capability) => capability.key),
    );
    if (!capabilities.every((key) => asserted.has(key))) return false;
  }
  return true;
}

// ── Endpoint handlers ───────────────────────────────────────────────────────

/**
 * Apply the `locale` parameter the way the real API does.
 *
 * Two behaviours worth mirroring rather than approximating, because a fixture
 * that is more generous than the server hides the bug it should surface:
 *
 *  - A LIST read publishes `localizedName` and NOT `names`. A UI that reached
 *    for `place.names` on a viewport read would work here and break against
 *    `api.goway.to`.
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
      : names.find((name) => name.language === requested) ??
        names.find((name) => name.language === base) ??
        names.find((name) => baseLanguageTag(name.language) === base);

  const { names: _all, ...rest } = place;
  const result = { ...rest } as T;
  if (full && place.names) result.names = place.names;
  if (resolved) result.localizedName = resolved;
  return result;
}

function placesInBounds(params: Map<string, string>): Place[] {
  const west = num(params, 'west') ?? -180;
  const south = num(params, 'south') ?? -90;
  const east = num(params, 'east') ?? 180;
  const north = num(params, 'north') ?? 90;
  const categories = list(params, 'categories');
  const capabilities = list(params, 'capabilities');
  const limit = num(params, 'limit') ?? 200;

  return FIXTURE_PLACES.filter((entry) => {
    const { latitude, longitude } = entry.location;
    // A box crossing the antimeridian has west > east; the fixture set is in
    // Europe, but getting this wrong silently selects the complement.
    const withinLongitude = west <= east
      ? longitude >= west && longitude <= east
      : longitude >= west || longitude <= east;
    return withinLongitude && latitude >= south && latitude <= north;
  })
    .filter((entry) => matchesFilters(entry, categories, capabilities))
    .slice(0, limit)
    .map((entry) => localize(entry, params.get('locale'), false));
}

function placesNearby(params: Map<string, string>) {
  const latitude = num(params, 'latitude') ?? 0;
  const longitude = num(params, 'longitude') ?? 0;
  const radiusMeters = num(params, 'radiusMeters') ?? 1000;
  const categories = list(params, 'categories');
  const capabilities = list(params, 'capabilities');
  const limit = num(params, 'limit') ?? 50;

  return FIXTURE_PLACES.map((entry) => ({
    ...entry,
    distanceMeters: distanceMeters({ latitude, longitude }, entry.location),
  }))
    .filter((entry) => entry.distanceMeters <= radiusMeters)
    .filter((entry) => matchesFilters(entry, categories, capabilities))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit)
    .map((entry) => localize(entry, params.get('locale'), false));
}

/** A couple of geocoder-only candidates, so results are not all GoWay places. */
const GEOCODED: readonly SearchResult[] = [
  {
    id: 'photon:street:passeig-de-gracia',
    displayName: 'Passeig de Gràcia, Barcelona',
    kind: 'street',
    coordinate: { latitude: 41.3918, longitude: 2.1650 },
    boundingBox: { west: 2.1620, south: 41.3866, east: 2.1680, north: 41.3975 },
    context: { city: 'Barcelona', region: 'Catalonia', country: 'Spain', countryCode: 'ES' },
    source: 'photon',
    sourceId: 'W/7126642',
    relevance: 0.74,
  },
  {
    id: 'photon:locality:gracia',
    displayName: 'Gràcia, Barcelona',
    kind: 'locality',
    coordinate: { latitude: 41.4036, longitude: 2.1560 },
    boundingBox: { west: 2.1400, south: 41.3960, east: 2.1720, north: 41.4200 },
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
  // `q`, not `query`: the parameter names here are the SDK's own
  // (`searchQuery()` in `packages/sdk/src/client.ts`), and a mock that invents
  // its own is a mock that stops matching the backend the day it ships.
  const needle = fold(params.get('q') ?? '');
  const limit = num(params, 'limit') ?? 20;
  const categories = list(params, 'categories');
  const capabilities = list(params, 'capabilities');
  // `near` is serialised FLAT as `latitude`/`longitude`; the viewport box uses
  // the same `west/south/east/north` names as the bounds read.
  const nearLatitude = num(params, 'latitude');
  const nearLongitude = num(params, 'longitude');

  const matched = FIXTURE_PLACES.filter((entry) => {
    if (!matchesFilters(entry, categories, capabilities)) return false;
    if (needle === '') return false;
    const haystack = fold([entry.name, addressText(entry.address), entry.categories.join(' ')].join(' '));
    return haystack.includes(needle);
  });

  // `near` only RE-RANKS; it is never a filter (see `SearchQuery`).
  const biased = nearLatitude != null && nearLongitude != null
    ? matched
        .slice()
        .sort(
          (a, b) =>
            distanceMeters({ latitude: nearLatitude, longitude: nearLongitude }, a.location) -
            distanceMeters({ latitude: nearLatitude, longitude: nearLongitude }, b.location),
        )
    : matched;

  const geocoded = needle === ''
    ? []
    : GEOCODED.filter((entry) => fold(entry.displayName).includes(needle));

  const results = [
    ...biased.map((entry) => placeAsResult(localize(entry, params.get('locale'), true))),
    ...geocoded,
  ].slice(0, limit);
  const response: SearchResults = { results, providers: ['goway', 'photon'] };
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
    .slice(0, num(params, 'limit') ?? 5);

  return {
    results: nearest.map((candidate) =>
      placeAsResult(localize(candidate.entry, params.get('locale'), true)),
    ),
    providers: ['goway', 'nominatim'],
  };
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
 *    matching what `shared-types` documents — which is what the step highlight
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
  const resolved = stops as Array<{ point: { latitude: number; longitude: number }; name?: string }>;

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

// ── The fetch itself ────────────────────────────────────────────────────────

function familyOf(path: string): FixtureFault {
  if (path.startsWith('/search')) return 'search';
  if (path.startsWith('/geocode')) return 'geocode';
  if (path.startsWith('/routes')) return 'routes';
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

  return async function fixtureFetch(url: string, init: GoWayFetchInit): Promise<GoWayFetchResponse> {
    const { path, params } = splitUrl(url);
    const family = familyOf(path);

    await delay(MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS), init.signal);

    const fault = faults[family];
    // A network fault must look like a network fault: the SDK turns a THROWN
    // fetch into `GoWayNetworkError`, which is what "you are offline" reads.
    if (fault === 'network') throw new TypeError('Network request failed');
    if (fault === 'unavailable') {
      // `provider_unavailable` for the two families backed by an upstream
      // geocoder, `service_unavailable` for GoWay's own reads. Both are 503 and
      // both are retryable, but only the first means "the geographic data
      // source is down", which is a different sentence to show a user.
      const code = family === 'search' || family === 'geocode' ? 'provider_unavailable' : 'service_unavailable';
      return respond(503, errorBody(code, `${family} is temporarily unavailable`));
    }

    if (path === '/places/bounds') return respond(200, placesInBounds(params));
    if (path === '/places/nearby') return respond(200, placesNearby(params));
    if (path.startsWith('/places/')) {
      const id = decodeURIComponent(path.slice('/places/'.length));
      const found = FIXTURE_PLACES_BY_ID.get(id);
      return found
        ? respond(200, localize(found, params.get('locale'), true))
        : respond(404, errorBody('not_found', `No place with id ${id}`));
    }
    if (path === '/search' || path === '/geocode') return respond(200, search(params));
    if (path === '/geocode/reverse') return respond(200, reverseGeocode(params));
    if (path === '/geocode/structured') return respond(200, { results: [], providers: ['nominatim'] });
    if (path === '/routes') {
      return respond(200, directions(init.body ? JSON.parse(init.body) : undefined));
    }

    return respond(404, errorBody('not_found', `No fixture route for ${path}`));
  };
}
