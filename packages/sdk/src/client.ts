import { TRAVEL_MODES } from './contract';
import type {
  GeoCoordinate,
  MapViewport,
  NearbyPlacesQuery,
  Place,
  PlaceId,
  PlaceSourceRef,
  PlacesInBoundsQuery,
  PlaceWithDistance,
  ReverseGeocodeQuery,
  RouteLocation,
  RouteRequest,
  RouteResponse,
  SearchQuery,
  SearchResults,
  StructuredGeocodeQuery,
} from './contract';
import { GoWayValidationError } from './errors';
import {
  parsePlace,
  parsePlaceList,
  parsePlaceWithDistanceList,
  parseRouteResponse,
  parseSearchResults,
} from './parse';
import type { GoWayAbortSignal, GoWayFetch } from './runtime';
import {
  pathSegment,
  request,
  type GoWayAccessTokenGetter,
  type QueryValue,
  type TransportConfig,
} from './transport';

/** The public API origin a client talks to unless told otherwise. */
export const DEFAULT_GOWAY_API_BASE_URL = 'https://api.goway.to';
/** The web origin canonical links are built on unless told otherwise. */
export const DEFAULT_GOWAY_WEB_BASE_URL = 'https://goway.to';
/** How long one request may take, token acquisition and body included. */
export const DEFAULT_GOWAY_TIMEOUT_MS = 15_000;

export interface GoWayClientOptions {
  /** The API origin. Defaults to {@link DEFAULT_GOWAY_API_BASE_URL}. */
  apiBaseUrl?: string;
  /** The web origin canonical links are built on. Defaults to {@link DEFAULT_GOWAY_WEB_BASE_URL}. */
  webBaseUrl?: string;
  /**
   * A `fetch` implementation. Defaults to the runtime's global `fetch`, looked
   * up on each request (so a polyfill installed after the client is created is
   * still used).
   */
  fetch?: GoWayFetch;
  /**
   * Supplies the current Oxy access token. Called before EVERY request and
   * never cached, stored or logged by the SDK — the host's Oxy auth package
   * owns the session and its refresh, and a copy held here would go stale.
   * Return `null`/`undefined` (or `''`) for an anonymous request. An error it
   * throws is passed through unchanged.
   *
   * Omitting it is a normal configuration: the map, search and routing all work
   * signed out. Only identity-bound calls — creating or editing a place,
   * asserting a capability — need a token.
   */
  getAccessToken?: GoWayAccessTokenGetter;
  /**
   * The default locale (a BCP 47 tag such as `es` or `pt-BR`) for localized
   * names and maneuver instructions. Each call that accepts one can override it.
   */
  locale?: string;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_GOWAY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Extra, NON-auth headers sent with every request (e.g. a tracing id).
   * `Authorization` and `Accept` are owned by the SDK and rejected here; auth
   * goes through `getAccessToken`.
   */
  headers?: Readonly<Record<string, string>>;
}

/** Options every call accepts. */
export interface GoWayRequestOptions {
  /** Cancels the request; the promise rejects with `GoWayAbortError`. */
  signal?: GoWayAbortSignal;
}

/**
 * A capability claim as a CLIENT asserts it.
 *
 * `verification` is deliberately absent: the server derives it from the
 * caller's authorization, so a community report cannot arrive labelled
 * `oxy_verified` simply because the client said so. `observedAt` is the
 * server's clock for the same reason.
 */
export interface PlaceCapabilityInput {
  /** e.g. `payments.faircoin` */
  namespace: string;
  /** e.g. `accepted` */
  capability: string;
  /** `true`/`false` for a flag; a string or number for a valued capability. */
  value: boolean | string | number;
  /** The outside source this claim came from, when it did. */
  source?: PlaceSourceRef;
}

/** The fields a client may set when creating a place. */
export type PlaceCreateInput = Pick<Place, 'name' | 'location'> &
  Partial<Pick<Place, 'geometry' | 'categories' | 'address' | 'contact' | 'openingHours' | 'status'>> & {
    capabilities?: readonly PlaceCapabilityInput[];
    /** The outside records this place reconciles against, when the caller knows them. */
    sources?: readonly PlaceSourceRef[];
  };

