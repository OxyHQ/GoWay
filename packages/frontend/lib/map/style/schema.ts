/**
 * The **OpenMapTiles v3 vector schema**, as OpenFreeMap actually serves it.
 *
 * This file is the reason a GoWay-owned style document is possible without
 * changing tile providers: the cartography is ours, the *schema* is not, and a
 * style can only name layers, fields and values the tiles really contain. A
 * wrong `source-layer` is the worst kind of mistake here — MapLibre renders
 * nothing, logs nothing and throws nothing, so a typo ships as an empty map.
 *
 * Everything below was read off real artefacts rather than remembered:
 *
 *  - The source-layer names and their fields were first read from the TileJSON
 *    at `https://tiles.openfreemap.org/planet`, and are now asserted against
 *    **GoWay's own archive** — `map:tiles --verify` opens the finished PMTiles
 *    build and fails if its `vector_layers` and this list disagree in either
 *    direction.
 *  - The `class` vocabularies come from **decoding real `.pbf` tiles** and
 *    collecting the distinct values that actually appear. That is why, for
 *    example, `street` and `street_limited` are absent: they are Mapbox-schema
 *    road classes, and OpenFreeMap's own `liberty` style carries layers
 *    filtering on them that can never match anything.
 *
 * ## Why this file did not have to change when the tiles became GoWay's
 *
 * Because Planetiler's basemap profile IS an OpenMapTiles v3 implementation,
 * and it is the same generator OpenFreeMap runs. GoWay's first self-hosted
 * build emitted the same sixteen `vector_layers` ids recorded below, so the
 * style document needed no change at all. What DID change is the confidence
 * behind the vocabularies: they can now be swept from an archive on disk
 * rather than sampled through somebody else's CDN, and the sweep immediately
 * turned up values six cities of sampling had missed — `busway`, `raceway`,
 * `campsite`, `prison`, `hamlet`, the `*_construction` road classes the
 * comment below had always claimed were there. Those are marked where they
 * were added.
 *
 * `scripts/build-map-style.ts --check` asserts that every `source-layer` the
 * style names appears in {@link OPENMAPTILES_SOURCE_LAYERS}, so this file and
 * the style cannot drift apart silently.
 */

/**
 * Source-layer names inside the vector source.
 *
 * Shared with `lib/map/provider.ts`, which publishes them as part of the
 * documented id contract — overlays in issues #5 and #6 target them by name.
 */
export const OPENMAPTILES_SOURCE_LAYERS = {
  aerodromeLabel: 'aerodrome_label',
  aeroway: 'aeroway',
  boundary: 'boundary',
  building: 'building',
  housenumber: 'housenumber',
  landcover: 'landcover',
  landuse: 'landuse',
  mountainPeak: 'mountain_peak',
  park: 'park',
  place: 'place',
  poi: 'poi',
  transportation: 'transportation',
  transportationName: 'transportation_name',
  water: 'water',
  waterName: 'water_name',
  waterway: 'waterway',
} as const;

export type OpenMapTilesSourceLayer =
  (typeof OPENMAPTILES_SOURCE_LAYERS)[keyof typeof OPENMAPTILES_SOURCE_LAYERS];

/** Every source-layer name, for the validator. */
export const OPENMAPTILES_SOURCE_LAYER_NAMES: readonly string[] = Object.values(
  OPENMAPTILES_SOURCE_LAYERS,
);

// ---------------------------------------------------------------------------
// Observed `class` vocabularies
// ---------------------------------------------------------------------------

/**
 * `transportation.class`, observed.
 *
 * The `*_construction` variants are real and deliberately left unstyled: a road
 * that does not exist yet is noise on a map used to get somewhere today.
 */
export const TRANSPORTATION_CLASSES = [
  'aerialway',
  'bridge',
  'busway',
  'ferry',
  'minor',
  'motorway',
  'path',
  'pier',
  'primary',
  'raceway',
  'rail',
  'secondary',
  'service',
  'tertiary',
  'track',
  'transit',
  'trunk',
  // The `*_construction` variants, which this comment always claimed were real
  // and which no sample had ever actually produced until the vocabulary was
  // swept out of GoWay's own archive. Still deliberately unstyled.
  'minor_construction',
  'motorway_construction',
  'path_construction',
  'primary_construction',
  'secondary_construction',
  'service_construction',
  'tertiary_construction',
  'trunk_construction',
] as const;

/** `landcover.class`, observed. `rock` is omitted from the style on purpose —
 *  the supplied palette hides `landscape.natural.terrain`. */
export const LANDCOVER_CLASSES = ['farmland', 'grass', 'ice', 'rock', 'sand', 'wetland', 'wood'] as const;

/** `landuse.class`, observed. */
export const LANDUSE_CLASSES = [
  'bus_station',
  'cemetery',
  'college',
  'commercial',
  'education',
  'garages',
  'hospital',
  'industrial',
  'kindergarten',
  'library',
  'military',
  'neighbourhood',
  'official_residence',
  'park',
  'pitch',
  'playground',
  'quarry',
  'quarter',
  'railway',
  'residential',
  'retail',
  'school',
  'stadium',
  'suburb',
  'theme_park',
  'track',
  'university',
  'zoo',
  // Swept out of GoWay's own build; not seen in the original city sampling.
  'dam',
  'grass',
  'music_venue',
  'racetrack',
  'recreation_ground',
] as const;

