/**
 * What counts as a gazetteer place — a locality or a region — and which one.
 *
 * ## Why this lives beside `poiTags`, not inside it
 *
 * `poiTags` answers "is this a business or a venue the basemap draws a pin
 * for". This answers a different question with a different source of truth: the
 * administrative hierarchy. A city is not a POI — it has no category a person
 * browses by, it is drawn by the basemap's own place labels rather than a pin,
 * and it is positioned by a boundary rather than a point. Keeping the two
 * classifiers apart is what lets each stay honest about the one thing it knows.
 *
 * ## Only `boundary=administrative`, and only relations in practice
 *
 * A place is admitted here when it carries `boundary=administrative` with an
 * `admin_level` the hierarchy below recognises. That is deliberately narrower
 * than "anything tagged `place=city`":
 *
 *  - It is what the geocoders key a city to. Photon and Nominatim both answer a
 *    city search with the OSM *boundary relation* (`relation/347950` for
 *    Barcelona, measured), never the `place=city` node — so the row that has to
 *    exist for a geocoder result to reconcile (`places_sources` keyed
 *    `openstreetmap:relation/347950`) is the boundary one. Importing the
 *    `place=*` node instead would create a row nothing ever reconciles to, and
 *    importing BOTH would create two GoWay places for one city — a duplicate
 *    this classifier exists to avoid by choosing a single canonical element.
 *  - `admin_level` is how OSM states "city vs province vs country" in a way a
 *    machine can read, where the `place=*` value ("city" vs "town") is a
 *    population judgement that varies by country and by mapper.
 *
 * Places that exist only as a `place=*` node with no administrative boundary —
 * a hamlet in the countryside — are not imported in this first pass and fall
 * back to the raw text a caller already had. That gap is named rather than
 * hidden; closing it means importing `place=*` nodes AND de-duplicating them
 * against the boundaries whose `admin_centre` they are, which needs relation
 * member roles the reader does not expose yet.
 *
 * ## `admin_level` is a convention, and the mapping is pragmatic
 *
 * OSM's `admin_level` is a worldwide convention with real per-country variation
 * (https://wiki.openstreetmap.org/wiki/Tag:boundary=administrative). The
 * mapping below is the one that holds across the countries GoWay serves jobs
 * in: 4–6 is a region (state, province, county), 7–11 is a locality
 * (municipality, city, borough, suburb). 2–3 (country, supranational) is
 * skipped on purpose — there is no GoWay-owned copy of a country, for the same
 * reason there is no GoWay-owned copy of the planet. Anything coarser than a
 * country or finer than a suburb is skipped too.
 */

/** A gazetteer place is one of exactly these two kinds. */
export type GazetteerKind = 'locality' | 'region';

/** What {@link classifyGazetteer} returns when an element is a gazetteer place. */
export interface GazetteerClass {
  kind: GazetteerKind;
  /** Normalized category keys, most specific first — `['locality']` or `['region']`. */
  categories: string[];
}

/** The one tag key that can make an element a gazetteer place — the cheap test a scan runs first. */
export function isGazetteerMappingKey(key: string): boolean {
  return key === 'boundary';
}

/**
 * The gazetteer kind for an `admin_level`, or `null` for a level this importer
 * does not store.
 *
 * Inclusive ranges, read off the convention in the docblock. A non-integer or
 * out-of-range level is not a gazetteer place GoWay keeps.
 */
function kindForAdminLevel(adminLevel: number): GazetteerKind | null {
  if (!Number.isInteger(adminLevel)) return null;
  if (adminLevel >= 4 && adminLevel <= 6) return 'region';
  if (adminLevel >= 7 && adminLevel <= 11) return 'locality';
  return null;
}

/**
 * What kind of gazetteer place these tags describe, or `null` if they describe
 * none.
 *
 * `null` covers an element with no administrative boundary, a boundary that is
 * not `administrative` (a postal or statistical one), and an `admin_level` the
 * mapping skips — a caller cannot tell them apart and does not need to: none
 * becomes a place.
 */
export function classifyGazetteer(tags: ReadonlyMap<string, string>): GazetteerClass | null {
  if (tags.get('boundary') !== 'administrative') return null;

  const raw = tags.get('admin_level');
  if (raw === undefined) return null;
  const adminLevel = Number(raw.trim());
  const kind = kindForAdminLevel(adminLevel);
  if (kind === null) return null;

  return { kind, categories: [kind] };
}
