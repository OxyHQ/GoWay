/**
 * Photon — the interactive geocoder.
 *
 * Photon indexes OpenStreetMap, answers forward, structured and reverse
 * lookups, permits autocomplete, and can be self-hosted, which is the whole
 * reason it is GoWay's first adapter. The public `photon.komoot.io` instance is
 * community infrastructure: fine for development within fair use, never an
 * SLA-backed production dependency (see `config/search.ts`).
 *
 * ## Two payload traps this adapter exists to absorb
 *
 * 1. `properties.extent` is `[minLon, maxLat, maxLon, minLat]` — west, NORTH,
 *    east, SOUTH. Read positionally as `[west, south, east, north]` it produces
 *    a box with `south > north`, which is not an error anywhere, just a camera
 *    that frames the wrong hemisphere-ish rectangle.
 * 2. `radius` on `/reverse` is in KILOMETRES. GoWay speaks metres everywhere
 *    (`Meters` is a named type in the contract precisely so an API cannot
 *    quietly accept the wrong unit), so passing `radiusMeters` through would
 *    search a thousand times too far and look like a ranking bug.
 *
 * ## `bbox` is a FILTER, so a viewport bias never sends one
 *
 * The contract says biasing re-ranks and does not filter: a search for "Berlin"
 * while looking at Madrid must still find Berlin, lower down. Photon's `bbox`
 * DISCARDS everything outside the box, so a viewport is applied as `lat`/`lon`
 * location bias around the viewport's centre instead — Photon's own biasing
 * mechanism, which re-ranks. `categories` is the opposite case: it IS a filter
 * by contract, so an explicit OSM tag is forwarded as `osm_tag`.
 */

import type { GeoBoundingBox, SearchResult, SearchResultKind, StructuredAddress } from '@goway/shared-types';
import type { PhotonConfig } from '../config/search';
import {
  asObject,
  buildUrl,
  compactAddress,
  composeDisplayName,
  contextFrom,
  countryCode,
  isPoiKey,
  languageSubtag,
  latitude,
  longitude,
  osmSourceId,
  put,
  resultId,
  text,
  type QueryParam,
} from './normalize';
import { centerOf } from './ranking';
import type {
  FetchLike,
  ProviderCandidate,
  ProviderForwardRequest,
  ProviderReverseRequest,
  ProviderStructuredRequest,
  SearchProvider,
} from './provider';
import { fetchUpstreamJson, UpstreamError } from './upstream';

/** A category the caller spelled as an explicit OSM tag, e.g. `amenity:cafe`. */
const OSM_TAG = /^[a-z][a-z0-9_]*[:=][a-z0-9_.-]+$/i;

/** Photon's reverse radius is in kilometres; the contract is in metres. */
const METERS_PER_KILOMETER = 1_000;

/** The widest reverse radius Photon is asked for, in kilometres. */
const MAX_REVERSE_RADIUS_KM = 50;

export interface PhotonProviderOptions {
  config: PhotonConfig;
  fetch: FetchLike;
  timeoutMs: number;
  attempts: number;
}

/**
 * Photon's own result type, mapped to the contract's closed set.
 *
 * The POI check comes FIRST and on the OSM key rather than on `type`, because
 * Photon classifies a named café that has a house number as `type: "house"`.
 * Trusting `type` alone would file every business on the map under `address`,
 * and a category search would look empty while returning everything.
 */
function photonKind(properties: Record<string, unknown>): SearchResultKind {
  if (isPoiKey(properties.osm_key) && text(properties.name) !== undefined) return 'poi';

  switch (text(properties.type)?.toLowerCase()) {
    case 'house':
      return 'address';
    case 'street':
      return 'street';
    case 'locality':
    case 'district':
    case 'city':
      return 'locality';
    case 'county':
    case 'state':
      return 'region';
    case 'country':
      return 'country';
    default:
      return isPoiKey(properties.osm_key) ? 'poi' : 'place';
  }
}

