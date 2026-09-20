import {
  CAPABILITY_VERIFICATIONS,
  PLACE_CLAIM_ROLES,
  PLACE_CLAIM_STATES,
  PLACE_STATUSES,
  PLACE_VERIFICATION_STATES,
  SEARCH_RESULT_KINDS,
  TRAVEL_MODES,
} from './contract';
import type {
  GeoBoundingBox,
  GeoCoordinate,
  GeoGeometry,
  GeoPosition,
  OpeningHours,
  OpeningHoursInterval,
  Place,
  PlaceCapability,
  PlaceClaim,
  PlaceName,
  PlaceContact,
  PlaceSourceRef,
  PlaceVerification,
  PlaceWithDistance,
  Route,
  RouteLeg,
  RouteManeuver,
  RouteResponse,
  SearchResult,
  SearchResultContext,
  SearchResults,
  StructuredAddress,
} from './contract';

/**
 * Hand-written response parsers.
 *
 * ## Fresh objects, contract keys only
 *
 * Every parser READS the fields the contract names and WRITES a new object
 * holding exactly those. Nothing is spread and nothing is passed through, so a
 * column the backend leaks tomorrow — an internal PostGIS geometry, a reviewer
 * id, a moderation note, the email of whoever claimed a place — cannot reach an
 * SDK object even if the backend's own projection regresses. `AGENTS.md` says a
 * Drizzle/PostGIS row shape is never an SDK contract; this is the wall that
 * makes it true rather than aspirational.
 *
 * ## Fail closed
 *
 * A missing required field, a wrong type, a value outside a closed set, or a
 * coordinate that is not on Earth is a {@link ParseFailure}, which the transport
 * reports as `GoWayResponseError` (`malformed_response`). The SDK never guesses
 * a default for a fact a consumer would render — a place with an invented
 * `verification.state` is worse than no place at all, because a wallet would
 * show a merchant as verified on the strength of it.
 *
 * ## One bad item fails the whole list
 *
 * A nearby/search/route list is rejected when any item is malformed, rather
 * than dropping that item. Dropping looks friendlier and is worse: the result
 * count would stop meaning what the server served, a map would be missing a
 * marker no one knows about, and the drift that produced the bad item would go
 * unreported in exactly the place a contract test and a consumer's error
 * tracking would otherwise see it.
 *
 * ## `null` is absent
 *
 * An optional field arriving as `null` is read as absent. A JSON serialiser
 * that emits nulls for missing values is the common case, and the contract's
 * optional fields are all "GoWay does not know this", which `null` says too.
 *
 * Messages name the PATH of the offending field (`results[3].coordinate.latitude`)
 * and what was expected — never the value received, which may be arbitrary
 * server data.
 */

/** A response body that is not the contract. Internal; the transport maps it. */
export class ParseFailure extends Error {
  constructor(
    readonly path: string,
    readonly expectation: string,
  ) {
    super(`${path}: expected ${expectation}`);
    this.name = 'ParseFailure';
  }
}

type Json = Record<string, unknown>;

function fail(path: string, expectation: string): never {
  throw new ParseFailure(path, expectation);
}

function object(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object');
  return value as Json;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string');
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'a non-empty string');
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number');
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (parsed < 0) fail(path, 'a non-negative finite number');
  return parsed;
}

function inRange(value: unknown, path: string, min: number, max: number, what: string): number {
  const parsed = finiteNumber(value, path);
  if (parsed < min || parsed > max) fail(path, what);
  return parsed;
}

