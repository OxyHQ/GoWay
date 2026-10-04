import {
  accountClaimListQuerySchema,
  assetPathSchema,
  capabilityPathSchema,
  claimDecisionInputSchema,
  claimPathSchema,
  duplicateCandidatePageSchema,
  duplicateCandidateSchema,
  duplicateListQuerySchema,
  duplicatePathSchema,
  duplicateResolutionInputSchema,
  moderationCapabilityInputSchema,
  moderationClaimListQuerySchema,
  moderationPlaceReportPageSchema,
  moderationPlaceReportSchema,
  moderationPlaceRevisionPageSchema,
  moderationPlaceUpdateInputSchema,
  moderationReportListQuerySchema,
  placeReportInputSchema,
  placeReportResolutionInputSchema,
  placeReportSchema,
  placeRevisionPageSchema,
  reportPathSchema,
  revisionListQuerySchema,
  captureAssetInputSchema,
  captureAssetPageSchema,
  captureAssetSchema,
  captureListQuerySchema,
  captureSessionInputSchema,
  captureSessionPageSchema,
  captureSessionSchema,
  captureUploadPolicySchema,
  captureUploadTicketSchema,
  claimListQuerySchema,
  geoCoordinateSchema,
  nearbyPlacesQuerySchema,
  normalizeLanguageTag,
  placeCapabilityAssertionSchema,
  placeClaimInputSchema,
  placeClaimPageSchema,
  placeClaimSchema,
  placeCreateInputSchema,
  placePageSchema,
  placePathSchema,
  placeReadQuerySchema,
  placeSchema,
  placesInBoundsQuerySchema,
  placeUpdateInputSchema,
  placeWithDistancePageSchema,
  reverseGeocodeQuerySchema,
  routeRequestSchema,
  routeResponseSchema,
  scenePathSchema,
  searchParametersOf,
  searchParametersSchema,
  searchResultsSchema,
  sessionPathSchema,
  streetCoverageQuerySchema,
  streetCoverageSchema,
  streetSceneManifestSchema,
  streetSceneReportInputSchema,
  streetSceneReportSchema,
  structuredGeocodeQuerySchema,
  TRAVEL_MODES,
} from './contract';
import type {
  AccountClaimListQuery,
  CapabilityKey,
  ClaimDecisionInput,
  DuplicateCandidate,
  DuplicateCandidatePage,
  DuplicateListQuery,
  DuplicateResolutionInput,
  ModerationCapabilityInput,
  ModerationClaimListQuery,
  ModerationPlaceReport,
  ModerationPlaceReportPage,
  ModerationPlaceRevisionPage,
  ModerationPlaceUpdateInput,
  ModerationReportListQuery,
  PlaceReport,
  PlaceReportInput,
  PlaceReportResolutionInput,
  PlaceRevisionPage,
  RevisionListQuery,
  CaptureAsset,
  CaptureAssetInput,
  CaptureAssetPage,
  CaptureListQuery,
  CaptureSession,
  CaptureSessionInput,
  CaptureSessionPage,
  CaptureUploadPolicy,
  CaptureUploadTicket,
  ClaimListQuery,
  MapViewport,
  NearbyPlacesQuery,
  Place,
  PlaceCapabilityAssertion,
  PlaceClaim,
  PlaceClaimInput,
  PlaceClaimPage,
  PlaceCreateInput,
  PlaceId,
  PlacePage,
  PlacesInBoundsQuery,
  PlaceUpdateInput,
  PlaceWithDistancePage,
  ReverseGeocodeQuery,
  RouteRequest,
  RouteResponse,
  SearchQuery,
  SearchResults,
  StreetCoverage,
  StreetCoverageQuery,
  StreetSceneManifest,
  StreetSceneReport,
  StreetSceneReportInput,
  StructuredGeocodeQuery,
} from './contract';
import { GoWayValidationError } from './errors';
import type { GoWayAbortSignal, GoWayFetch } from './runtime';
import {
  pathSegment,
  request,
  type GoWayAccessTokenGetter,
  type QueryValue,
  type TransportConfig,
} from './transport';
import { validInput } from './validate';

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
   * asserting a capability, claiming, contributing — need a token.
   */
  getAccessToken?: GoWayAccessTokenGetter;
  /**
   * The default locale (a BCP 47 tag such as `es` or `pt-BR`) for localized
   * names and maneuver instructions, applied to every call that accepts one and
   * names none. Normalized once (`ES` → `es`), so equivalent spellings are one
   * cache key.
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

/** {@link GoWayRequestOptions} plus the locale a single-place read resolves against. */
export interface GoWayPlaceReadOptions extends GoWayRequestOptions {
  /**
   * BCP 47 tag for {@link Place.localizedName}, overriding the client's own
   * `locale` for this call. It never changes {@link Place.name}, which is
   * always the place's default, local-language name.
   */
  locale?: string;
}