/**
 * `properties.extent` → a bounding box, or nothing.
 *
 * All four values are range-checked per AXIS, which is what catches the
 * positional mistake the module note describes: a latitude read into a
 * longitude slot is legal arithmetic and an absurd box.
 */
function photonBoundingBox(extent: unknown): GeoBoundingBox | undefined {
  if (!Array.isArray(extent) || extent.length !== 4) return undefined;
  const west = longitude(extent[0]);
  const north = latitude(extent[1]);
  const east = longitude(extent[2]);
  const south = latitude(extent[3]);
  if (west === undefined || north === undefined || east === undefined || south === undefined) return undefined;
  // `west > east` is legal (an antimeridian crossing); `south > north` is not.
  if (south > north) return undefined;
  return { west, south, east, north };
}

function photonAddress(properties: Record<string, unknown>): StructuredAddress | undefined {
  const address: StructuredAddress = {};
  put(address, 'houseNumber', text(properties.housenumber));
  put(address, 'street', text(properties.street));
  put(address, 'locality', text(properties.district));
  put(address, 'city', text(properties.city));
  put(address, 'region', text(properties.state));
  put(address, 'postalCode', text(properties.postcode));
  put(address, 'countryCode', countryCode(properties.countrycode));
  put(address, 'country', text(properties.country));
  // `formatted` stays ABSENT: Photon publishes no single-line rendering, and
  // the label this adapter composes below is a rendering of GoWay's own making.
  return compactAddress(address);
}

/**
 * The street line.
 *
 * `<street> <number>` is a RENDERING choice, not a derived fact: no ordering is
 * correct everywhere ("221B Baker Street" against "Calle Mayor 5") and nothing
 * in the payload says which country convention applies. `street` and
 * `houseNumber` stay separate in `address`, so a client that knows better can
 * render it its own way.
 */
function photonStreetLine(properties: Record<string, unknown>): string | undefined {
  const street = text(properties.street);
  const houseNumber = text(properties.housenumber);
  if (street === undefined) return undefined;
  return houseNumber === undefined ? street : `${street} ${houseNumber}`;
}

function toCandidate(feature: unknown): ProviderCandidate | undefined {
  const record = asObject(feature);
  const properties = asObject(record?.properties);
  const geometry = asObject(record?.geometry);
  if (!properties || !geometry) return undefined;

  // GeoJSON: [longitude, latitude]. LONGITUDE FIRST (RFC 7946 §3.1.1).
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return undefined;
  const lon = longitude(coordinates[0]);
  const lat = latitude(coordinates[1]);
  if (lon === undefined || lat === undefined) return undefined;

  const displayName = composeDisplayName([
    text(properties.name) ?? photonStreetLine(properties),
    text(properties.district),
    text(properties.city),
    text(properties.state),
    text(properties.country),
  ]);
  if (displayName === '') return undefined;

  const address = photonAddress(properties);
  const sourceId = osmSourceId(properties.osm_type, properties.osm_id);

  const result: SearchResult = {
    // Deterministic across requests. With no OSM id to key on — which Photon
    // does emit for a synthesised record — the coordinate stands in, so the row
    // still diffs stably between two keystrokes instead of being re-keyed by index.
    id: resultId('photon', sourceId ?? `${String(lon)},${String(lat)}`),
    displayName,
    kind: photonKind(properties),
    coordinate: { latitude: lat, longitude: lon },
    source: 'photon',
  };
  put(result, 'boundingBox', photonBoundingBox(properties.extent));
  put(result, 'address', address);
  put(result, 'context', contextFrom(address));
  put(result, 'sourceId', sourceId);
  // No `relevance`: Photon publishes no score, and a made-up one would be
  // rendered as confidence GoWay does not have.

  return sourceId === undefined
    ? { result }
    : { result, osmRef: { source: 'openstreetmap', sourceId } };
}

