/**
 * Nominatim — explicit lookups only.
 *
 * ## The policy is enforced in the type, not in the configuration
 *
 * The OSMF usage policy for `nominatim.openstreetmap.org` forbids autocomplete:
 * "no heavy uses (an absolute maximum of 1 request per second)" and
 * "auto-complete search: This is not yet supported by Nominatim". So this
 * adapter declares `allowsInteractiveSearch: false`, the interactive `/search`
 * endpoint filters providers on exactly that flag, and no environment variable
 * can turn it on. `/geocode`, `/geocode/reverse` and `/geocode/structured` are
 * explicit, user-initiated lookups and may use it.
 *
 * It is also absent from the default `SEARCH_PROVIDERS`, so an operator enables
 * it deliberately — after choosing which instance it points at.
 *
 * ## Identifying the caller is part of the contract
 *
 * The policy REQUIRES a `User-Agent` that identifies the application. It comes
 * from configuration (`SEARCH_NOMINATIM_USER_AGENT`) and is sent on every
 * request; `SEARCH_NOMINATIM_EMAIL` adds the operator contact the policy also
 * asks for, so a problem gets an email rather than a block.
 *
 * ## Payload traps
 *
 * - `lat`/`lon` arrive as STRINGS, not numbers.
 * - `boundingbox` is `[south, north, west, east]` — LATITUDES FIRST, and as
 *   strings. Read as `[west, south, east, north]` it yields a plausible box in
 *   the wrong place rather than an error.
 * - `/reverse` answers with ONE object, not an array, and reports a miss as
 *   `{ "error": … }` under HTTP 200.
 * - `place_id` is explicitly NOT stable across imports, so it is never used as
 *   an identity. The OSM element reference is.
 */

import type { GeoBoundingBox, SearchResult, SearchResultKind, StructuredAddress } from '@goway/shared-types';
import type { NominatimConfig } from '../config/search';
import {
  asObject,
  buildUrl,
  compactAddress,
  composeDisplayName,
  contextFrom,
  countryCode,
  isPoiKey,
  latitude,
  longitude,
  osmSourceId,
  put,
  relevance,
  resultId,
  text,
  type QueryParam,
} from './normalize';
import type {
  FetchLike,
  ProviderCandidate,
  ProviderForwardRequest,
  ProviderReverseRequest,
  ProviderStructuredRequest,
  SearchProvider,
} from './provider';
import { fetchUpstreamJson, UpstreamError } from './upstream';

export interface NominatimProviderOptions {
  config: NominatimConfig;
  fetch: FetchLike;
  timeoutMs: number;
  attempts: number;
}

/** `place` types that name a settlement or a part of one. */
const LOCALITY_TYPES = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'borough',
  'suburb',
  'neighbourhood',
  'quarter',
  'municipality',
  'locality',
  'isolated_dwelling',
  'city_block',
]);

/** `place` types that name a first-level (or near) subdivision. */
const REGION_TYPES = new Set(['state', 'region', 'province', 'county', 'district', 'state_district']);

/** `highway` values that are a destination rather than a road. */
const HIGHWAY_POI_TYPES = new Set(['bus_stop', 'services', 'rest_area', 'elevator', 'platform']);

function nominatimKind(record: Record<string, unknown>, address: StructuredAddress | undefined): SearchResultKind {
  // jsonv2 renamed `class` to `category`; both spellings are in the wild
  // depending on which `format` a deployment defaults to.
  const category = text(record.category ?? record.class)?.toLowerCase();
  const type = text(record.type)?.toLowerCase();
  const addressType = text(record.addresstype)?.toLowerCase();

  if (type === 'country' || addressType === 'country') return 'country';
  if (category !== undefined && isPoiKey(category)) return 'poi';

  if (category === 'highway') {
    return type !== undefined && HIGHWAY_POI_TYPES.has(type) ? 'poi' : 'street';
  }
  if (category === 'place' || category === 'boundary') {
    if (type !== undefined && LOCALITY_TYPES.has(type)) return 'locality';
    if (type !== undefined && REGION_TYPES.has(type)) return 'region';
    if (addressType !== undefined && LOCALITY_TYPES.has(addressType)) return 'locality';
    if (addressType !== undefined && REGION_TYPES.has(addressType)) return 'region';
    if (type === 'house' || type === 'building' || addressType === 'house') return 'address';
    return category === 'boundary' ? 'region' : 'place';
  }
  if (category === 'building' || address?.houseNumber !== undefined) return 'address';
  return 'place';
}

/** `[south, north, west, east]`, as strings. See the module note. */
function nominatimBoundingBox(value: unknown): GeoBoundingBox | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const south = latitude(value[0]);
  const north = latitude(value[1]);
  const west = longitude(value[2]);
  const east = longitude(value[3]);
  if (south === undefined || north === undefined || west === undefined || east === undefined) return undefined;
  if (south > north) return undefined;
  return { west, south, east, north };
}

function nominatimAddress(record: Record<string, unknown>): StructuredAddress | undefined {
  const parts = asObject(record.address) ?? {};
  const address: StructuredAddress = {};
  put(address, 'houseNumber', text(parts.house_number));
  put(address, 'street', text(parts.road) ?? text(parts.pedestrian) ?? text(parts.footway));
  put(address, 'locality', text(parts.neighbourhood) ?? text(parts.suburb) ?? text(parts.quarter));
  put(
    address,
    'city',
    text(parts.city) ?? text(parts.town) ?? text(parts.village) ?? text(parts.municipality) ?? text(parts.hamlet),
  );
  put(address, 'region', text(parts.state) ?? text(parts.province) ?? text(parts.region));
  put(address, 'postalCode', text(parts.postcode));
  put(address, 'countryCode', countryCode(parts.country_code));
  put(address, 'country', text(parts.country));
  // Nominatim DOES publish its own single-line rendering, so unlike Photon this
  // one is a source fact rather than a label GoWay composed.
  put(address, 'formatted', text(record.display_name));
  return compactAddress(address);
}

