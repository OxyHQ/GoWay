/**
 * Which OpenStreetMap elements are POIs, and what GoWay calls them.
 *
 * ## The set has to be at least what the basemap already draws
 *
 * GoWay's tiles are built by Planetiler against the OpenMapTiles schema, and
 * the map's `poi-*` layers draw that schema's `poi` source-layer. Once those
 * layers are switched off — a separate change, after this data lands — every
 * shop, bar and museum a user can see today has to come from `places` instead.
 * So the set imported here must be a SUPERSET of the set the tiles draw, or
 * that change silently deletes places from the map.
 *
 * Two decisions make that a property rather than a hope:
 *
 *  1. **Inclusion is by KEY, not by value.** OpenMapTiles' `poi.yaml` lists
 *     specific values for `amenity`, `shop`, `tourism`, `leisure`, `historic`,
 *     `office` and `sport`. Reproducing those lists from memory or from a
 *     pinned copy would make coverage depend on a list going stale as
 *     OpenStreetMap gains tags. {@link POI_MAPPING_KEYS} accepts ANY value for
 *     those keys, so the imported set contains OpenMapTiles' whitelist by
 *     construction and keeps containing it as the whitelist grows. Only the
 *     keys whose other values are emphatically not places — `landuse`,
 *     `building`, `highway`, `railway`, `waterway`, `aerialway`, `barrier` —
 *     carry an explicit value list, because `landuse=residential` with a name
 *     is a neighbourhood, not a POI.
 *
 *  2. **A POI must have a name.** Every one of the three `poi-*` filters in
 *     `packages/frontend/lib/map/style/layers.ts` carries `['has', 'name']`, so
 *     an unnamed POI is in the tile and is never drawn. `places.name` is NOT
 *     NULL for its own reasons, and the two agree: requiring a name here loses
 *     nothing the map shows and keeps several million unnamed benches, gates
 *     and parking spaces out of a table about places.
 *
 * ## And it is deliberately a little less, in exactly one place
 *
 * {@link CLUTTER_CLASSES} is copied from `POI_CLUTTER_CLASSES` in that same
 * `layers.ts`: bollards, gates, waste baskets, station entrances. Those classes
 * are excluded from all three POI layers, so the basemap draws NONE of them and
 * importing them would add rows the map never had, each of which is a
 * duplicate-candidate and a search result for something that is not a place. A
 * named gate is not a place. This is the one intentional gap between "what the
 * tiles contain" and "what GoWay imports", and it is on the side of the tiles
 * that is already invisible.
 *
 * Station entrances deserve their own line. `layers.ts` filters metro entrances
 * out with `agg_stop` so "Passeig de Gràcia" is drawn once rather than four
 * times; the same four entrances imported here would be four `places` rows and
 * three duplicate candidates for a reviewer. Excluding `entrance` does that job
 * at the source.
 */

/**
 * The tag keys that make an element a POI, in precedence order, each with the
 * values it accepts.
 *
 * `'any'` means the key alone qualifies the element — see the file docblock.
 * Order decides which key names the POI when an element carries several:
 * `amenity` and `shop` before `tourism` so a restaurant that is also tagged
 * `tourism=attraction` is a restaurant, and the narrow keys last so a museum in
 * a `historic=building` is a museum.
 */
export const POI_MAPPING_KEYS: readonly (readonly [string, 'any' | readonly string[]])[] = [
  ['amenity', 'any'],
  ['shop', 'any'],
  ['tourism', 'any'],
  ['leisure', 'any'],
  ['historic', 'any'],
  ['office', 'any'],
  ['craft', 'any'],
  ['sport', 'any'],
  ['railway', ['halt', 'station', 'subway_entrance', 'train_station_entrance', 'tram_stop']],
  ['aerialway', ['station']],
  ['highway', ['bus_stop']],
  ['landuse', ['basin', 'brownfield', 'cemetery', 'reservoir', 'winter_sports']],
  ['building', ['dormitory']],
  ['waterway', ['dock']],
  [
    'barrier',
    [
      'bollard',
      'border_control',
      'cycle_barrier',
      'gate',
      'lift_gate',
      'sally_port',
      'stile',
      'toll_booth',
    ],
  ],
];

/**
 * Values that qualify nothing, whatever key carries them.
 *
 * `no` is a negation. `yes` is the one that costs something: a Spain extract has
 * thousands of named elements tagged `tourism=yes` or `historic=yes`, and each
 * would become a place whose only category is the string `yes` — noise in a
 * published contract, and a category facet nobody can mean. The element is
 * skipped rather than filed under a category that says nothing.
 */
const NON_CLASSIFYING_VALUES: ReadonlySet<string> = new Set(['no', 'yes', '']);

/** Fast membership test for "is this key one that can make a POI". */
const MAPPING_KEY_VALUES = new Map<string, 'any' | ReadonlySet<string>>(
  POI_MAPPING_KEYS.map(([key, values]) => [key, values === 'any' ? 'any' : new Set(values)]),
);