/**
 * The fields a client may change on an existing place.
 *
 * Every field is optional and only the ones present are touched: GoWay layers
 * enrichment OVER source data and never destructively overwrites a source fact,
 * so an update that omits `address` leaves the address alone rather than
 * clearing it.
 */
export type PlaceUpdateInput = Partial<PlaceCreateInput>;

export interface GoWayPlacesApi {
  /**
   * One place by its stable GoWay Place ID. Never a provider id: an OSM node
   * can be renumbered without GoWay losing the place's identity.
   */
  get(placeId: PlaceId, options?: GoWayRequestOptions): Promise<Place>;
  /**
   * Places within `radiusMeters` of a point, nearest first, each carrying its
   * distance.
   *
   * `capabilities` is the generic filter every Oxy product shares — pass
   * `['payments.faircoin.accepted']` for FairCoin merchants, or
   * `['mobility.moovo.pickup']` for Moovo pickup points. A place must assert
   * EVERY listed capability. Nothing about the capability table's layout leaks
   * into this call.
   */
  nearby(query: NearbyPlacesQuery, options?: GoWayRequestOptions): Promise<PlaceWithDistance[]>;
  /** Places inside a bounding box — the map-viewport read. */
  inBounds(query: PlacesInBoundsQuery, options?: GoWayRequestOptions): Promise<Place[]>;
  /** Create a GoWay-owned place. Identity-bound: requires an Oxy access token. */
  create(input: PlaceCreateInput, options?: GoWayRequestOptions): Promise<Place>;
  /** Update a place the caller is entitled to edit. Identity-bound. */
  update(placeId: PlaceId, input: PlaceUpdateInput, options?: GoWayRequestOptions): Promise<Place>;
}

export interface GoWaySearchApi {
  /**
   * Free-text search across GoWay Places and the active geocoders, blended and
   * normalized. Use this for the search box; use {@link GoWayGeocodeApi} when
   * you specifically want an address resolved.
   */
  query(query: SearchQuery, options?: GoWayRequestOptions): Promise<SearchResults>;
}

export interface GoWayGeocodeApi {
  /** Free-text address lookup: text in, coordinates out. */
  forward(query: SearchQuery, options?: GoWayRequestOptions): Promise<SearchResults>;
  /** What is at this coordinate. */
  reverse(query: ReverseGeocodeQuery, options?: GoWayRequestOptions): Promise<SearchResults>;
  /** An address lookup with the parts already separated. */
  structured(query: StructuredGeocodeQuery, options?: GoWayRequestOptions): Promise<SearchResults>;
}

export interface GoWayRoutesApi {
  /**
   * Directions between two or more points.
   *
   * "No route exists" is a normal answer for this domain, and arrives either as
   * an empty `routes` array or as `GoWayNoRouteError` — handle both, and render
   * neither as a failure of GoWay. A mode the active router does not cover here
   * rejects with `GoWayUnsupportedModeError`.
   */
  directions(routeRequest: RouteRequest, options?: GoWayRequestOptions): Promise<RouteResponse>;
}

/** Anything carrying a GoWay Place ID: a `Place`, a `SearchResult`, or `{ id }`. */
export type PlaceLinkTarget = PlaceId | { id: PlaceId } | { placeId: PlaceId };

/**
 * Canonical GoWay web URLs.
 *
 * Built from GoWay Place IDs, never from provider ids, so a link survives an
 * OSM renumbering and resolves for a GoWay-created place that matches nothing
 * external. A link is presentation: persist the place ID, rebuild the link.
 */
export interface GoWayLinks {
  /** The canonical place page: `https://goway.to/place/<placeId>`. */
  place(place: PlaceLinkTarget): string;
  /** The map, framed on a viewport: `https://goway.to/?lat=…&lng=…&zoom=…`. */
  map(viewport: MapViewport): string;
}

export interface GoWayClient {
  readonly places: GoWayPlacesApi;
  readonly search: GoWaySearchApi;
  readonly geocode: GoWayGeocodeApi;
  readonly routes: GoWayRoutesApi;
  readonly links: GoWayLinks;
}

// ── Option validation (programmer errors → TypeError, at construction) ───────

const BASE_URL = /^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i;

function baseUrl(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !BASE_URL.test(value)) {
    throw new TypeError(`${name} must be an absolute http(s) URL without a query or fragment`);
  }
  return value.replace(/\/+$/, '');
}