function toCandidate(value: unknown): ProviderCandidate | undefined {
  const record = asObject(value);
  if (!record) return undefined;

  const lat = latitude(record.lat);
  const lon = longitude(record.lon);
  if (lat === undefined || lon === undefined) return undefined;

  const address = nominatimAddress(record);
  const displayName =
    text(record.display_name) ??
    composeDisplayName([text(record.name), address?.street, address?.city, address?.region, address?.country]);
  if (displayName === '') return undefined;

  const sourceId = osmSourceId(record.osm_type, record.osm_id);

  const result: SearchResult = {
    // `place_id` is deliberately NOT used: Nominatim documents it as unstable
    // across imports, so an id built on it would silently re-key every result
    // the day an instance is reimported.
    id: resultId('nominatim', sourceId ?? `${String(lon)},${String(lat)}`),
    displayName,
    kind: nominatimKind(record, address),
    coordinate: { latitude: lat, longitude: lon },
    source: 'nominatim',
  };
  put(result, 'boundingBox', nominatimBoundingBox(record.boundingbox));
  put(result, 'address', address);
  put(result, 'context', contextFrom(address));
  put(result, 'sourceId', sourceId);
  // `importance` is Nominatim's own 0..1 score. It is NOT comparable with any
  // other provider's, which is why the blend ranks by position rather than by
  // this number — it is published because a single-provider consumer can use it.
  put(result, 'relevance', relevance(record.importance));

  return sourceId === undefined
    ? { result }
    : { result, osmRef: { source: 'openstreetmap', sourceId } };
}

function toCandidates(payload: unknown): ProviderCandidate[] {
  // `/reverse` answers with one object; `/search` with an array.
  const items = Array.isArray(payload) ? payload : [payload];
  const candidates: ProviderCandidate[] = [];
  for (const item of items) {
    const record = asObject(item);
    // A miss is reported as `{ "error": "Unable to geocode" }` under HTTP 200.
    // That is an empty result, not a failure: there is genuinely nothing there.
    if (record?.error !== undefined) continue;
    const candidate = toCandidate(item);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function createNominatimProvider(options: NominatimProviderOptions): SearchProvider {
  const { config, fetch, timeoutMs, attempts } = options;

  const headers: Record<string, string> = { 'User-Agent': config.userAgent };

  const call = async (
    path: string,
    params: readonly QueryParam[],
    request: { locale?: string; signal?: AbortSignal },
  ): Promise<ProviderCandidate[]> => {
    const payload = await fetchUpstreamJson({
      provider: 'nominatim',
      fetch,
      url: buildUrl(config.baseUrl, path, [
        ...params,
        ['format', 'jsonv2'],
        ['addressdetails', 1],
        // The full BCP-47 tag: Nominatim takes an Accept-Language list and
        // falls back on its own, so an unknown tag costs a default, not a 400.
        ['accept-language', request.locale],
        ['email', config.email],
      ]),
      headers,
      timeoutMs,
      attempts,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (payload === null || typeof payload !== 'object') {
      throw new UpstreamError('nominatim', 'malformed');
    }
    return toCandidates(payload);
  };

  return {
    id: 'nominatim',
    // See the module note. This is the policy, expressed where it cannot be
    // configured away.
    allowsInteractiveSearch: false,

    async forward(request: ProviderForwardRequest): Promise<ProviderCandidate[]> {
      // `viewbox` without `bounded=1` is Nominatim's own re-ranking bias and
      // does not filter — which is what the contract requires of a viewport.
      // `near` has no analogue, so a coordinate bias is applied by GoWay's own
      // ranking instead of being faked into a box the caller did not ask for.
      const viewport = request.viewport;
      return call(
        '/search',
        [
          ['q', request.query],
          ['limit', request.limit],
          ...(viewport
            ? ([
                [
                  'viewbox',
                  `${String(viewport.west)},${String(viewport.north)},${String(viewport.east)},${String(viewport.south)}`,
                ],
              ] as QueryParam[])
            : []),
        ],
        request,
      );
    },

    async structured(request: ProviderStructuredRequest): Promise<ProviderCandidate[]> {
      // Nominatim's `street` parameter is documented as "housenumber and
      // streetname", so the two are joined for it and kept apart everywhere
      // else. Mixing `q` with these is refused by Nominatim outright.
      const street = [request.houseNumber, request.street].filter((part) => part !== undefined).join(' ');
      return call(
        '/search',
        [
          ['street', street === '' ? undefined : street],
          ['city', request.city],
          ['state', request.region],
          ['postalcode', request.postalCode],
          ['countrycodes', request.countryCode?.toLowerCase()],
          ['limit', request.limit],
        ],
        request,
      );
    },

    async reverse(request: ProviderReverseRequest): Promise<ProviderCandidate[]> {
      // Nominatim's reverse takes no radius — it answers with the one feature
      // containing the point at the requested `zoom`. `radiusMeters` is
      // therefore NOT translated into anything: inventing a `zoom` from it
      // would answer a different question while looking like it honoured the
      // one asked.
      return call(
        '/reverse',
        [
          ['lat', request.coordinate.latitude],
          ['lon', request.coordinate.longitude],
        ],
        request,
      );
    },
  };
}
