/**
 * The official-data half of GoWay's city-tile schema: the layer of surfaces
 * an official building dataset contributes, their properties, and the
 * datasets a tile may carry with the credit each requires while drawn
 * (`docs/MAP_3D_SOURCES.md`). The OSM half is `cityTiles.ts`.
 *
 * A module of its own for the FIRST-PAINT bundle: `cityTiles.ts` is shared by
 * several lazy chunks and so lives in `__common`, which every page downloads;
 * these constants are read only by the city-3D adapter, the mesh worker and
 * the compiler, and stay in their chunks (measured: inlined in `cityTiles.ts`
 * they put 804 B on every first paint).
 */

/**
 * The second source-layer: roof surfaces of an official 3D building model
 * (LOD2 / LOD1.x), conflated with OSM by the compiler. One feature per PLANAR
 * roof surface — the client raises walls from every edge down to the ground or
 * to a lower neighbouring roof (`lod2Mesher.ts`), so walls are never stored.
 * Absent from a tile no official model covers.
 */
export const CITY_TILE_LOD2_LAYER = 'building_lod2';

/**
 * Properties of a {@link CITY_TILE_LOD2_LAYER} feature. Also carried:
 * `render_height`, the surface's highest point, with `CITY_PROPS`'
 * meaning (and no `render_min_height`, which reads as 0), so a
 * `fill-extrusion` can draw the layer as stepped blocks unchanged.
 *
 * A FLAT roof (95% of NYC's) is just that: its plane is `render_height`
 * everywhere. A sloped one adds its plane,
 * `h(x, y) = roof_h + roof_dx·(x − x0) + roof_dy·(y − y0)` in metres above the
 * building's ground, with `x, y` in tile units and `(x0, y0)` the minimum
 * corner of the feature's exterior ring AS ENCODED (integers the decoder reads
 * back exactly, whatever order the ring was written in).
 */
export const CITY_LOD2_PROPS = {
  /** Which dataset: a {@link CITY_LOD2_SOURCES} key. Always present. */
  source: 'source',
  /** The dataset's own building identifier (NYC: BIN), for provenance. */
  sourceId: 'source_id',
  /** The OSM feature (`osmId × 10 + 2|3`) the building overlapped most. */
  osmId: 'osm_id',
  /** Plane height in metres above ground at `(x0, y0)`; absent on a flat roof. */
  roofH: 'roof_h',
  /** Plane slope in metres per tile unit along `x` / `y`; absent on a flat roof. */
  roofDx: 'roof_dx',
  roofDy: 'roof_dy',
  /** Storeys above ground the source records for this surface's volume (the cadastre's). */
  levels: 'levels',
} as const;

/**
 * Official 3D building datasets a city tile may carry, and the credit each
 * requires WHILE ITS SURFACES ARE DRAWN (`MapAttribution` shows it then and
 * only then). Licences and verdicts: `docs/MAP_3D_SOURCES.md`. Adding a source
 * here is a licence decision first and a code change second.
 */
export const CITY_LOD2_SOURCES = {
  'nyc-3dbm': {
    label: 'NYC 3D Building Model (modified)',
    href: 'https://data.cityofnewyork.us/d/tnru-abg2',
  },
  // The cadastre's terms: name the Directorate General as author and owner,
  // and never present the result as cadastral cartography.
  'es-catastro': {
    label: 'Dirección General del Catastro',
    href: 'https://www.catastro.hacienda.gob.es/',
  },
} as const satisfies Record<string, { label: string; href: string }>;

export type CityLod2Source = keyof typeof CITY_LOD2_SOURCES;

/**
 * Properties the compiler adds to an OSM feature of the `building` layer
 * when official data covers it (beside `height_source`, which is in
 * `CITY_PROPS` because OSM-only tiles carry it too).
 */
export const CITY_OFFICIAL_PROPS = {
  /**
   * Set when official data draws this building instead (the value is the
   * {@link CITY_LOD2_SOURCES} id): the client skips the feature and draws that
   * source's surfaces from {@link CITY_TILE_LOD2_LAYER}. The OSM feature keeps
   * every property — this records a rendering decision, never a correction
   * of OSM (`scripts/citygen/lod2/conflate.ts`).
   */
  drawnBy: 'drawn_by',
  /**
   * Storeys above ground as the official cadastre records them, when it set
   * the height (`height_source: cadastre`). The client draws the storey
   * rhythm from it in preference to `levels`.
   */
  officialLevels: 'official_levels',
} as const;