/** An ISO 8601 instant. Checked by parseability, not by pattern: the contract says "ISO 8601". */
function instant(value: unknown, path: string): string {
  const parsed = nonEmptyString(value, path);
  if (Number.isNaN(Date.parse(parsed))) fail(path, 'an ISO 8601 instant');
  return parsed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function array<T>(value: unknown, path: string, item: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, 'an array');
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

/** Reads an optional field. `undefined` and `null` both mean absent. */
function optional<T>(value: unknown, path: string, parse: (entry: unknown, path: string) => T): T | undefined {
  return value === undefined || value === null ? undefined : parse(value, path);
}

/** Assigns `value` under `key` only when it is present, so no contract key is ever `undefined`. */
function put<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

// ── Geography ───────────────────────────────────────────────────────────────

export function parseCoordinate(value: unknown, path: string): GeoCoordinate {
  const record = object(value, path);
  return {
    latitude: inRange(record.latitude, `${path}.latitude`, -90, 90, 'a latitude in [-90, 90]'),
    longitude: inRange(record.longitude, `${path}.longitude`, -180, 180, 'a longitude in [-180, 180]'),
  };
}

/**
 * A GeoJSON position, `[longitude, latitude]` — longitude FIRST (RFC 7946
 * §3.1.1). The ranges are checked per axis, which is what catches a transposed
 * pair: a latitude in the longitude slot is legal arithmetic and an absurd
 * place, and only the ±90 bound tells the two apart.
 */
export function parsePosition(value: unknown, path: string): GeoPosition {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    fail(path, 'a GeoJSON position: [longitude, latitude] or [longitude, latitude, elevation]');
  }
  const longitude = inRange(value[0], `${path}[0]`, -180, 180, 'a longitude in [-180, 180]');
  const latitude = inRange(value[1], `${path}[1]`, -90, 90, 'a latitude in [-90, 90]');
  if (value.length === 2) return [longitude, latitude];
  return [longitude, latitude, finiteNumber(value[2], `${path}[2]`)];
}

export function parseBoundingBox(value: unknown, path: string): GeoBoundingBox {
  const record = object(value, path);
  return {
    west: inRange(record.west, `${path}.west`, -180, 180, 'a longitude in [-180, 180]'),
    south: inRange(record.south, `${path}.south`, -90, 90, 'a latitude in [-90, 90]'),
    east: inRange(record.east, `${path}.east`, -180, 180, 'a longitude in [-180, 180]'),
    north: inRange(record.north, `${path}.north`, -90, 90, 'a latitude in [-90, 90]'),
  };
}

function parseLineStringCoordinates(value: unknown, path: string): GeoPosition[] {
  const positions = array(value, path, parsePosition);
  if (positions.length < 2) fail(path, 'at least two positions');
  return positions;
}

function parseRing(value: unknown, path: string): GeoPosition[] {
  const ring = array(value, path, parsePosition);
  if (ring.length < 4) fail(path, 'a closed linear ring of at least four positions');
  return ring;
}

export function parseGeometry(value: unknown, path: string): GeoGeometry {
  const record = object(value, path);
  const type = string(record.type, `${path}.type`);
  switch (type) {
    case 'Point':
      return { type: 'Point', coordinates: parsePosition(record.coordinates, `${path}.coordinates`) };
    case 'LineString':
      return {
        type: 'LineString',
        coordinates: parseLineStringCoordinates(record.coordinates, `${path}.coordinates`),
      };
    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: array(record.coordinates, `${path}.coordinates`, parseRing),
      };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: array(record.coordinates, `${path}.coordinates`, (rings, ringsPath) =>
          array(rings, ringsPath, parseRing),
        ),
      };
    default:
      return fail(`${path}.type`, 'one of Point, LineString, Polygon, MultiPolygon');
  }
}

// ── Place parts ─────────────────────────────────────────────────────────────

function parseAddress(value: unknown, path: string): StructuredAddress {
  const record = object(value, path);
  const address: StructuredAddress = {};
  put(address, 'houseNumber', optional(record.houseNumber, `${path}.houseNumber`, string));
  put(address, 'street', optional(record.street, `${path}.street`, string));
  put(address, 'locality', optional(record.locality, `${path}.locality`, string));
  put(address, 'city', optional(record.city, `${path}.city`, string));
  put(address, 'region', optional(record.region, `${path}.region`, string));
  put(address, 'postalCode', optional(record.postalCode, `${path}.postalCode`, string));
  put(address, 'countryCode', optional(record.countryCode, `${path}.countryCode`, string));
  put(address, 'country', optional(record.country, `${path}.country`, string));
  put(address, 'formatted', optional(record.formatted, `${path}.formatted`, string));
  return address;
}