/** Mapping keys in precedence order — see {@link POI_MAPPING_KEYS}. */
const MAPPING_KEY_ORDER = POI_MAPPING_KEYS.map(([key]) => key);

/**
 * Classes the basemap draws NOWHERE, copied from `POI_CLUTTER_CLASSES` in
 * `packages/frontend/lib/map/style/layers.ts`.
 *
 * Copied rather than imported: the backend does not depend on the frontend
 * package and must not start to for a list of nineteen strings. The copy is
 * held honest by `poiTags.test.ts`, which asserts a representative tag for each
 * of them is refused.
 */
const CLUTTER_CLASSES: ReadonlySet<string> = new Set([
  'bollard',
  'border_control',
  'brownfield',
  'bicycle_parking',
  'cycle_barrier',
  'drinking_water',
  'entrance',
  'gate',
  'lift_gate',
  'motorcycle_parking',
  'multi',
  'recycling',
  'sally_port',
  'shelter',
  'stile',
  'telephone',
  'toll_booth',
  'waste_basket',
]);

/**
 * OpenMapTiles' `poi_class` grouping: several subclasses that share a pin.
 *
 * Reproduced because the `class` is what `categories` is built from and what
 * every later filter — "coffee near me", a category facet, the pin colour a
 * GoWay-drawn POI layer will need — reads. Where a subclass is not listed the
 * class IS the subclass, which is OpenMapTiles' own fallback and keeps a tag
 * this table has never heard of as a usable category rather than as `other`.
 */
const CLASS_BY_SUBCLASS = new Map<string, string>(
  (
    [
      ['shop', ['accessories', 'antiques', 'beauty', 'bed', 'boutique', 'camera', 'carpet', 'charity', 'chemist', 'copyshop', 'curtain', 'department_store', 'doityourself', 'dry_cleaning', 'electronics', 'erotic', 'fabric', 'florist', 'frame', 'furniture', 'garden_centre', 'gift', 'hardware', 'hearing_aids', 'hifi', 'houseware', 'interior_decoration', 'jewelry', 'kiosk', 'lamps', 'mall', 'massage', 'mobile_phone', 'newsagent', 'optician', 'outdoor', 'paint', 'perfume', 'perfumery', 'pet', 'photo', 'second_hand', 'shoes', 'sports', 'stationery', 'tailor', 'tattoo', 'ticket', 'tobacco', 'toys', 'travel_agency', 'variety_store', 'video', 'video_games', 'watches', 'weapons', 'wholesale']],
      ['town_hall', ['townhall', 'public_building', 'courthouse', 'community_centre']],
      ['golf', ['golf', 'golf_course', 'miniature_golf']],
      ['fast_food', ['fast_food', 'food_court']],
      ['park', ['park', 'bbq']],
      ['bus', ['bus_stop', 'bus_station']],
      ['railway', ['halt', 'tram_stop', 'subway']],
      ['entrance', ['subway_entrance', 'train_station_entrance']],
      ['campsite', ['camp_site', 'caravan_site']],
      ['laundry', ['laundry', 'dry_cleaning']],
      ['grocery', ['supermarket', 'deli', 'delicatessen', 'greengrocer', 'marketplace', 'convenience']],
      ['library', ['books', 'library']],
      ['college', ['university', 'college']],
      ['lodging', ['hotel', 'motel', 'bed_and_breakfast', 'guest_house', 'hostel', 'dormitory', 'chalet', 'alpine_hut']],
      ['ice_cream', ['chocolate', 'confectionery', 'ice_cream', 'pastry']],
      ['post', ['post_box', 'post_office', 'parcel_locker']],
      ['cafe', ['cafe', 'coffee']],
      ['school', ['school', 'kindergarten']],
      ['alcohol_shop', ['alcohol', 'beverages', 'wine']],
      ['bar', ['bar', 'nightclub']],
      ['harbor', ['marina', 'dock']],
      ['car', ['car', 'car_repair', 'car_parts', 'taxi']],
      ['hospital', ['hospital', 'nursing_home', 'clinic']],
      ['cemetery', ['grave_yard', 'cemetery']],
      ['attraction', ['attraction', 'viewpoint']],
      ['beer', ['pub', 'biergarten']],
      ['music', ['music', 'musical_instrument']],
      ['stadium', ['stadium', 'american_football', 'soccer']],
      ['art_gallery', ['art', 'artwork', 'gallery', 'arts_centre']],
      ['clothing_store', ['clothes', 'bag']],
      ['swimming', ['swimming', 'swimming_area']],
      ['castle', ['castle', 'ruins']],
      ['monument', ['monument', 'memorial']],
    ] as const
  ).flatMap(([className, subclasses]) => subclasses.map((subclass) => [subclass, className] as [string, string])),
);

