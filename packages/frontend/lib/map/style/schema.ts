/**
 * The **OpenMapTiles v3 vector schema**, as OpenFreeMap actually serves it.
 *
 * This file is the reason a GoWay-owned style document is possible without
 * changing tile providers: the cartography is ours, the *schema* is not, and a
 * style can only name layers, fields and values the tiles really contain. A
 * wrong `source-layer` is the worst kind of mistake here — MapLibre renders
 * nothing, logs nothing and throws nothing, so a typo ships as an empty map.
 *
 * Everything below was read off the live endpoints rather than remembered:
 *
 *  - The source-layer names and their fields come from the TileJSON at
 *    `https://tiles.openfreemap.org/planet` (`vector_layers[].id` / `.fields`).
 *  - The `class` vocabularies come from **decoding real `.pbf` tiles** at z6,
 *    z10 and z14 over Madrid, Manhattan, Tokyo, Barcelona, London and open
 *    countryside, and collecting the distinct values that actually appear.
 *    That is why, for example, `street` and `street_limited` are absent: they
 *    are Mapbox-schema road classes, and OpenFreeMap's own `liberty` style
 *    carries layers filtering on them that can never match anything.
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
  'bridge',
  'ferry',
  'minor',
  'motorway',
  'path',
  'pier',
  'primary',
  'rail',
  'secondary',
  'service',
  'tertiary',
  'track',
  'transit',
  'trunk',
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
] as const;

/**
 * Glyph fontstacks OpenFreeMap's font server actually answers with.
 *
 * Checked, not assumed: `Noto Sans Medium` and `Noto Sans SemiBold` both 404,
 * so the weight ladder available to this style is Regular and Bold and nothing
 * in between. MapLibre requests a *combined* stack when a `text-font` names
 * more than one family, and OpenFreeMap does not serve combined stacks, so
 * every `text-font` in this style is a single-element array.
 */
export const AVAILABLE_FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'] as const;

export type AvailableFont = (typeof AVAILABLE_FONTS)[number];