/** A BCP 47-shaped tag. The server decides which locales it serves. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

function isLocale(value: unknown): value is string {
  return typeof value === 'string' && LOCALE.test(value);
}

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SDK_OWNED_HEADERS = ['authorization', 'accept'];

function extraHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('headers must be an object of header names to string values');
  }
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (!HEADER_NAME.test(name) || typeof headerValue !== 'string') {
      throw new TypeError('headers must be an object of header names to string values');
    }
    if (SDK_OWNED_HEADERS.includes(name.toLowerCase())) {
      throw new TypeError(`headers may not set ${name}; the SDK owns it (pass getAccessToken for authorization)`);
    }
    result[name] = headerValue;
  }
  return Object.freeze(result);
}

// ── Input validation (→ GoWayValidationError, no request sent) ──────────────

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GoWayValidationError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function latitude(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -90 || value > 90) {
    throw new GoWayValidationError(`${what} must be a latitude in [-90, 90]`);
  }
  return value;
}

function longitude(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -180 || value > 180) {
    throw new GoWayValidationError(`${what} must be a longitude in [-180, 180]`);
  }
  return value;
}

function finiteNumberOf(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GoWayValidationError(`${what} must be a finite number`);
  }
  return value;
}

function positiveMeters(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new GoWayValidationError(`${what} must be a positive number of metres`);
  }
  return value;
}

/** The server decides the maximum; this only refuses a value that is not a count. */
function limitOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new GoWayValidationError('limit must be a positive integer');
  }
  return value as number;
}

function localeOf(override: unknown, fallback: string | undefined): string | undefined {
  if (override === undefined) return fallback;
  if (!isLocale(override)) throw new GoWayValidationError('locale must be a BCP 47 language tag');
  return override;
}

/**
 * A capability filter list.
 *
 * Each key must be `<namespace>.<capability>` — a bare `faircoin` would match
 * nothing and is far more likely a typo than an intent. The keys are NOT
 * checked against `WELL_KNOWN_CAPABILITIES`: the namespace is open by design,
 * so a third party can define its own without waiting for a GoWay release.
 */
function capabilityKeys(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new GoWayValidationError('capabilities must be an array of capability keys');
  for (const key of value as unknown[]) {
    if (typeof key !== 'string' || !/^[^.\s]+(?:\.[^.\s]+)+$/.test(key)) {
      throw new GoWayValidationError('each capability must be a dotted key such as payments.faircoin.accepted');
    }
  }
  return value as readonly string[];
}

function categoryKeys(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || (value as unknown[]).some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new GoWayValidationError('categories must be an array of non-empty strings');
  }
  return value as readonly string[];
}

function nearbyQuery(query: NearbyPlacesQuery): Record<string, QueryValue> {
  const record = requireObject(query, 'query');
  return {
    latitude: latitude(record.latitude, 'latitude'),
    longitude: longitude(record.longitude, 'longitude'),
    radiusMeters: positiveMeters(record.radiusMeters, 'radiusMeters'),
    capabilities: capabilityKeys(record.capabilities),
    categories: categoryKeys(record.categories),
    limit: limitOf(record.limit),
  };
}

function boundsQuery(query: PlacesInBoundsQuery): Record<string, QueryValue> {
  const record = requireObject(query, 'query');
  const south = latitude(record.south, 'south');
  const north = latitude(record.north, 'north');
  if (south > north) throw new GoWayValidationError('south must not be north of north');
  // `west > east` is NOT an error: that is how a box crossing the antimeridian
  // is spelled, and refusing it would make the Pacific unmappable.
  return {
    west: longitude(record.west, 'west'),
    south,
    east: longitude(record.east, 'east'),
    north,
    capabilities: capabilityKeys(record.capabilities),
    categories: categoryKeys(record.categories),
    limit: limitOf(record.limit),
  };
}

function coordinateOf(value: unknown, what: string): GeoCoordinate {
  const record = requireObject(value, what);
  return {
    latitude: latitude(record.latitude, `${what}.latitude`),
    longitude: longitude(record.longitude, `${what}.longitude`),
  };
}

