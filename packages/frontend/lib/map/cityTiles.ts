/**
 * GoWay's per-building 3D city tiles: the schema the compiler writes and the
 * city-3D engine reads.
 *
 * The compiler is `scripts/build-city-tiles.ts`; the reader is
 * `components/map/engine/city3d/osmTiles.ts`, inside the mesh Web Worker. This
 * module is the one both import, so a renamed property or a new roof shape is
 * one edit here and a failing round-trip test (`__tests__/cityTiles.test.ts`)
 * everywhere else. It is pure data — no geometry, no renderer.
 *
 * ## Why Mapbox Vector Tiles, with a schema of our own
 *
 * The two reference projects (Valdrada, Procedural Tokyo) each invented a
 * binary tile. GoWay does not need to, and there are three reasons to prefer
 * MVT v2 with a custom layer:
 *
 *  1. **Native can draw it with no code.** `docs/MAP_3D_CITY.md` → "Native":
 *     MapLibre Native has no custom layer, so native's route to per-building
 *     3D is a `fill-extrusion` over a vector source that is NOT unioned. These
 *     tiles are exactly that source — `render_height`/`render_min_height` keep
 *     OpenMapTiles' names and meaning so the existing `building-3d` expressions
 *     apply unchanged, and `colour` is a CSS string MapLibre can read.
 *  2. **The reader already ships.** The web worker decodes OpenMapTiles with
 *     `pbf` + `@mapbox/vector-tile`; the same two packages decode these, so the
 *     second source mode costs the worker bundle no new dependency.
 *  3. **Size is not where MVT loses.** A custom format would save the key/value
 *     tables, which MVT already dedupes per tile, and gzip closes most of the
 *     rest (measured sizes are in the doc). What a custom format WOULD buy is
 *     pre-meshed geometry — and that is a different trade (several times the
 *     bytes, in exchange for no client meshing) that this phase deliberately
 *     does not make.
 *
 * The format stays INTERNAL all the same (AGENTS.md: never a public contract):
 * the SDK draws maps through `MapCanvas`, and no third party is promised these
 * property names.
 *
 * ## Addressing: one zoom, whole buildings
 *
 * Tiles exist at {@link CITY_TILE_ZOOM} only; the client over-zooms them for
 * every zoom the city layer draws at, exactly as it does the basemap's z14.
 * Each building is written to exactly ONE tile — the one holding its
 * representative point — WHOLE and UNCLIPPED, so its coordinates may run past
 * the tile's `[0, extent]` square. That is legal MVT, and it is what makes a
 * roof right: a gabled roof's ridge depends on the whole footprint, and a
 * building cut at a tile edge would get two different ridges, one per half.
 * It also removes the fake walls along clip lines the OpenMapTiles mesher has
 * to suppress.
 *
 * ## Honesty, in the schema
 *
 * Properties are RECORDED facts, normalised (`height`, `levels`, roof shape,
 * colours, materials), plus two RESOLVED numbers (`render_height`,
 * `render_min_height`) computed with OpenMapTiles' own rules so the two
 * sources agree on every untagged building. A property is ABSENT when OSM does
 * not record it; nothing here is a guess dressed as data. In particular
 * `levels` is present only where `building:levels` was tagged, which is what
 * lets the client draw window rows only where floors are real.
 */

/** The zoom every city tile is cut at. See the module header and the doc for why 15. */
export const CITY_TILE_ZOOM = 15;

/** MVT extent: tile units per side. At z15 over Barcelona one unit is ~0.22 m. */
export const CITY_TILE_EXTENT = 4096;

/** The single source-layer every city tile carries. */
export const CITY_TILE_LAYER = 'building';

/** Bumped when a property changes meaning; written into the archive's metadata. */
export const CITY_TILE_SCHEMA_VERSION = 1;

/**
 * Where a browser fetches city tiles, relative to the page's own origin.
 *
 * In development the Metro server answers it from a local archive
 * (`metro.config.js`, `GOWAY_CITY_TILES_ARCHIVE`); in production nothing does
 * yet — `docs/MAP_3D_CITY.md` → "Hosting" lists what the Worker needs. Not in
 * `GOWAY_MAP_PATHS` (`provider.ts`) on purpose: that module is in the first
 * paint bundle, and this path is read only by the lazily loaded city layer.
 */
export const CITY_TILE_PATH = '/map/city/{z}/{x}/{y}.pbf';

/**
 * Metres per storey, and the height of a building OSM records nothing about —
 * OpenMapTiles' own numbers (`building:levels × 3.66`, else 5 m), so a building
 * with no tags stands exactly as tall here as it does in the basemap.
 */
