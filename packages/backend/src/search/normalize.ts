/**
 * Normalization helpers shared by the geocoder adapters.
 *
 * ## The one rule these exist to enforce
 *
 * "Do not invent missing structured fields." An inferred `postalCode` is
 * indistinguishable downstream from a real one, and the place it does damage is
 * not the map — it is the delivery, the invoice and the address a courier is
 * handed. So every helper here is SUBTRACTIVE: it drops what the provider did
 * not say, trims what it did, and never derives one field from another.
 *
 * `displayName` is the single deliberate exception, and it is not an exception
 * to the rule: composing a LABEL out of parts the provider supplied is
 * rendering, not asserting a fact. That is why a composed label is never
 * written back into `address.formatted`, which means "the source's own
 * single-line rendering" and is left absent when there is none.
 */

import type { SearchResultContext, StructuredAddress } from '@goway/shared-types';

/** Assign only when the value is present, so an optional field stays absent. */
export function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

/** A non-empty trimmed string, or `undefined`. Numbers are accepted: JSON house numbers arrive as both. */
export function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** A finite number from a JSON value that may be a numeric STRING (Nominatim's `lat`/`lon` are). */
export function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A latitude on Earth, or `undefined`. A transposed pair is caught here, not rendered. */
export function latitude(value: unknown): number | undefined {
  const parsed = numeric(value);
  return parsed !== undefined && parsed >= -90 && parsed <= 90 ? parsed : undefined;
}

/** A longitude on Earth, or `undefined`. */
export function longitude(value: unknown): number | undefined {
  const parsed = numeric(value);
  return parsed !== undefined && parsed >= -180 && parsed <= 180 ? parsed : undefined;
}

/**
 * An ISO 3166-1 alpha-2 code, upper-cased.
 *
 * Case-folding is not inventing a fact — unlike deriving a missing code from a
 * country NAME, which nothing here does. The contract says uppercase and both
 * providers emit either case.
 */
export function countryCode(value: unknown): string | undefined {
  const raw = text(value);
  return raw !== undefined && /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : undefined;
}

/** Drops the fields the provider did not supply; `undefined` when it supplied none. */
export function compactAddress(address: StructuredAddress): StructuredAddress | undefined {
  const compacted: StructuredAddress = {};
  for (const [key, value] of Object.entries(address)) {
    if (value !== undefined) (compacted as Record<string, unknown>)[key] = value;
  }
  return Object.keys(compacted).length === 0 ? undefined : compacted;
}

/**
 * The administrative context a result carries, read from the address it already
 * has rather than looked up. `undefined` when the provider named none.
 */
export function contextFrom(address: StructuredAddress | undefined): SearchResultContext | undefined {
  if (!address) return undefined;
  const context: SearchResultContext = {};
  put(context, 'city', address.city);
  put(context, 'region', address.region);
  put(context, 'country', address.country);
  put(context, 'countryCode', address.countryCode);
  return Object.keys(context).length === 0 ? undefined : context;
}

/**
 * A human-readable label from the parts the provider gave, in the order given.
 *
 * De-duplicated case-insensitively: "Berlin, Berlin, Germany" is what naive
 * concatenation produces for a city that is also a federal state, and it reads
 * as a bug to every user who sees it.
 */
export function composeDisplayName(parts: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const value = text(part);
    if (value === undefined) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(value);
  }
  return kept.join(', ');
}

/**
 * A deterministic result id.
 *
 * The contract: "`id` is deterministic for a given (source, sourceId) pair so a
 * result list can be diffed and de-duplicated across requests rather than
 * re-keyed by index." Two searches a keystroke apart therefore agree on which
 * rows are the same row, which is what lets a list animate instead of flashing.
 */
export function resultId(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

/** A provider score folded into the contract's 0..1, or `undefined`. */
export function relevance(value: unknown): number | undefined {
  const parsed = numeric(value);
  if (parsed === undefined) return undefined;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * The OSM element reference for an element type and id, or `undefined`.
 *
 * Photon abbreviates the type (`N`/`W`/`R`); Nominatim spells it out. Both are
 * normalized to `node/…`, `way/…`, `relation/…` — the spelling `places_sources`
 * holds — so a candidate from either geocoder reconciles against the same row.
 */
export function osmSourceId(osmType: unknown, osmId: unknown): string | undefined {
  const id = numeric(osmId);
  if (id === undefined || !Number.isInteger(id)) return undefined;
  const raw = text(osmType)?.toLowerCase();
  const element =
    raw === 'n' || raw === 'node'
      ? 'node'
      : raw === 'w' || raw === 'way'
        ? 'way'
        : raw === 'r' || raw === 'relation'
          ? 'relation'
          : undefined;
  return element === undefined ? undefined : `${element}/${String(id)}`;
}

/**
 * OSM top-level keys that describe a point of interest rather than a place in
 * the gazetteer sense.
 *
 * Used to tell a café from an address: both geocoders classify a named shop by
 * its ADDRESS shape ("house"), which would file every business on the map under
 * `address` and make a POI search look broken.
 */
const POI_KEYS = new Set([
  'amenity',
  'shop',
  'tourism',
  'leisure',
  'office',
  'craft',
  'healthcare',
  'historic',
  'man_made',
  'aeroway',
  'emergency',
  'sport',
  'club',
]);

export function isPoiKey(value: unknown): boolean {
  const key = text(value)?.toLowerCase();
  return key !== undefined && POI_KEYS.has(key);
}

/** A query-string parameter. Repeats are allowed — Photon takes several `osm_tag`s. */
export type QueryParam = readonly [name: string, value: string | number | undefined];

/**
 * Build an upstream URL.
 *
 * Hand-rolled rather than `URLSearchParams`, which encodes a space as `+`.
 * Nominatim and Photon both accept `+`, but `encodeURIComponent` is what the
 * rest of this repository produces and a single spelling is what makes a cache
 * key stable.
 */
export function buildUrl(baseUrl: string, path: string, params: readonly QueryParam[]): string {
  const query = params
    .filter((param): param is readonly [string, string | number] => param[1] !== undefined && param[1] !== '')
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${baseUrl}${path}${query === '' ? '' : `?${query}`}`;
}

/** A JSON object, or `undefined`. Arrays are not objects for this purpose. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The primary language subtag of a BCP-47 tag, lower-cased.
 *
 * `es-419` and `es-ES` are both `es` to a geocoder that indexes `name:es`.
 */
export function languageSubtag(locale: string | undefined): string | undefined {
  const tag = text(locale)?.toLowerCase();
  if (tag === undefined) return undefined;
  const [primary] = tag.split('-');
  return primary !== undefined && /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}