function searchQuery(query: SearchQuery, defaultLocale: string | undefined): Record<string, QueryValue> {
  const record = requireObject(query, 'query');
  const text = typeof record.query === 'string' ? record.query.trim() : '';
  if (text === '') throw new GoWayValidationError('query.query must be a non-empty string');

  const near = record.near === undefined ? undefined : coordinateOf(record.near, 'near');
  let viewport: Record<string, QueryValue> = {};
  if (record.viewport !== undefined) {
    const box = requireObject(record.viewport, 'viewport');
    viewport = {
      west: longitude(box.west, 'viewport.west'),
      south: latitude(box.south, 'viewport.south'),
      east: longitude(box.east, 'viewport.east'),
      north: latitude(box.north, 'viewport.north'),
    };
  }
  return {
    q: text,
    ...(near ? { latitude: near.latitude, longitude: near.longitude } : {}),
    ...viewport,
    capabilities: capabilityKeys(record.capabilities),
    categories: categoryKeys(record.categories),
    limit: limitOf(record.limit),
    locale: localeOf(record.locale, defaultLocale),
  };
}

function reverseQuery(query: ReverseGeocodeQuery, defaultLocale: string | undefined): Record<string, QueryValue> {
  const record = requireObject(query, 'query');
  return {
    latitude: latitude(record.latitude, 'latitude'),
    longitude: longitude(record.longitude, 'longitude'),
    radiusMeters: record.radiusMeters === undefined ? undefined : positiveMeters(record.radiusMeters, 'radiusMeters'),
    limit: limitOf(record.limit),
    locale: localeOf(record.locale, defaultLocale),
  };
}

const STRUCTURED_FIELDS = ['street', 'houseNumber', 'city', 'region', 'postalCode', 'countryCode'] as const;

function structuredQuery(
  query: StructuredGeocodeQuery,
  defaultLocale: string | undefined,
): Record<string, QueryValue> {
  const record = requireObject(query, 'query');
  const parts: Record<string, QueryValue> = {};
  for (const field of STRUCTURED_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new GoWayValidationError(`${field} must be a non-empty string`);
    }
    parts[field] = value.trim();
  }
  if (Object.keys(parts).length === 0) {
    throw new GoWayValidationError(`a structured lookup needs at least one of ${STRUCTURED_FIELDS.join(', ')}`);
  }
  return { ...parts, limit: limitOf(record.limit), locale: localeOf(record.locale, defaultLocale) };
}

/** One end of a route. Exactly one of `coordinate`/`placeId` must be usable. */
function routeLocation(value: unknown, what: string): RouteLocation {
  const record = requireObject(value, what);
  const hasCoordinate = record.coordinate !== undefined;
  const hasPlaceId = record.placeId !== undefined;
  if (!hasCoordinate && !hasPlaceId) {
    throw new GoWayValidationError(`${what} must carry a coordinate or a placeId`);
  }
  const location: RouteLocation = {};
  if (hasCoordinate) location.coordinate = coordinateOf(record.coordinate, `${what}.coordinate`);
  if (hasPlaceId) {
    if (typeof record.placeId !== 'string' || record.placeId.trim() === '') {
      throw new GoWayValidationError(`${what}.placeId must be a non-empty GoWay Place ID`);
    }
    location.placeId = record.placeId;
  }
  if (record.name !== undefined) {
    if (typeof record.name !== 'string') throw new GoWayValidationError(`${what}.name must be a string`);
    location.name = record.name;
  }
  return location;
}

function routeBody(routeRequest: RouteRequest, defaultLocale: string | undefined): RouteRequest {
  const record = requireObject(routeRequest, 'routeRequest');
  if (!(TRAVEL_MODES as readonly string[]).includes(record.mode as string)) {
    throw new GoWayValidationError(`mode must be one of ${TRAVEL_MODES.join(', ')}`);
  }
  const body: RouteRequest = {
    origin: routeLocation(record.origin, 'origin'),
    destination: routeLocation(record.destination, 'destination'),
    mode: record.mode as RouteRequest['mode'],
  };
  if (record.waypoints !== undefined) {
    if (!Array.isArray(record.waypoints)) throw new GoWayValidationError('waypoints must be an array');
    body.waypoints = (record.waypoints as unknown[]).map((waypoint, index) =>
      routeLocation(waypoint, `waypoints[${index}]`),
    );
  }
  if (record.alternatives !== undefined) {
    if (typeof record.alternatives !== 'boolean') {
      throw new GoWayValidationError('alternatives must be a boolean');
    }
    body.alternatives = record.alternatives;
  }
  const locale = localeOf(record.locale, defaultLocale);
  if (locale !== undefined) body.locale = locale;
  return body;
}