function parseContact(value: unknown, path: string): PlaceContact {
  const record = object(value, path);
  const contact: PlaceContact = {};
  put(contact, 'phone', optional(record.phone, `${path}.phone`, string));
  put(contact, 'email', optional(record.email, `${path}.email`, string));
  put(contact, 'website', optional(record.website, `${path}.website`, string));
  return contact;
}

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function clockTime(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!CLOCK_TIME.test(parsed)) fail(path, 'a local 24-hour time, HH:mm');
  return parsed;
}

function parseOpeningHoursInterval(value: unknown, path: string): OpeningHoursInterval {
  const record = object(value, path);
  const day = finiteNumber(record.day, `${path}.day`);
  if (!Number.isInteger(day) || day < 0 || day > 6) fail(`${path}.day`, 'an integer from 0 (Sunday) to 6 (Saturday)');
  return {
    day: day as OpeningHoursInterval['day'],
    opens: clockTime(record.opens, `${path}.opens`),
    closes: clockTime(record.closes, `${path}.closes`),
  };
}

function parseOpeningHours(value: unknown, path: string): OpeningHours {
  const record = object(value, path);
  const hours: OpeningHours = {
    intervals: array(record.intervals, `${path}.intervals`, parseOpeningHoursInterval),
  };
  put(hours, 'timezone', optional(record.timezone, `${path}.timezone`, nonEmptyString));
  put(hours, 'raw', optional(record.raw, `${path}.raw`, string));
  return hours;
}

function parseVerification(value: unknown, path: string): PlaceVerification {
  const record = object(value, path);
  const verification: PlaceVerification = {
    state: oneOf(record.state, PLACE_VERIFICATION_STATES, `${path}.state`),
  };
  put(verification, 'verifiedAt', optional(record.verifiedAt, `${path}.verifiedAt`, instant));
  return verification;
}

/** `source` is an OPEN set — a new registered source must not fail an old SDK. */
function parseSourceRef(value: unknown, path: string): PlaceSourceRef {
  const record = object(value, path);
  const source: PlaceSourceRef = {
    source: nonEmptyString(record.source, `${path}.source`),
    sourceId: nonEmptyString(record.sourceId, `${path}.sourceId`),
  };
  put(source, 'observedAt', optional(record.observedAt, `${path}.observedAt`, instant));
  return source;
}

function capabilityValue(value: unknown, path: string): boolean | string | number {
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail(path, 'a boolean, a string or a finite number');
}

/**
 * One capability claim.
 *
 * `verification` and `observedAt` are REQUIRED here even though a lazy backend
 * might omit them, because issue #8 turns on them: a wallet must be able to
 * tell an Oxy-verified acceptance from a two-year-old community report, and a
 * capability that arrives without its provenance would render as a plain
 * "accepts FairCoin" badge. `key` must equal `<namespace>.<capability>`; a
 * disagreement means the two sides of the filter no longer describe the same
 * thing.
 */
function parseCapability(value: unknown, path: string): PlaceCapability {
  const record = object(value, path);
  const namespace = nonEmptyString(record.namespace, `${path}.namespace`);
  const capability = nonEmptyString(record.capability, `${path}.capability`);
  const key = nonEmptyString(record.key, `${path}.key`);
  if (key !== `${namespace}.${capability}`) fail(`${path}.key`, `"${namespace}.${capability}"`);
  const parsed: PlaceCapability = {
    namespace,
    capability,
    key,
    value: capabilityValue(record.value, `${path}.value`),
    verification: oneOf(record.verification, CAPABILITY_VERIFICATIONS, `${path}.verification`),
    observedAt: instant(record.observedAt, `${path}.observedAt`),
  };
  put(parsed, 'source', optional(record.source, `${path}.source`, parseSourceRef));
  return parsed;
}

function parseClaim(value: unknown, path: string): PlaceClaim {
  const record = object(value, path);
  const claim: PlaceClaim = {
    id: nonEmptyString(record.id, `${path}.id`),
    role: oneOf(record.role, PLACE_CLAIM_ROLES, `${path}.role`),
    state: oneOf(record.state, PLACE_CLAIM_STATES, `${path}.state`),
    oxyAccountId: nonEmptyString(record.oxyAccountId, `${path}.oxyAccountId`),
    claimedAt: instant(record.claimedAt, `${path}.claimedAt`),
  };
  put(claim, 'brandId', optional(record.brandId, `${path}.brandId`, nonEmptyString));
  return claim;
}