/**
 * One capability of one place, written by the business or a contributor.
 *
 * The verification tier is never the caller's to name: the server derives it
 * from who is asking (an approved claim earns `business_asserted`) and whether a
 * `source` is cited.
 */
export interface GoWayPlaceCapabilitiesApi {
  /**
   * Assert or refresh `key` on a place, and get the place back. `value` is
   * required — a community reporter retracts with `false`, which is better
   * evidence than a deletion. Identity-bound.
   */
  put(placeId: PlaceId, key: CapabilityKey, assertion: PlaceCapabilityAssertion, options?: GoWayRequestOptions): Promise<Place>;
  /** Withdraw the business's own assertion of `key`. Resolves with nothing (`204`). Identity-bound. */
  delete(placeId: PlaceId, key: CapabilityKey, options?: GoWayRequestOptions): Promise<void>;
}

/** Claims on one place: the request to be recognised as running it. */
export interface GoWayPlaceClaimsApi {
  /**
   * Ask to be recognised as running this place. Always created `pending`.
   * Identity-bound. Pass `oxyAccountId` to claim for an Oxy organization you
   * own or administer — the usual case: the business IS the organization.
   * Omitted, the claim is for the signed-in account.
   */
  create(placeId: PlaceId, input: PlaceClaimInput, options?: GoWayRequestOptions): Promise<PlaceClaim>;
  /** The claims on this place, visible to whoever may act for an account that holds one. Oldest first. */
  list(placeId: PlaceId, query?: ClaimListQuery, options?: GoWayRequestOptions): Promise<PlaceClaimPage>;
}

export interface GoWayPlacesApi {
  /**
   * One place by its stable GoWay Place ID. Never a provider id: an OSM node
   * can be renumbered without GoWay losing the place's identity.
   *
   * A single-place read always carries `names` — every language GoWay holds
   * one in. The list reads below do not; they carry `localizedName` alone, for
   * the locale that was asked for. A place GoWay withdrew rejects with
   * `GoWayGoneError`, not `GoWayNotFoundError`.
   */
  get(placeId: PlaceId, options?: GoWayPlaceReadOptions): Promise<Place>;
  /**
   * One page of places within `radiusMeters` of a point, nearest first, each
   * carrying its distance.
   *
   * `capabilities` is the generic filter every Oxy product shares — pass
   * `['payments.faircoin.accepted']` for FairCoin merchants, or
   * `['mobility.moovo.pickup']` for Moovo pickup points. A place must HAVE
   * every listed capability: its strongest assertion of each key holds.
   * Nothing about the capability table's layout leaks into this call.
   */
  nearby(query: NearbyPlacesQuery, options?: GoWayRequestOptions): Promise<PlaceWithDistancePage>;
  /** One page of places inside a bounding box — the map-viewport read. */
  inBounds(query: PlacesInBoundsQuery, options?: GoWayRequestOptions): Promise<PlacePage>;
  /** Create a GoWay-owned place. Identity-bound: requires an Oxy access token. */
  create(input: PlaceCreateInput, options?: GoWayRequestOptions): Promise<Place>;
  /** Update a place the caller is entitled to edit. Only the fields present are touched. Identity-bound. */
  update(placeId: PlaceId, input: PlaceUpdateInput, options?: GoWayRequestOptions): Promise<Place>;
  /**
   * One page of a place's public history, newest first: what changed and when.
   * Never who — no account and no person is published — and never a claim, a
   * report or a duplicate review. Needs no account.
   */
  revisions(placeId: PlaceId, query?: RevisionListQuery, options?: GoWayRequestOptions): Promise<PlaceRevisionPage>;
  /**
   * Report a place to moderation. Identity-bound. Repeating it while your
   * report is open resolves with that same report.
   */
  report(placeId: PlaceId, input: PlaceReportInput, options?: GoWayRequestOptions): Promise<PlaceReport>;
  readonly capabilities: GoWayPlaceCapabilitiesApi;
  readonly claims: GoWayPlaceClaimsApi;
}

