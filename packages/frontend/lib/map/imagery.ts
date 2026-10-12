/**
 * GoWay's satellite imagery: the two ways a map can draw it, the zoom tiers it
 * is served in, and the sources it may be made of (`docs/MAP_SATELLITE.md`).
 *
 * ## The contract with the style system
 *
 * Imagery is a STYLE, not a layer a screen adds: `satellite` is the imagery
 * alone, `hybrid` is the imagery under GoWay's own roads, boundaries and
 * labels. Both are generated style documents (`lib/map/style/imagery.ts`,
 * written by `scripts/build-map-style.ts` beside the light and dark ones), so
 * a style picker chooses one by URL (`resolveMapStyleUrl(appearance, mode)`)
 * and both engines — maplibre-gl and MapLibre Native, which can only take a
 * URL — draw exactly the same document. `MapCanvas` takes the choice as its
 * `imagery` prop and draws the per-source credit itself.
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

export const MAP_IMAGERY_MODES: readonly MapImageryMode[] = ['satellite', 'hybrid'];

export function isMapImageryMode(value: unknown): value is MapImageryMode {
  return value === 'satellite' || value === 'hybrid';
}

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

/**
 * The mode this page draws: the screen's `imagery` prop when it passes one
 * (`null` is "no imagery"); otherwise, in a DEVELOPMENT build only,
 * `?imagery=satellite|hybrid` in the page's address — the same per-tab rule
 * as the map features (`mapFeatures.ts` → `pageOverride`), so a goway.to link
 * never changes what somebody else's map draws.
 */
export function resolveImageryMode(
  requested: MapImageryMode | null | undefined,
  page: { development: boolean; search: string },
): MapImageryMode | null {
  if (requested !== undefined) return isMapImageryMode(requested) ? requested : null;
  if (!page.development) return null;
  const value = new URLSearchParams(page.search).get('imagery');
  return isMapImageryMode(value) ? value : null;
}