/**
 * The body of a place write, assembled field by field.
 *
 * The caller's object is never forwarded: a request built by spreading it would
 * let a consumer post `verification: 'oxy_verified'`, an `id`, or whatever else
 * a future server happens to read. Every write here carries exactly the fields
 * this SDK version knows a client may set.
 */
function placeWriteBody(input: PlaceCreateInput | PlaceUpdateInput, requireName: boolean): Record<string, unknown> {
  const record = requireObject(input, 'input');
  const body: Record<string, unknown> = {};

  if (record.name !== undefined) {
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new GoWayValidationError('name must be a non-empty string');
    }
    body.name = record.name;
  } else if (requireName) {
    throw new GoWayValidationError('name is required to create a place');
  }

  if (record.location !== undefined) body.location = coordinateOf(record.location, 'location');
  else if (requireName) throw new GoWayValidationError('location is required to create a place');

  if (record.geometry !== undefined) body.geometry = requireObject(record.geometry, 'geometry');
  if (record.categories !== undefined) body.categories = categoryKeys(record.categories);
  if (record.address !== undefined) body.address = requireObject(record.address, 'address');
  if (record.contact !== undefined) body.contact = requireObject(record.contact, 'contact');
  if (record.openingHours !== undefined) body.openingHours = requireObject(record.openingHours, 'openingHours');
  if (record.status !== undefined) {
    if (typeof record.status !== 'string') throw new GoWayValidationError('status must be a place status');
    body.status = record.status;
  }
  if (record.sources !== undefined) {
    if (!Array.isArray(record.sources)) throw new GoWayValidationError('sources must be an array');
    body.sources = (record.sources as unknown[]).map((source, index) => {
      const entry = requireObject(source, `sources[${index}]`);
      if (typeof entry.source !== 'string' || typeof entry.sourceId !== 'string') {
        throw new GoWayValidationError(`sources[${index}] must carry source and sourceId`);
      }
      return { source: entry.source, sourceId: entry.sourceId };
    });
  }
  if (record.capabilities !== undefined) {
    if (!Array.isArray(record.capabilities)) throw new GoWayValidationError('capabilities must be an array');
    body.capabilities = (record.capabilities as unknown[]).map((capability, index) => {
      const entry = requireObject(capability, `capabilities[${index}]`);
      const namespace = entry.namespace;
      const name = entry.capability;
      if (typeof namespace !== 'string' || namespace.trim() === '') {
        throw new GoWayValidationError(`capabilities[${index}].namespace must be a non-empty string`);
      }
      if (typeof name !== 'string' || name.trim() === '') {
        throw new GoWayValidationError(`capabilities[${index}].capability must be a non-empty string`);
      }
      const value = entry.value;
      if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
        throw new GoWayValidationError(`capabilities[${index}].value must be a boolean, string or number`);
      }
      // `verification` and `observedAt` are NOT sent even if the caller set
      // them: the server derives both, which is what stops a community report
      // arriving labelled as verified.
      const written: Record<string, unknown> = { namespace, capability: name, value };
      if (entry.source !== undefined) written.source = requireObject(entry.source, `capabilities[${index}].source`);
      return written;
    });
  }
  if (Object.keys(body).length === 0) throw new GoWayValidationError('an update must change at least one field');
  return body;
}

// ── Links ───────────────────────────────────────────────────────────────────

function placeIdOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const record = value as { id?: unknown; placeId?: unknown };
    const candidate = typeof record.placeId === 'string' ? record.placeId : record.id;
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  throw new GoWayValidationError('expected a GoWay Place ID, a Place, or an object carrying a placeId');
}

