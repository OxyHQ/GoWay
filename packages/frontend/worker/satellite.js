/**
 * Satellite imagery at the edge: `/map/satellite/*`, out of per-cell PMTiles
 * archives in R2, chosen per tile by a manifest (`docs/MAP_SATELLITE.md`) —
 * the raster sets of `rasterSets.js`, in three zoom TIERS
 * (`lib/map/imagery.ts`: `base` z0–13, `detail` z12–18, `fine` z19–20).
 *
 *     satellite/<set>/<stamp>/<cellZoom>/<x>/<y>.pmtiles          (+ .receipt.json)
 *
 * For `/map/satellite/<tier>/<z>/<x>/<y>.webp`, the first set (manifest
 * order) whose published cell holds the tile and has it answers. An
 * orthophoto's edge is transparent, and a tile wholly outside its footprint is
 * absent from its archive, so the next set — or nothing, and the tier below
 * shows through — answers instead.
 *
 * | Answer | Meaning |
 * | --- | --- |
 * | 200 | the tile (WebP; the stored bytes, never re-encoded) |
 * | 404 | no published set has it: the client draws the tier below |
 *
 * `MAP_SATELLITE_MANIFEST` names the manifest's key in `MAP_TILES`. Unset,
 * every tile is 404, the coverage document lists no sets (so a style picker
 * offers no imagery) and no request touches storage.
 */

import { MEMORY_BUDGET } from './budget.js';
import { createRasterSets, SET_MANIFEST_TTL, setText, withMethod } from './rasterSets.js';

/** The tiers by zoom — `IMAGERY_TIERS` in `lib/map/imagery.ts`, pinned equal by a test. */
const TIERS = {
  base: { minZoom: 0, maxZoom: 13 },
  detail: { minZoom: 12, maxZoom: 18 },
  fine: { minZoom: 19, maxZoom: 20 },
};

const TILE_PATH = /^\/map\/satellite\/(base|detail|fine)\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.webp$/;

const sets = createRasterSets({
  name: 'satellite',
  prefix: '/map/satellite',
  manifestVariable: 'MAP_SATELLITE_MANIFEST',
  tiers: TIERS,
  budgetBytes: MEMORY_BUDGET.satellite,
});

/** The archive key of one cell of a set entry. */
export const cellArchiveKey = sets.cellArchiveKey;
/** Check a manifest document exactly as the builder writes it (`rasterSets.js`). */
export const parseSatelliteManifest = sets.parseManifest;
/** What a parsed manifest holds in the isolate (`budget.js`). */
export const satelliteManifestBytes = sets.manifestBytes;
/** The sets, in priority order, that may hold tile (tier, z, x, y), with their archive keys. */
export const candidatesFor = sets.candidatesFor;

/** `/map/satellite/<tier>/<z>/<x>/<y>.webp`. */
export async function serveSatelliteTile(url, request, env, ctx) {
  const match = TILE_PATH.exec(url.pathname);
  if (!match) return setText(404, 'Not a satellite tile path.', 3600);
  const tier = match[1];
  const z = Number(match[2]);
  const x = Number(match[3]);
  const y = Number(match[4]);
  // Refused before storage is touched: outside the tier's zooms or the world.
  if (z < TIERS[tier].minZoom || z > TIERS[tier].maxZoom) {
    return setText(
      404,
      `The ${tier} tier has zooms ${TIERS[tier].minZoom}–${TIERS[tier].maxZoom}.`,
      86400,
    );
  }
  const span = 2 ** z;
  if (x >= span || y >= span) return setText(404, 'Tile coordinate outside the world.', 86400);
  if (!sets.configured(env)) {
    return withMethod(
      request,
      setText(404, 'Satellite imagery is not served by this deployment.', 300),
    );
  }
  const tile = await sets.setTile(request, env, ctx, tier, z, x, y);
  if (tile) return tile;
  // Nothing published has it: the tier below shows through. Short-lived,
  // because the next manifest may publish it.
  return withMethod(request, setText(404, 'No published imagery has this tile.', SET_MANIFEST_TTL));
}

/** Route a request under `/map/satellite/`. */
export async function serveSatellite(url, request, env, ctx) {
  return sets.serveDocument(url, request, env, ctx) ?? serveSatelliteTile(url, request, env, ctx);
}

/** For tests and the development route: forget the per-isolate manifest. */
export function forgetSatelliteManifest() {
  sets.forgetManifest();
}

/** For the test that pins these to `lib/map/imagery.ts`. */
export function satelliteTiers() {
  return TIERS;
}