/**
 * The coarse category each class rolls up into.
 *
 * The same ten groups `POI_GROUPS` in `layers.ts` colours by, for the same
 * reason they exist there: a class is what a place IS and a group is what a
 * person is looking for. It is the third and least specific entry in
 * {@link poiCategories}, which is what makes `?categories=food_drink` a usable
 * filter without the caller enumerating forty subclasses.
 *
 * A class in no group contributes no group — `categories` is shorter rather
 * than carrying a meaningless `other`.
 */
const GROUP_BY_CLASS = new Map<string, string>(
  (
    [
      ['food_drink', ['restaurant', 'fast_food', 'cafe', 'bar', 'beer', 'ice_cream']],
      ['shopping', ['shop', 'clothing_store', 'grocery', 'alcohol_shop', 'bakery', 'butcher', 'hairdresser', 'laundry']],
      ['outdoors', ['park', 'garden', 'playground', 'pitch', 'dog_park', 'picnic_site', 'golf', 'zoo', 'sports_centre', 'stadium', 'swimming_pool', 'swimming', 'ice_rink', 'athletics', 'cycling', 'running', 'yoga', 'boxing', 'gymnastics', 'equestrian', 'campsite']],
      ['transit', ['bus', 'railway', 'ferry_terminal', 'aerialway']],
      ['lodging', ['lodging']],
      ['health', ['hospital', 'pharmacy', 'doctors', 'dentist', 'veterinary']],
      ['civic', ['school', 'college', 'library', 'town_hall', 'police', 'fire_station', 'post', 'office', 'bank', 'atm']],
      ['culture', ['museum', 'art_gallery', 'theatre', 'cinema', 'attraction', 'monument', 'castle', 'aquarium', 'music', 'escape_game', 'hackerspace', 'theme_park']],
      ['worship', ['place_of_worship', 'cemetery']],
      ['vehicle', ['parking', 'fuel', 'car', 'bicycle', 'bicycle_rental', 'motorcycle', 'harbor']],
    ] as const
  ).flatMap(([group, classes]) => classes.map((className) => [className, group] as [string, string])),
);

/** What the tags say this element is. */
export interface PoiKind {
  /** The tag key that qualified it — `amenity`, `shop`, … */
  mappingKey: string;
  /** That key's value — `restaurant`, `bakery`, … */
  subclass: string;
  /** The OpenMapTiles-compatible class the subclass rolls up into. */
  className: string;
}

/** Whether `key` can qualify an element at all — the cheap test a tag scan runs first. */
export function isPoiMappingKey(key: string): boolean {
  return MAPPING_KEY_VALUES.has(key);
}

/**
 * What kind of POI these tags describe, or `null` if they describe none.
 *
 * Returns `null` for an element with no qualifying tag AND for one whose class
 * the basemap never draws — see {@link CLUTTER_CLASSES}. A caller cannot tell
 * the two apart and does not need to: neither becomes a place.
 */
export function classifyPoi(tags: ReadonlyMap<string, string>): PoiKind | null {
  for (const key of MAPPING_KEY_ORDER) {
    const value = tags.get(key);
    if (value === undefined || NON_CLASSIFYING_VALUES.has(value)) continue;
    const accepted = MAPPING_KEY_VALUES.get(key);
    if (accepted !== 'any' && !accepted?.has(value)) continue;

    const subclass = value;
    const className = classOf(subclass, key);
    if (CLUTTER_CLASSES.has(className)) return null;
    return { mappingKey: key, subclass, className };
  }
  return null;
}

/**
 * The class for a subclass, disambiguating the values that mean different
 * things under different keys.
 *
 * `station` is the case that matters most: under `railway` it is a train station,
 * under `aerialway` it is a cable-car station, and OpenMapTiles separates them
 * for the same reason the map draws the first at z14 and the second wherever it
 * lands.
 */
function classOf(subclass: string, mappingKey: string): string {
  if (subclass === 'station') return mappingKey === 'aerialway' ? 'aerialway' : 'railway';
  // `office=*` is one class with an open set of subclasses — OpenMapTiles does
  // the same, and the map colours `office` rather than `office=insurance`.
  if (mappingKey === 'office') return 'office';
  return CLASS_BY_SUBCLASS.get(subclass) ?? subclass;
}

/**
 * GoWay's normalized category keys for a POI, MOST SPECIFIC FIRST.
 *
 * Three at most and never fewer than one: the subclass as OpenStreetMap tagged
 * it, the class it rolls up into, and the group a person browses by. Duplicates
 * collapse, so `amenity=cafe` is `['cafe', 'food_drink']` rather than
 * `['cafe', 'cafe', 'food_drink']`.
 */
export function poiCategories(kind: PoiKind): string[] {
  const categories = [kind.subclass, kind.className];
  const group = GROUP_BY_CLASS.get(kind.className);
  if (group) categories.push(group);
  return [...new Set(categories)];
}

/** Exposed for the test that holds the clutter copy honest. */
export const CLUTTER_CLASSES_FOR_TEST: ReadonlySet<string> = CLUTTER_CLASSES;