function createLinks(webBaseUrl: string): GoWayLinks {
  return Object.freeze({
    place: (place: PlaceLinkTarget) => {
      const id = placeIdOf(place);
      if (id.trim() === '') throw new GoWayValidationError('a place id must be a non-empty string');
      return `${webBaseUrl}/place/${encodeURIComponent(id)}`;
    },
    map: (viewport: MapViewport) => {
      const record = requireObject(viewport, 'viewport');
      const query: Record<string, QueryValue> = {
        lat: latitude(record.latitude, 'latitude'),
        lng: longitude(record.longitude, 'longitude'),
        zoom: finiteNumberOf(record.zoom, 'zoom'),
      };
      if (record.bearing !== undefined) query.bearing = finiteNumberOf(record.bearing, 'bearing');
      if (record.pitch !== undefined) query.pitch = finiteNumberOf(record.pitch, 'pitch');
      const serialized = Object.keys(query)
        .sort()
        .map((key) => `${key}=${encodeURIComponent(String(query[key]))}`)
        .join('&');
      return `${webBaseUrl}/?${serialized}`;
    },
  });
}

// ── The client ──────────────────────────────────────────────────────────────

/**
 * Create a GoWay client. Every option is optional; with none, the client reads
 * anonymously from the production API — which is the supported way to render a
 * map, search and route without an Oxy account.
 */
export function createGoWayClient(options: GoWayClientOptions = {}): GoWayClient {
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new TypeError('fetch must be a function');
  }
  if (options.getAccessToken !== undefined && typeof options.getAccessToken !== 'function') {
    throw new TypeError('getAccessToken must be a function');
  }
  if (options.locale !== undefined && !isLocale(options.locale)) {
    throw new TypeError('locale must be a BCP 47 language tag');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GOWAY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('timeoutMs must be a positive integer number of milliseconds');
  }

  const config: TransportConfig = Object.freeze({
    apiBaseUrl: baseUrl(options.apiBaseUrl, 'apiBaseUrl', DEFAULT_GOWAY_API_BASE_URL),
    fetch: options.fetch,
    getAccessToken: options.getAccessToken,
    timeoutMs,
    headers: extraHeaders(options.headers),
  });
  const webBaseUrl = baseUrl(options.webBaseUrl, 'webBaseUrl', DEFAULT_GOWAY_WEB_BASE_URL);
  const defaultLocale = options.locale;

  const places: GoWayPlacesApi = Object.freeze({
    get: async (placeId: PlaceId, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'GET', path: `/places/${pathSegment(placeId, 'placeId')}`, signal: callOptions.signal },
        parsePlace,
      ),

    nearby: async (query: NearbyPlacesQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'GET', path: '/places/nearby', query: nearbyQuery(query), signal: callOptions.signal },
        parsePlaceWithDistanceList,
      ),

    inBounds: async (query: PlacesInBoundsQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'GET', path: '/places/bounds', query: boundsQuery(query), signal: callOptions.signal },
        parsePlaceList,
      ),

    create: async (input: PlaceCreateInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'POST', path: '/places', body: placeWriteBody(input, true), signal: callOptions.signal },
        parsePlace,
      ),

    update: async (placeId: PlaceId, input: PlaceUpdateInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'PATCH',
          path: `/places/${pathSegment(placeId, 'placeId')}`,
          body: placeWriteBody(input, false),
          signal: callOptions.signal,
        },
        parsePlace,
      ),
  });

  const search: GoWaySearchApi = Object.freeze({
    query: async (query: SearchQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'GET', path: '/search', query: searchQuery(query, defaultLocale), signal: callOptions.signal },
        parseSearchResults,
      ),
  });

  const geocode: GoWayGeocodeApi = Object.freeze({
    forward: async (query: SearchQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'GET', path: '/geocode', query: searchQuery(query, defaultLocale), signal: callOptions.signal },
        parseSearchResults,
      ),

    reverse: async (query: ReverseGeocodeQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/geocode/reverse',
          query: reverseQuery(query, defaultLocale),
          signal: callOptions.signal,
        },
        parseSearchResults,
      ),

    structured: async (query: StructuredGeocodeQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/geocode/structured',
          query: structuredQuery(query, defaultLocale),
          signal: callOptions.signal,
        },
        parseSearchResults,
      ),
  });

  const routes: GoWayRoutesApi = Object.freeze({
    directions: async (routeRequest: RouteRequest, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: '/routes',
          body: routeBody(routeRequest, defaultLocale),
          signal: callOptions.signal,
        },
        parseRouteResponse,
      ),
  });

  return Object.freeze({ places, search, geocode, routes, links: createLinks(webBaseUrl) });
}