export const METRES_PER_LEVEL = 3.66;
export const UNKNOWN_HEIGHT_M = 5;

/** The feature properties, by name. Every one is optional except the two `render_*`. */
export const CITY_PROPS = {
  /** Resolved total height in metres, roof included (always present). */
  renderHeight: 'render_height',
  /** Resolved base height in metres (always present; 0 on the ground). */
  renderMinHeight: 'render_min_height',
  /** `height`, parsed, when tagged. */
  height: 'height',
  /** `building:levels`, when tagged: storeys above ground, roof storeys excluded. */
  levels: 'levels',
  /** `building:min_level`, when tagged. */
  minLevel: 'min_level',
  /** `roof:shape`, normalised to {@link ROOF_SHAPES}, when tagged and recognised. */
  roofShape: 'roof_shape',
  /** Roof height in metres for a shaped roof: tagged, from `roof:levels`, or from the pitch. */
  roofHeight: 'roof_height',
  /** Where {@link CITY_PROPS.roofHeight} came from — `tag`, `levels`, `angle` or `default`. */
  roofHeightSource: 'roof_height_source',
  /** `roof:direction` as a compass bearing in degrees: the way the slope FACES. */
  roofDirection: 'roof_direction',
  /** `roof:orientation` — only `across` is written; `along` is the default. */
  roofOrientation: 'roof_orientation',
  /** `building:colour`, normalised to `#rrggbb`. */
  colour: 'colour',
  /** `roof:colour`, normalised to `#rrggbb`. */
  roofColour: 'roof_colour',
  /** `building:material`, normalised to {@link WALL_MATERIALS}. */
  material: 'material',
  /** `roof:material`, normalised to {@link ROOF_MATERIALS}. */
  roofMaterial: 'roof_material',
  /** `true` for a `building:part`. */
  part: 'part',
} as const;

/**
 * Roof shapes the client can build, by their OSM name (Simple 3D Buildings).
 * Anything else — including a tagged shape that is not in this list — draws
 * flat, which is also what an untagged roof does.
 */
export const ROOF_SHAPES = [
  'flat',
  'skillion',
  'gabled',
  'half-hipped',
  'hipped',
  'pyramidal',
  'gambrel',
  'mansard',
  'saltbox',
  'round',
  'dome',
  'onion',
  'cone',
] as const;

export type RoofShape = (typeof ROOF_SHAPES)[number];

/** `building:material` values the renderer has a colour for. */
export const WALL_MATERIALS = [
  'brick',
  'concrete',
  'glass',
  'stone',
  'sandstone',
  'limestone',
  'marble',
  'plaster',
  'wood',
  'metal',
  'steel',
  'timber_framing',
  'mud',
  'adobe',
] as const;

export type WallMaterial = (typeof WALL_MATERIALS)[number];

/** `roof:material` values the renderer has a colour for. */
export const ROOF_MATERIALS = [
  'roof_tiles',
  'slate',
  'concrete',
  'metal',
  'copper',
  'glass',
  'tar_paper',
  'gravel',
  'grass',
  'thatch',
  'wood',
  'stone',
  'asbestos',
  'plastic',
  'solar_panels',
] as const;

export type RoofMaterial = (typeof ROOF_MATERIALS)[number];

/**
 * The second source-layer: trees OpenStreetMap records (`natural=tree`), as
 * points. Like the buildings, every property is a RECORDED fact and absent
 * when OSM does not record it; the client draws an unknown crown as broadleaf
 * and an unknown height at a typical size, and says so (`docs/MAP_3D_CITY.md`
 * → "Trees").
 */
export const CITY_TREE_LAYER = 'tree';

/** Crown forms the client can draw. */
export const TREE_CROWNS = ['broadleaf', 'conifer', 'palm'] as const;

export type TreeCrown = (typeof TREE_CROWNS)[number];

/** The tree properties, by name. All optional. */
export const CITY_TREE_PROPS = {
  /**
   * {@link TREE_CROWNS}: from `leaf_type` (`needleleaved` → conifer,
   * `broadleaved` → broadleaf) or a recognised `genus` / `species` / `taxon`.
   */
  crown: 'crown',
  /** `height`, parsed, metres. */
  height: 'height',
  /** `diameter_crown`, parsed, metres. */
  crownDiameter: 'crown_diameter',
} as const;

/** One tree as the compiler writes it: a point in tile units and its properties. */
export interface CityTileTree {
  /** The OSM node id: the tree's own stable seed (turn, variant). */
  id: number;
  point: [number, number];
  properties: { crown?: TreeCrown; height?: number; crown_diameter?: number };
}

/** The `{z}/{x}/{y}` template expanded for one tile. */
export function cityTileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