// ── Places ──────────────────────────────────────────────────────────────────

/**
 * One of a place's names, in one language.
 *
 * `source` is a free string rather than a closed set, exactly as on
 * {@link parseSourceRef}: the source registry is GoWay's to extend, and an SDK
 * that refused an unrecognised key would break on the release that added one.
 */
function parsePlaceName(value: unknown, path: string): PlaceName {
  const record = object(value, path);
  return {
    language: nonEmptyString(record.language, `${path}.language`),
    name: string(record.name, `${path}.name`),
    source: nonEmptyString(record.source, `${path}.source`),
  };
}

export function parsePlace(value: unknown, path: string): Place {
  const record = object(value, path);
  const place: Place = {
    id: nonEmptyString(record.id, `${path}.id`),
    name: string(record.name, `${path}.name`),
    location: parseCoordinate(record.location, `${path}.location`),
    categories: array(record.categories, `${path}.categories`, string),
    status: oneOf(record.status, PLACE_STATUSES, `${path}.status`),
    verification: parseVerification(record.verification, `${path}.verification`),
    sources: array(record.sources, `${path}.sources`, parseSourceRef),
    capabilities: array(record.capabilities, `${path}.capabilities`, parseCapability),
    createdAt: instant(record.createdAt, `${path}.createdAt`),
    updatedAt: instant(record.updatedAt, `${path}.updatedAt`),
  };
  put(place, 'geometry', optional(record.geometry, `${path}.geometry`, parseGeometry));
  put(place, 'address', optional(record.address, `${path}.address`, parseAddress));
  put(place, 'contact', optional(record.contact, `${path}.contact`, parseContact));
  put(place, 'openingHours', optional(record.openingHours, `${path}.openingHours`, parseOpeningHours));
  // Absent for a caller not entitled to see claims — which is NOT the same as
  // "this place has no claims", so an absent list is never read as empty.
  put(place, 'claims', optional(record.claims, `${path}.claims`, (claims, claimsPath) =>
    array(claims, claimsPath, parseClaim),
  ));
  // Absent from a viewport or nearby list, where GoWay does not publish the
  // whole set — which is NOT the same as "this place has one name", so an
  // absent list is never read as empty. `[]` means GoWay holds no translation.
  put(place, 'names', optional(record.names, `${path}.names`, (names, namesPath) =>
    array(names, namesPath, parsePlaceName),
  ));
  // Present only when the request named a `locale` AND GoWay holds a name in
  // it. `placeDisplayName` is the published one-liner that falls back to
  // `name`, so no consumer has to restate the rule.
  put(place, 'localizedName', optional(record.localizedName, `${path}.localizedName`, parsePlaceName));
  return place;
}

export function parsePlaceWithDistance(value: unknown, path: string): PlaceWithDistance {
  const record = object(value, path);
  return {
    ...parsePlace(value, path),
    distanceMeters: nonNegativeNumber(record.distanceMeters, `${path}.distanceMeters`),
  };
}

export function parsePlaceList(value: unknown, path: string): Place[] {
  return array(value, path, parsePlace);
}

export function parsePlaceWithDistanceList(value: unknown, path: string): PlaceWithDistance[] {
  return array(value, path, parsePlaceWithDistance);
}

// ── Search ──────────────────────────────────────────────────────────────────

function parseResultContext(value: unknown, path: string): SearchResultContext {
  const record = object(value, path);
  const context: SearchResultContext = {};
  put(context, 'city', optional(record.city, `${path}.city`, string));
  put(context, 'region', optional(record.region, `${path}.region`, string));
  put(context, 'country', optional(record.country, `${path}.country`, string));
  put(context, 'countryCode', optional(record.countryCode, `${path}.countryCode`, string));
  return context;
}

