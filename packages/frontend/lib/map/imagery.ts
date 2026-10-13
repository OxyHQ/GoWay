/**
 * GoWay's satellite imagery: the two ways a map can draw it, the zoom tiers it
 * is served in, and the sources it may be made of (`docs/MAP_SATELLITE.md`).
 *
 * ## Imagery is a style
 *
 * `satellite` (the imagery alone) and `hybrid` (the imagery under GoWay's
 * roads, boundaries and labels) are entries of the style catalogue
 * (`lib/map/style/catalogue.ts`), chosen in the one layers picker and drawn
 * from documents the one engine renders (`lib/map/style/imagery.ts`). Both
 * engines load them by URL like every other style; `MapCanvas` credits each
 * imagery source while it is on screen.
 *
 * ## Tiers
 *
 * One raster source cannot both stop at the global mosaic's 10 m and reach a
 * city's 25 cm: MapLibre requests every tile of a source up to its `maxzoom`,
 * and a tile nobody has is drawn as nothing, not as its parent. So the
 * imagery is served in tiers, one raster layer each, the finer above:
 *
 * - `base`, z0–13: the whole planet (a Sentinel-2 mosaic over a global
 *   ocean), and over-zoomed by MapLibre beyond 13 wherever nothing finer is;
 * - `detail`, z12–18: national and regional orthophotos (15–50 cm), only
 *   where one is published — elsewhere the Worker answers 404 from the
 *   manifest without touching storage, and the base shows through;
 * - `fine`, z19–20: the 5–12 cm orthophotos some countries and cities fly,
 *   over the detail tier's z18 over-zoomed. A 25 cm source never answers
 *   here, so where only it exists the reader sees it over-zoomed rather than
 *   the blurrier base.
 *
 * Within a tier the Worker picks, per tile, the best published set that has
 * it (`worker/satellite.js`). Tiles are 512 px WebP with alpha, so the edge
 * of an orthophoto is a pixel edge, not a tile edge.
 *
 * Pure and dependency-free: it is in the first-paint bundle, because the map
 * reads the mode before it draws.
 */

/** How the map draws imagery: alone, or under GoWay's roads and labels. */
export type MapImageryMode = 'satellite' | 'hybrid';

/** The two tiers, by zoom (see the module docs). Fixed: the style documents and the Worker share them. */
export const IMAGERY_TIERS = {
  base: { id: 'base', minZoom: 0, maxZoom: 13 },
  detail: { id: 'detail', minZoom: 12, maxZoom: 18 },
  fine: { id: 'fine', minZoom: 19, maxZoom: 20 },
} as const;

export type ImageryTierId = keyof typeof IMAGERY_TIERS;

/** Bottom to top: the order the layers are drawn in. */
export const IMAGERY_TIER_IDS: readonly ImageryTierId[] = ['base', 'detail', 'fine'];

export function isImageryTierId(value: unknown): value is ImageryTierId {
  return value === 'base' || value === 'detail' || value === 'fine';
}

/** Every source and layer the imagery styles add starts with this. */
export const IMAGERY_ID_PREFIX = 'goway:imagery:';

/** Is this one of the imagery sources or layers? */
export function isImageryId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith(IMAGERY_ID_PREFIX);
}

/** Pixels a side of every imagery tile. */
export const IMAGERY_TILE_SIZE = 512;

/** What the client reads to know which sets are published, and where (`worker/satellite.js`). */
export const IMAGERY_COVERAGE_PATH = '/map/satellite/coverage.json';

/** A tier's `{z}/{x}/{y}` path on GoWay's origin. */
export function imageryTilePath(tier: ImageryTierId): string {
  return `/map/satellite/${tier}/{z}/{x}/{y}.webp`;
}