/** One account's claims, across every place. */
export interface GoWayClaimsApi {
  /**
   * Every claim one account holds, in every state, oldest first —
   * identity-bound. The signed-in account's own by default; pass
   * `oxyAccountId` for an Oxy organization you act for (owner, admin or editor
   * in it), which is how a business dashboard lists its locations.
   */
  list(query?: AccountClaimListQuery, options?: GoWayRequestOptions): Promise<PlaceClaimPage>;
}

/**
 * GoWay's moderation surface, for GoWay operators only.
 *
 * Every call needs an Oxy session whose person is on the deployment's operator
 * allow-list; anybody else gets `GoWayForbiddenError`. It is in this SDK so
 * GoWay's own tools are built on the same contract as everything else — no
 * integration needs it, and none should call it.
 */
export interface GoWayModerationApi {
  /** Claims in one state, oldest first — `pending` by default: the review queue. */
  claims(query?: ModerationClaimListQuery, options?: GoWayRequestOptions): Promise<PlaceClaimPage>;
  /** Approve or reject a pending claim, or revoke an approved one. */
  decideClaim(claimId: string, input: ClaimDecisionInput, options?: GoWayRequestOptions): Promise<PlaceClaim>;
  /** Set a place's verification state, or remove or restore it. Resolves with nothing (`204`). */
  updatePlace(placeId: PlaceId, input: ModerationPlaceUpdateInput, options?: GoWayRequestOptions): Promise<void>;
  /** Assert one capability at the `oxy_verified` tier, and get the place back. */
  verifyCapability(
    placeId: PlaceId,
    key: CapabilityKey,
    input: ModerationCapabilityInput,
    options?: GoWayRequestOptions,
  ): Promise<Place>;
  /** Withdraw the `oxy_verified` assertion of one capability. Resolves with nothing (`204`). */
  withdrawVerifiedCapability(placeId: PlaceId, key: CapabilityKey, options?: GoWayRequestOptions): Promise<void>;
  /** A place's full history, newest first, with the account and person behind each revision. */
  revisions(placeId: PlaceId, query?: RevisionListQuery, options?: GoWayRequestOptions): Promise<ModerationPlaceRevisionPage>;
  /** Pairs of places that might be one, oldest first — `open` by default. */
  duplicates(query?: DuplicateListQuery, options?: GoWayRequestOptions): Promise<DuplicateCandidatePage>;
  /** Merge a pair into its survivor, or keep both. */
  resolveDuplicate(candidateId: string, input: DuplicateResolutionInput, options?: GoWayRequestOptions): Promise<DuplicateCandidate>;
  /** Place reports, oldest first — `open` by default. */
  reports(query?: ModerationReportListQuery, options?: GoWayRequestOptions): Promise<ModerationPlaceReportPage>;
  /** Close a report as actioned or dismissed. */
  resolveReport(reportId: string, input: PlaceReportResolutionInput, options?: GoWayRequestOptions): Promise<ModerationPlaceReport>;
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

/**
 * Street 3D: published scenes and coarse contribution coverage.
 *
 * `coverage` and `scene` need no account. `report` needs an Oxy session (pass
 * `getAccessToken`). A deployment with Street 3D switched off answers
 * `coverage` with `GoWayUnavailableError` and `scene` with
 * `GoWayNotFoundError`. Nothing here exposes how scenes are built: no job,
 * worker, capture or storage shape is part of this API.
 */
export interface GoWayStreet3dApi {
  /** Published scenes and coverage areas in a box. The server caps the box size. */
  coverage(query: StreetCoverageQuery, options?: GoWayRequestOptions): Promise<StreetCoverage>;
  /** The served manifest of one published scene. */
  scene(id: string, options?: GoWayRequestOptions): Promise<StreetSceneManifest>;
  /** Report a scene to moderation. Repeating a report returns the existing one. */
  report(id: string, input: StreetSceneReportInput, options?: GoWayRequestOptions): Promise<StreetSceneReport>;
}

/**
 * Street 3D contributions. `policy` is public; everything else is the signed-in
 * contributor's own sessions and assets.
 */
export interface GoWayCapturesApi {
  /** One page of the contributor's sessions, newest first. */
  sessions(query?: CaptureListQuery, options?: GoWayRequestOptions): Promise<CaptureSessionPage>;
  policy(options?: GoWayRequestOptions): Promise<CaptureUploadPolicy>;
  createSession(input: CaptureSessionInput, options?: GoWayRequestOptions): Promise<CaptureSession>;
  session(sessionId: string, options?: GoWayRequestOptions): Promise<CaptureSession>;
  /** One page of a session's contributions, oldest first. */
  assets(sessionId: string, query?: CaptureListQuery, options?: GoWayRequestOptions): Promise<CaptureAssetPage>;
  register(sessionId: string, input: CaptureAssetInput, options?: GoWayRequestOptions): Promise<CaptureUploadTicket>;
  asset(assetId: string, options?: GoWayRequestOptions): Promise<CaptureAsset>;
  finalize(assetId: string, options?: GoWayRequestOptions): Promise<CaptureAsset>;
  /** Withdraw a contribution: its media is deleted and it never feeds a scene. Resolves with nothing (`204`). */
  remove(assetId: string, options?: GoWayRequestOptions): Promise<void>;
}

export interface GoWayClient {
  readonly places: GoWayPlacesApi;
  readonly claims: GoWayClaimsApi;
  readonly moderation: GoWayModerationApi;
  readonly search: GoWaySearchApi;
  readonly geocode: GoWayGeocodeApi;
  readonly routes: GoWayRoutesApi;
  readonly captures: GoWayCapturesApi;
  readonly street3d: GoWayStreet3dApi;
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

function defaultLocaleOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string' ? normalizeLanguageTag(value) : undefined;
  if (normalized === undefined) throw new TypeError('locale must be a BCP 47 language tag');
  return normalized;
}

// ── Request assembly ────────────────────────────────────────────────────────
//
// Every input below goes through its CONTRACT schema (`validInput`) — path
// parameters included — and the parsed value is what is sent. What remains
// hand-written is what the contract has no schema for: refusing a `.`/`..`
// segment (`pathSegment`), and the `links` viewport, which is a web URL rather
// than an API request.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `value` with the client's default locale filled in, when it names none.
 *
 * Anything that is not an object is passed through untouched for its schema to
 * refuse, so a `null` query is a `GoWayValidationError` rather than a
 * `TypeError` from a spread.
 */
function withLocale<T>(value: T, locale: string | undefined): T {
  if (locale === undefined || !isRecord(value) || value.locale !== undefined) return value;
  return { ...value, locale };
}

function placePath(placeId: PlaceId): string {
  const path = validInput(placePathSchema, { placeId }, 'path');
  return `/places/${pathSegment(path.placeId, 'placeId')}`;
}

function capabilityPath(placeId: PlaceId, key: CapabilityKey): string {
  const path = validInput(capabilityPathSchema, { placeId, key }, 'path');
  return `/places/${pathSegment(path.placeId, 'placeId')}/capabilities/${pathSegment(path.key, 'key')}`;
}

function claimPath(claimId: string): string {
  const path = validInput(claimPathSchema, { claimId }, 'path');
  return `/moderation/claims/${pathSegment(path.claimId, 'claimId')}`;
}

function duplicatePath(candidateId: string): string {
  const path = validInput(duplicatePathSchema, { candidateId }, 'path');
  return `/moderation/duplicates/${pathSegment(path.candidateId, 'candidateId')}`;
}

function reportPath(reportId: string): string {
  const path = validInput(reportPathSchema, { reportId }, 'path');
  return `/moderation/reports/${pathSegment(path.reportId, 'reportId')}`;
}

function sessionPath(sessionId: string): string {
  const path = validInput(sessionPathSchema, { sessionId }, 'path');
  return `/captures/sessions/${pathSegment(path.sessionId, 'sessionId')}`;
}

function assetPath(assetId: string): string {
  const path = validInput(assetPathSchema, { assetId }, 'path');
  return `/captures/assets/${pathSegment(path.assetId, 'assetId')}`;
}

function scenePath(sceneId: string): string {
  const path = validInput(scenePathSchema, { sceneId }, 'path');
  return `/street3d/scenes/${pathSegment(path.sceneId, 'sceneId')}`;
}

/** The flat wire parameters of a free-text search, validated. */
function searchParameters(query: SearchQuery, locale: string | undefined) {
  const flattened: unknown = isRecord(query) ? searchParametersOf(withLocale(query, locale)) : query;
  return validInput(searchParametersSchema, flattened, 'query');
}

/**
 * A directions body. The contract types `mode` as a bounded string so the
 * SERVER can answer `unsupported_mode` for a mode it has not learned; this SDK
 * knows exactly which modes it was built for, and a mode outside them is a
 * caller's typo rather than a coverage question.
 */
function routeBody(routeRequest: RouteRequest, locale: string | undefined) {
  const body = validInput(routeRequestSchema, withLocale(routeRequest, locale), 'routeRequest');
  if (!(TRAVEL_MODES as readonly string[]).includes(body.mode)) {
    throw new GoWayValidationError(`routeRequest.mode: must be one of ${TRAVEL_MODES.join(', ')}`);
  }
  return body;
}

// ── Links ───────────────────────────────────────────────────────────────────

function placeIdOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    const candidate = typeof value.placeId === 'string' ? value.placeId : value.id;
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  throw new GoWayValidationError('expected a GoWay Place ID, a Place, or an object carrying a placeId');
}