export function parseSearchResult(value: unknown, path: string): SearchResult {
  const record = object(value, path);
  const result: SearchResult = {
    id: nonEmptyString(record.id, `${path}.id`),
    displayName: nonEmptyString(record.displayName, `${path}.displayName`),
    kind: oneOf(record.kind, SEARCH_RESULT_KINDS, `${path}.kind`),
    coordinate: parseCoordinate(record.coordinate, `${path}.coordinate`),
    // An OPEN set: a geocoder GoWay adds tomorrow must not fail today's SDK.
    source: nonEmptyString(record.source, `${path}.source`),
  };
  put(result, 'boundingBox', optional(record.boundingBox, `${path}.boundingBox`, parseBoundingBox));
  put(result, 'address', optional(record.address, `${path}.address`, parseAddress));
  put(result, 'context', optional(record.context, `${path}.context`, parseResultContext));
  put(result, 'sourceId', optional(record.sourceId, `${path}.sourceId`, nonEmptyString));
  put(result, 'placeId', optional(record.placeId, `${path}.placeId`, nonEmptyString));
  put(result, 'place', optional(record.place, `${path}.place`, parsePlace));
  put(result, 'relevance', optional(record.relevance, `${path}.relevance`, (relevance, relevancePath) =>
    inRange(relevance, relevancePath, 0, 1, 'a relevance in [0, 1]'),
  ));
  return result;
}

export function parseSearchResults(value: unknown, path: string): SearchResults {
  const record = object(value, path);
  const results: SearchResults = {
    results: array(record.results, `${path}.results`, parseSearchResult),
    providers: array(record.providers, `${path}.providers`, nonEmptyString),
  };
  put(results, 'degradedProviders', optional(
    record.degradedProviders,
    `${path}.degradedProviders`,
    (providers, providersPath) => array(providers, providersPath, nonEmptyString),
  ));
  return results;
}

// ── Routes ──────────────────────────────────────────────────────────────────

function parseManeuver(value: unknown, path: string): RouteManeuver {
  const record = object(value, path);
  const maneuver: RouteManeuver = {
    // An OPEN set: a router that emits a maneuver type v1 did not name should
    // still produce a usable route, so the string passes through.
    type: nonEmptyString(record.type, `${path}.type`),
    instruction: string(record.instruction, `${path}.instruction`),
    distanceMeters: nonNegativeNumber(record.distanceMeters, `${path}.distanceMeters`),
    durationSeconds: nonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
    coordinate: parseCoordinate(record.coordinate, `${path}.coordinate`),
  };
  put(maneuver, 'streetName', optional(record.streetName, `${path}.streetName`, string));
  put(maneuver, 'geometryIndex', optional(record.geometryIndex, `${path}.geometryIndex`, (index, indexPath) => {
    const parsed = nonNegativeNumber(index, indexPath);
    if (!Number.isInteger(parsed)) fail(indexPath, 'a non-negative integer index');
    return parsed;
  }));
  return maneuver;
}

function parseLeg(value: unknown, path: string): RouteLeg {
  const record = object(value, path);
  return {
    distanceMeters: nonNegativeNumber(record.distanceMeters, `${path}.distanceMeters`),
    durationSeconds: nonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
    maneuvers: array(record.maneuvers, `${path}.maneuvers`, parseManeuver),
  };
}

export function parseRoute(value: unknown, path: string): Route {
  const record = object(value, path);
  const geometry = parseGeometry(record.geometry, `${path}.geometry`);
  if (geometry.type !== 'LineString') fail(`${path}.geometry.type`, '"LineString"');
  return {
    id: nonEmptyString(record.id, `${path}.id`),
    mode: oneOf(record.mode, TRAVEL_MODES, `${path}.mode`),
    distanceMeters: nonNegativeNumber(record.distanceMeters, `${path}.distanceMeters`),
    durationSeconds: nonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
    geometry,
    legs: array(record.legs, `${path}.legs`, parseLeg),
  };
}

/**
 * A directions response. An EMPTY `routes` array is valid and means "no route
 * exists between these points" — a normal domain answer, not a malformed body.
 */
export function parseRouteResponse(value: unknown, path: string): RouteResponse {
  const record = object(value, path);
  return { routes: array(record.routes, `${path}.routes`, parseRoute) };
}
