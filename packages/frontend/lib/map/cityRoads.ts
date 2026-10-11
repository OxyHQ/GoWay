/**
 * The road layers of GoWay's city tiles: the schema the compiler writes
 * (`scripts/citygen/roads.ts`) and the city-life simulation reads
 * (`components/map/engine/cityLife/roadTiles.ts`).
 *
 * They are cut on the SAME z15 grid as the buildings (`lib/map/cityTiles.ts`)
 * but live in their own archive ({@link CITY_ROAD_TILE_PATH}), as three MVT
 * layers. Why roads come from the compiler and not from the
 * basemap's OpenMapTiles `transportation` layer is measured in
 * `docs/MAP_CITY_LIFE.md` → "Where the road graph comes from": in short, the
 * basemap carries a class and a one-way flag and nothing else a lane graph
 * needs (no lanes, speeds, signals, crossings, sidewalks or turn
 * restrictions), and its lines are merged and simplified so that a third of
 * their ends land on another line's interior and many on nothing at all.
 *
 * ## Topology by position, exactly
 *
 * Every road way is split at each node it shares with another kept way, at
 * every tagged node the simulation uses (signals, crossings, stops), and at
 * every z15 tile edge. Each piece goes to the one tile it lies in, clipped
 * there, so a piece's two ends are graph nodes and nothing else is. A reader
 * joins pieces whose ends have the same GLOBAL tile-unit position
 * (`x + 4096 · tileX`): that integer is the same whichever tile it was
 * written from, because a tile's origin is a whole multiple of the extent.
 * Two distinct OSM nodes closer than one tile unit (~0.2 m at z15) would be
 * joined; nothing else is, and a bridge over a street shares no node with it,
 * so it never joins one.
 *
 * ## Recorded, never invented
 *
 * As with the buildings, a property is present only when OSM records it.
 * `lanes`, `maxspeed` and `sidewalk` are absent on most ways; the simulation
 * supplies its own defaults per class, and those defaults are SIMULATION
 * parameters, not facts about the street, which is why they live in the
 * simulation and not here.
 *
 * The format is internal (AGENTS.md: never a public contract).
 */

/**
 * Where a browser fetches road tiles, relative to the page's own origin. A
 * SEPARATE archive from the buildings (`CITY_TILE_PATH`): measured on
 * Barcelona, the road layers would add +72% to every building tile's gzip,
 * paid by everyone who draws 3D buildings for a simulation few turn on. In
 * development the Metro server answers it from a local archive
 * (`scripts/dev-city-tiles.js`), as it does the buildings.
 */
export const CITY_ROAD_TILE_PATH = '/map/city-roads/{z}/{x}/{y}.pbf';

/** Bumped when a property changes meaning; written into the archive's metadata. */
export const CITY_ROAD_SCHEMA_VERSION = 1;

/** The archive metadata key that says which kind of city archive a file is. */
export const CITY_ARCHIVE_KIND_KEY = 'goway:kind';

/** Road pieces: LineStrings, one OSM way between two graph nodes, within one tile. */
export const CITY_ROAD_LAYER = 'road';

/** Tagged nodes on road pieces (always a piece end): signals, crossings, stops. */
export const CITY_ROAD_NODE_LAYER = 'road_node';

/** Turn restrictions whose `via` is a node, as a point at that node. */
export const CITY_RESTRICTION_LAYER = 'restriction';

/** `road` feature properties, by name. */
export const ROAD_PROPS = {
  /** The OSM way id (also the feature id) — only on ways a turn restriction names. */
  way: 'way',
  /** The `highway` value, one of {@link ROAD_CLASSES}. */
  highway: 'highway',
  /** `true` when a car may drive it (class, `access`, `motor_vehicle`, `area`). */
  car: 'car',
  /** `true` when a person may walk it (class, `foot`, `access`). */
  foot: 'foot',
  /** `1` or `-1` (against the drawn direction) when one-way for cars; absent: both ways. */
  oneway: 'oneway',
  /** `lanes`, when tagged: all lanes, both directions. */
  lanes: 'lanes',
  /** `lanes:forward`, when tagged. */
  lanesForward: 'lanes_forward',
  /** `lanes:backward`, when tagged. */
  lanesBackward: 'lanes_backward',
  /** `maxspeed` in km/h, when tagged and readable (`mph` converted, `walk` = 6). */
  maxspeed: 'maxspeed',
  /** `sidewalk` normalised to {@link SIDEWALKS}, when tagged. */
  sidewalk: 'sidewalk',
  /** `footway=sidewalk|crossing`, when tagged. */
  footway: 'footway',
  /** `true` for `junction=roundabout|circular`. */
  roundabout: 'roundabout',
  /** `true` for `tunnel=yes|building_passage` or `covered=yes`: drawn hidden. */
  tunnel: 'tunnel',
} as const;

/** `road_node` feature properties. */
export const ROAD_NODE_PROPS = {
  /** One of {@link ROAD_NODE_KINDS}. */
  kind: 'kind',
  /** `crossing=*` on a crossing node, when tagged. */
  crossing: 'crossing',
} as const;

/** `restriction` feature properties. */
export const RESTRICTION_PROPS = {
  /** The `from` way id. */
  from: 'from',
  /** The `to` way id. */
  to: 'to',
  /** `no` (`no_*` restrictions) or `only` (`only_*`). */
  type: 'type',
} as const;

/** Classes the compiler keeps. Anything else is not a road (rail, construction, proposed…). */
export const ROAD_CLASSES = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'road',
  'pedestrian',
  'footway',
  'path',
  'steps',
  'cycleway',
  'track',
] as const;

export type RoadClass = (typeof ROAD_CLASSES)[number];

export const SIDEWALKS = ['both', 'left', 'right', 'no', 'separate'] as const;
export type Sidewalk = (typeof SIDEWALKS)[number];

export const ROAD_NODE_KINDS = ['signals', 'crossing', 'stop', 'give_way'] as const;
export type RoadNodeKind = (typeof ROAD_NODE_KINDS)[number];