function finiteNumberOf(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GoWayValidationError(`${what} must be a finite number`);
  }
  return value;
}

function createLinks(webBaseUrl: string): GoWayLinks {
  return Object.freeze({
    place: (place: PlaceLinkTarget) => {
      const id = placeIdOf(place);
      if (id.trim() === '') throw new GoWayValidationError('a place id must be a non-empty string');
      return `${webBaseUrl}/place/${encodeURIComponent(id)}`;
    },
    map: (viewport: MapViewport) => {
      const record: Record<string, unknown> = isRecord(viewport) ? viewport : {};
      const center = validInput(
        geoCoordinateSchema,
        { latitude: record.latitude, longitude: record.longitude },
        'viewport',
      );
      const query: Record<string, QueryValue> = {
        lat: center.latitude,
        lng: center.longitude,
        zoom: finiteNumberOf(record.zoom, 'viewport.zoom'),
      };
      if (record.bearing !== undefined) query.bearing = finiteNumberOf(record.bearing, 'viewport.bearing');
      if (record.pitch !== undefined) query.pitch = finiteNumberOf(record.pitch, 'viewport.pitch');
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
 *
 * Every method validates its input against the contract BEFORE anything is
 * sent (`GoWayValidationError`, `status: null`), and parses every answer
 * against it (`GoWayResponseError` when the server drifted).
 */
export function createGoWayClient(options: GoWayClientOptions = {}): GoWayClient {
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new TypeError('fetch must be a function');
  }
  if (options.getAccessToken !== undefined && typeof options.getAccessToken !== 'function') {
    throw new TypeError('getAccessToken must be a function');
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
  const locale = defaultLocaleOf(options.locale);

  const places: GoWayPlacesApi = Object.freeze({
    get: async (placeId: PlaceId, callOptions: GoWayPlaceReadOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: placePath(placeId),
          query: validInput(placeReadQuerySchema, { locale: callOptions.locale ?? locale }, 'options'),
          signal: callOptions.signal,
        },
        placeSchema,
      ),

    nearby: async (query: NearbyPlacesQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/places/nearby',
          query: validInput(nearbyPlacesQuerySchema, withLocale(query, locale), 'query'),
          signal: callOptions.signal,
        },
        placeWithDistancePageSchema,
      ),

    inBounds: async (query: PlacesInBoundsQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/places/bounds',
          query: validInput(placesInBoundsQuerySchema, withLocale(query, locale), 'query'),
          signal: callOptions.signal,
        },
        placePageSchema,
      ),

    create: async (input: PlaceCreateInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: '/places',
          body: validInput(placeCreateInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        placeSchema,
      ),

    update: async (placeId: PlaceId, input: PlaceUpdateInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'PATCH',
          path: placePath(placeId),
          body: validInput(placeUpdateInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        placeSchema,
      ),

    revisions: async (placeId: PlaceId, query: RevisionListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: `${placePath(placeId)}/revisions`,
          query: validInput(revisionListQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        placeRevisionPageSchema,
      ),

    report: async (placeId: PlaceId, input: PlaceReportInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: `${placePath(placeId)}/reports`,
          body: validInput(placeReportInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        placeReportSchema,
      ),

    capabilities: Object.freeze({
      put: async (
        placeId: PlaceId,
        key: CapabilityKey,
        assertion: PlaceCapabilityAssertion,
        callOptions: GoWayRequestOptions = {},
      ) =>
        request(
          config,
          {
            method: 'PUT',
            path: capabilityPath(placeId, key),
            body: validInput(placeCapabilityAssertionSchema, assertion, 'assertion'),
            signal: callOptions.signal,
          },
          placeSchema,
        ),

      delete: async (placeId: PlaceId, key: CapabilityKey, callOptions: GoWayRequestOptions = {}) =>
        request(
          config,
          { method: 'DELETE', path: capabilityPath(placeId, key), signal: callOptions.signal },
          null,
        ),
    }),

    claims: Object.freeze({
      create: async (placeId: PlaceId, input: PlaceClaimInput, callOptions: GoWayRequestOptions = {}) =>
        request(
          config,
          {
            method: 'POST',
            path: `${placePath(placeId)}/claims`,
            body: validInput(placeClaimInputSchema, input, 'input'),
            signal: callOptions.signal,
          },
          placeClaimSchema,
        ),

      list: async (placeId: PlaceId, query: ClaimListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
        request(
          config,
          {
            method: 'GET',
            path: `${placePath(placeId)}/claims`,
            query: validInput(claimListQuerySchema, query, 'query'),
            signal: callOptions.signal,
          },
          placeClaimPageSchema,
        ),
    }),
  });

  const claims: GoWayClaimsApi = Object.freeze({
    list: async (query: AccountClaimListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/claims',
          query: validInput(accountClaimListQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        placeClaimPageSchema,
      ),
  });

  const moderation: GoWayModerationApi = Object.freeze({
    claims: async (query: ModerationClaimListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/moderation/claims',
          query: validInput(moderationClaimListQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        placeClaimPageSchema,
      ),

    decideClaim: async (claimId: string, input: ClaimDecisionInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: `${claimPath(claimId)}/decision`,
          body: validInput(claimDecisionInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        placeClaimSchema,
      ),

    updatePlace: async (placeId: PlaceId, input: ModerationPlaceUpdateInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'PATCH',
          path: `/moderation${placePath(placeId)}`,
          body: validInput(moderationPlaceUpdateInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        null,
      ),

    verifyCapability: async (
      placeId: PlaceId,
      key: CapabilityKey,
      input: ModerationCapabilityInput,
      callOptions: GoWayRequestOptions = {},
    ) =>
      request(
        config,
        {
          method: 'PUT',
          path: `/moderation${capabilityPath(placeId, key)}`,
          body: validInput(moderationCapabilityInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        placeSchema,
      ),

    withdrawVerifiedCapability: async (placeId: PlaceId, key: CapabilityKey, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'DELETE', path: `/moderation${capabilityPath(placeId, key)}`, signal: callOptions.signal },
        null,
      ),

    revisions: async (placeId: PlaceId, query: RevisionListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: `/moderation${placePath(placeId)}/revisions`,
          query: validInput(revisionListQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        moderationPlaceRevisionPageSchema,
      ),

    duplicates: async (query: DuplicateListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/moderation/duplicates',
          query: validInput(duplicateListQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        duplicateCandidatePageSchema,
      ),

    resolveDuplicate: async (candidateId: string, input: DuplicateResolutionInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: `${duplicatePath(candidateId)}/resolution`,
          body: validInput(duplicateResolutionInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        duplicateCandidateSchema,
      ),

    reports: async (query: ModerationReportListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/moderation/reports',
          query: validInput(moderationReportListQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        moderationPlaceReportPageSchema,
      ),

    resolveReport: async (reportId: string, input: PlaceReportResolutionInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: `${reportPath(reportId)}/resolution`,
          body: validInput(placeReportResolutionInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        moderationPlaceReportSchema,
      ),
  });

  const search: GoWaySearchApi = Object.freeze({
    query: async (query: SearchQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'GET', path: '/search', query: searchParameters(query, locale), signal: callOptions.signal },
        searchResultsSchema,
      ),
  });

  const geocode: GoWayGeocodeApi = Object.freeze({
    forward: async (query: SearchQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'GET', path: '/geocode', query: searchParameters(query, locale), signal: callOptions.signal },
        searchResultsSchema,
      ),

    reverse: async (query: ReverseGeocodeQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/geocode/reverse',
          query: validInput(reverseGeocodeQuerySchema, withLocale(query, locale), 'query'),
          signal: callOptions.signal,
        },
        searchResultsSchema,
      ),

    structured: async (query: StructuredGeocodeQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/geocode/structured',
          query: validInput(structuredGeocodeQuerySchema, withLocale(query, locale), 'query'),
          signal: callOptions.signal,
        },
        searchResultsSchema,
      ),
  });

  const routes: GoWayRoutesApi = Object.freeze({
    directions: async (routeRequest: RouteRequest, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'POST', path: '/routes', body: routeBody(routeRequest, locale), signal: callOptions.signal },
        routeResponseSchema,
      ),
  });

  const captures: GoWayCapturesApi = Object.freeze({
    sessions: async (query: CaptureListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/captures/sessions',
          query: validInput(captureListQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        captureSessionPageSchema,
      ),

    policy: async (callOptions: GoWayRequestOptions = {}) =>
      request(config, { method: 'GET', path: '/captures/policy', signal: callOptions.signal }, captureUploadPolicySchema),

    createSession: async (input: CaptureSessionInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: '/captures/sessions',
          body: validInput(captureSessionInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        captureSessionSchema,
      ),

    session: async (sessionId: string, callOptions: GoWayRequestOptions = {}) =>
      request(config, { method: 'GET', path: sessionPath(sessionId), signal: callOptions.signal }, captureSessionSchema),

    assets: async (sessionId: string, query: CaptureListQuery = {}, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: `${sessionPath(sessionId)}/assets`,
          query: validInput(captureListQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        captureAssetPageSchema,
      ),

    register: async (sessionId: string, input: CaptureAssetInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: `${sessionPath(sessionId)}/assets`,
          body: validInput(captureAssetInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        captureUploadTicketSchema,
      ),

    asset: async (assetId: string, callOptions: GoWayRequestOptions = {}) =>
      request(config, { method: 'GET', path: assetPath(assetId), signal: callOptions.signal }, captureAssetSchema),

    // The finalize body is empty by contract: the object store, not the
    // client, is the authority on what was uploaded.
    finalize: async (assetId: string, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        { method: 'POST', path: `${assetPath(assetId)}/finalize`, body: {}, signal: callOptions.signal },
        captureAssetSchema,
      ),

    remove: async (assetId: string, callOptions: GoWayRequestOptions = {}) =>
      request(config, { method: 'DELETE', path: assetPath(assetId), signal: callOptions.signal }, null),
  });

  const street3d: GoWayStreet3dApi = Object.freeze({
    coverage: async (query: StreetCoverageQuery, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'GET',
          path: '/street3d/coverage',
          query: validInput(streetCoverageQuerySchema, query, 'query'),
          signal: callOptions.signal,
        },
        streetCoverageSchema,
      ),

    scene: async (sceneId: string, callOptions: GoWayRequestOptions = {}) =>
      request(config, { method: 'GET', path: scenePath(sceneId), signal: callOptions.signal }, streetSceneManifestSchema),

    report: async (sceneId: string, input: StreetSceneReportInput, callOptions: GoWayRequestOptions = {}) =>
      request(
        config,
        {
          method: 'POST',
          path: `${scenePath(sceneId)}/reports`,
          body: validInput(streetSceneReportInputSchema, input, 'input'),
          signal: callOptions.signal,
        },
        streetSceneReportSchema,
      ),
  });

  return Object.freeze({
    places,
    claims,
    moderation,
    search,
    geocode,
    routes,
    captures,
    street3d,
    links: createLinks(webBaseUrl),
  });
}
