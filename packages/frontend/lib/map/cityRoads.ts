/**
 * The road layers of GoWay's city tiles: the schema the compiler writes
 * (`scripts/citygen/roads.ts`) and the city-life simulation reads
 * (`components/map/engine/roads/roadTiles.ts`).
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

/**
 * Bumped when a property changes meaning or the street properties grow;
 * written into the archive's metadata. 2: the street-detail properties
 * ({@link STREET_PROPS}, {@link STREET_NODE_PROPS}) — additive, so a v1 reader
 * (the simulation) reads a v2 tile unchanged, and a v1 archive draws the
 * generic class markings only (`docs/MAP_STREETS.md`). 3: `change:lanes`
 * ({@link STREET_PROPS} `changeLanes*`) and separate cycleways
 * (`ROAD_PROPS.cycle`, kept for drawing; the simulation skips them) — additive.
 */
export const CITY_ROAD_SCHEMA_VERSION = 3;

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
  /**
   * `true` on a `highway=cycleway` (schema 3): a separate cycle track, kept so
   * the street detail can draw it even where neither cars nor people may use
   * it (the simulation reads only `car` and `foot`).
   */
  cycle: 'cycle',
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

/**
 * `road` feature properties the street-detail renderer reads
 * (`docs/MAP_STREETS.md`), schema 2. Each is present only when OSM records it
 * in a form the compiler could read; a value it could not is refused and
 * counted in the receipt, never coerced.
 */
export const STREET_PROPS = {
  /** `name`: the local-language name, as `places.name` (never `name:<lang>`). */
  name: 'name',
  /** `width` of the carriageway, metres (`ft`/`'` converted). */
  width: 'width',
  /** `turn:lanes`, normalised: lanes `|`, values `;`, each one of {@link TURNS}. */
  turnLanes: 'turn_lanes',
  turnLanesForward: 'turn_lanes_forward',
  turnLanesBackward: 'turn_lanes_backward',
  /**
   * `bus:lanes`/`psv:lanes` (and `:forward`/`:backward`) as one character per
   * lane, in the tag's own order: `b` designated for buses, `-` anything else.
   */
  busLanes: 'bus_lanes',
  busLanesForward: 'bus_lanes_forward',
  busLanesBackward: 'bus_lanes_backward',
  /** A bus lane on a side, from `busway*=lane` (`busway=lane`: `both`). One of {@link SIDES}. */
  busway: 'busway',
  /** `lanes:bus`/`lanes:psv` counts, when tagged. */
  lanesBus: 'lanes_bus',
  lanesBusForward: 'lanes_bus_forward',
  lanesBusBackward: 'lanes_bus_backward',
  /** A painted cycle lane ON the carriageway, from `cycleway*=lane|opposite_lane`. One of {@link SIDES}. */
  cycleLane: 'cycle_lane',
  /** On-carriageway parking (`parking:lane:*`, `parking:*=lane`). One of {@link SIDES}. */
  parking: 'parking',
  /** `sidewalk:width` (or `sidewalk:both|left|right:width`), metres. */
  sidewalkWidth: 'sidewalk_width',
  /** `true` for `bridge=*` other than `no`: drawn by the basemap only. */
  bridge: 'bridge',
  /** `crossing=*` on a `footway=crossing` way. */
  crossing: 'crossing',
  /** `crossing:markings=*` on a `footway=crossing` way (or the node, below). */
  crossingMarkings: 'crossing_markings',
  /**
   * `change:lanes` (and `:forward`/`:backward`): per lane, in the tag's order,
   * where its traffic may change lanes — `y` either way, `n` neither, `l` only
   * to the left (`not_right`), `r` only to the right (`not_left`).
   */
  changeLanes: 'change_lanes',
  changeLanesForward: 'change_lanes_forward',
  changeLanesBackward: 'change_lanes_backward',
} as const;

/** `road_node` feature properties. */
export const ROAD_NODE_PROPS = {
  /** One of {@link ROAD_NODE_KINDS}. */
  kind: 'kind',
  /** `crossing=*` on a crossing node, when tagged. */
  crossing: 'crossing',
} as const;

/** `road_node` properties of schema 2, for the street-detail renderer. */
export const STREET_NODE_PROPS = {
  /** `crossing:markings=*` on a crossing node, lower case. */
  crossingMarkings: 'crossing_markings',
  /** `crossing_ref=*` (`zebra`, `pelican`, …) on a crossing node. */
  crossingRef: 'crossing_ref',
  /** `forward`/`backward`: which way a signal or sign faces (`traffic_signals:direction`, `direction`). */
  direction: 'direction',
} as const;

/** The sides a lane property names, relative to the way's drawn direction. */
export const SIDES = ['left', 'right', 'both'] as const;
export type Side = (typeof SIDES)[number];

/** `turn:lanes` values the compiler keeps (`none` stands for an empty lane). */
export const TURNS = [
  'none',
  'left',
  'slight_left',
  'sharp_left',
  'through',
  'right',
  'slight_right',
  'sharp_right',
  'reverse',
  'merge_to_left',
  'merge_to_right',
] as const;
export type Turn = (typeof TURNS)[number];

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