/** `place.class`, observed. */
export const PLACE_CLASSES = [
  'aboriginal_lands',
  'city',
  'country',
  'island',
  'neighbourhood',
  'province',
  'quarter',
  'state',
  'suburb',
  'town',
  'village',
  // Swept out of GoWay's own build.
  'hamlet',
  'isolated_dwelling',
] as const;

/** `water.class`, observed. */
export const WATER_CLASSES = ['dock', 'lake', 'ocean', 'pond', 'river', 'swimming_pool'] as const;

/** `poi.class`, observed across the sampled cities. */
export const POI_CLASSES = [
  'alcohol_shop', 'aquarium', 'art_gallery', 'athletics', 'atm', 'attraction', 'bakery', 'bank',
  'bar', 'beer', 'bicycle', 'bicycle_parking', 'bicycle_rental', 'bollard', 'boxing', 'brownfield',
  'bus', 'butcher', 'cafe', 'car', 'castle', 'cemetery', 'cinema', 'clothing_store', 'college',
  'cycle_barrier', 'cycling', 'dentist', 'doctors', 'dog_park', 'drinking_water', 'entrance',
  'equestrian', 'escape_game', 'fast_food', 'ferry_terminal', 'fire_station', 'fuel', 'garden',
  'gate', 'golf', 'grocery', 'gymnastics', 'hackerspace', 'hairdresser', 'hospital', 'ice_cream',
  'ice_rink', 'information', 'laundry', 'library', 'lift_gate', 'lodging', 'monument',
  'motorcycle_parking', 'multi', 'museum', 'music', 'office', 'park', 'parking', 'pharmacy',
  'picnic_site', 'pitch', 'place_of_worship', 'playground', 'police', 'post', 'railway',
  'recycling', 'restaurant', 'running', 'sally_port', 'school', 'shelter', 'shop', 'sports_centre',
  'stadium', 'stile', 'swimming_pool', 'telephone', 'theatre', 'toilets', 'toll_booth', 'town_hall',
  'veterinary', 'waste_basket', 'yoga',
  // Documented by the OpenMapTiles v3 `poi_class` table but NOT seen in any of
  // the sampled cities, so they are recorded separately from the rest: they
  // are schema truth rather than observation. `layers.ts` colours both, and
  // the filter-coverage sweep in `build-map-style.ts` needs them here to tell
  // "a class we have not happened to see" from "a class that does not exist".
  'motorcycle', 'zoo',
  // Swept out of GoWay's OWN archive (888 tiles, z0–z14, across a whole
  // region rather than six city centres). Observation again, not schema
  // truth — but observation of the artefact GoWay serves.
  'aerialway', 'basin', 'basketball', 'boules', 'campsite', 'chess', 'climbing', 'harbor',
  'karting', 'orienteering', 'prison', 'rc_car', 'reservoir', 'sailing', 'scuba_diving',
  'shooting', 'swimming', 'table_tennis', 'theme_park',
] as const;

/**
 * Glyph fontstacks GoWay's own font server answers with.
 *
 * ## What changed, and why it matters for type
 *
 * These used to be OpenFreeMap's, and the ladder was two rungs: checked, not
 * assumed, `Noto Sans Medium` and `Noto Sans SemiBold` both 404 there, so the
 * style had Regular and Bold and nothing in between. Every attempt at an
 * Apple-grade hierarchy ran into that — the difference between a district
 * label and a city label is a weight step, and there was no step to take.
 *
 * GoWay now generates its own ranges from **Inter Variable**, which is already
 * Bloom's `font-bloom-sans` and therefore GoWay's own product typeface, under
 * the SIL Open Font License 1.1 (the font's `name` table says so; `fsType`
 * carries no embedding restriction). It is a variable font with a `wght` axis
 * from 100 to 900, so the instances below are not four fonts we found — they
 * are four points we chose on one continuous axis, and a fifth is a
 * regeneration away. See `scripts/build-map-glyphs.ts`.
 *
 * ## The rules that have not changed
 *
 * MapLibre requests a *combined* stack when a `text-font` names more than one
 * family, and a combined stack is a separate document a server has to compose.
 * GoWay's does not compose them either, so every `text-font` in this style
 * stays a single-element array.
 *
 * Coverage is the other constant worth stating out loud: Inter is Latin, Greek
 * and Cyrillic. A feature with a `name` but no `name:latin` — most of the CJK,
 * Arabic, Devanagari and Thai world — lands in a range Inter does not have,
 * and `worker/index.js` answers those by proxying the upstream Noto ranges
 * through `goway.to`. The label still renders and the browser still talks to
 * nobody but us; it is simply not set in Inter.
 */
export const AVAILABLE_FONTS = [
  'Inter Regular',
  'Inter Medium',
  'Inter SemiBold',
  'Inter Bold',
] as const;

export type AvailableFont = (typeof AVAILABLE_FONTS)[number];

/**
 * The fontstacks as MapLibre wants them — one-element arrays, named by role.
 *
 * Exported as the single source for `text-font` so that the ladder is
 * visible in one place rather than as string literals scattered through
 * `layers.ts`, and so that a regeneration at a different weight is a change
 * here and nowhere else. `MEDIUM` and `SEMIBOLD` exist because they now CAN:
 * they are the two rungs OpenFreeMap could not serve.
 */
export const FONT_STACKS = {
  regular: ['Inter Regular'],
  medium: ['Inter Medium'],
  semibold: ['Inter SemiBold'],
  bold: ['Inter Bold'],
} as const satisfies Record<string, readonly AvailableFont[]>;