/** The `features` of a Photon FeatureCollection, normalized; malformed ones dropped. */
function toCandidates(payload: unknown, provider: 'photon'): ProviderCandidate[] {
  const record = asObject(payload);
  const features = record?.features;
  if (!Array.isArray(features)) {
    // A 200 that is not a FeatureCollection is the provider misbehaving, not an
    // empty result: reporting it as "no matches" would hide an outage behind a
    // blank search box for as long as it lasted.
    throw new UpstreamError(provider, 'malformed');
  }
  const candidates: ProviderCandidate[] = [];
  for (const feature of features) {
    // One unusable feature is DROPPED rather than failing the response: unlike
    // the SDK, which must not silently shorten a list it publishes, this layer
    // is the one deciding what the list is.
    const candidate = toCandidate(feature);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function createPhotonProvider(options: PhotonProviderOptions): SearchProvider {
  const { config, fetch, timeoutMs, attempts } = options;
  const languages = new Set(config.languages);

  /** The `lang` Photon was built with, or nothing. An unknown one is a 400. */
  const language = (locale: string | undefined): string | undefined => {
    const subtag = languageSubtag(locale);
    return subtag !== undefined && languages.has(subtag) ? subtag : undefined;
  };

  const call = async (
    path: string,
    params: readonly QueryParam[],
    signal: AbortSignal | undefined,
  ): Promise<ProviderCandidate[]> => {
    const payload = await fetchUpstreamJson({
      provider: 'photon',
      fetch,
      url: buildUrl(config.baseUrl, path, params),
      timeoutMs,
      attempts,
      ...(signal ? { signal } : {}),
    });
    return toCandidates(payload, 'photon');
  };

  return {
    id: 'photon',
    // Photon exists to be typed into: its own documentation is an autocomplete
    // demo, and it is the reason this is the interactive provider.
    allowsInteractiveSearch: true,

    async forward(request: ProviderForwardRequest): Promise<ProviderCandidate[]> {
      // `near` beats `viewport`, which is the contract's own precedence: an
      // explicit coordinate is a stronger statement of intent than where the
      // map happens to be pointing.
      // `centerOf` folds an antimeridian-crossing box back into [-180, 180]:
      // a Pacific viewport's naive centre reads as a longitude of 190, which
      // Photon refuses outright.
      const bias = request.near ?? (request.viewport ? centerOf(request.viewport) : undefined);
      const params: QueryParam[] = [
        ['q', request.query],
        ['limit', request.limit],
        ['lang', language(request.locale)],
        ['lat', bias?.latitude],
        ['lon', bias?.longitude],
      ];
      for (const category of request.categories ?? []) {
        if (OSM_TAG.test(category)) params.push(['osm_tag', category.replace('=', ':')]);
      }
      return call('/api', params, request.signal);
    },

    async structured(request: ProviderStructuredRequest): Promise<ProviderCandidate[]> {
      return call(
        '/structured',
        [
          ['street', request.street],
          ['housenumber', request.houseNumber],
          ['postcode', request.postalCode],
          ['city', request.city],
          ['state', request.region],
          ['countrycode', request.countryCode],
          ['limit', request.limit],
          ['lang', language(request.locale)],
        ],
        request.signal,
      );
    },

    async reverse(request: ProviderReverseRequest): Promise<ProviderCandidate[]> {
      const radiusKm =
        request.radiusMeters === undefined
          ? undefined
          : Math.min(MAX_REVERSE_RADIUS_KM, Math.max(0.001, request.radiusMeters / METERS_PER_KILOMETER));
      return call(
        '/reverse',
        [
          ['lat', request.coordinate.latitude],
          ['lon', request.coordinate.longitude],
          ['limit', request.limit],
          ['lang', language(request.locale)],
          // Kilometres. See the module note.
          ['radius', radiusKm],
        ],
        request.signal,
      );
    },
  };
}
