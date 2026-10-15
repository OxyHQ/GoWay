/**
 * GoWay's own terrain at the edge (`docs/MAP_TERRAIN_GLOBE.md` → "The
 * archive"): bare-earth sets built per region (`scripts/build-terrain-set.ts`),
 * one PMTiles archive per z7 cell, chosen per tile by a manifest — the raster
 * sets of `rasterSets.js`, one tier, z0–12:
 *
 *     terrain/<set>/<stamp>/7/<x>/<y>.pmtiles          (+ .receipt.json)
 *
 * `/map/terrain/{z}/{x}/{y}.webp` asks the sets first (`index.js` →
 * `serveTerrain`); a tile none has is the fallback's — Mapterhorn, from its
 * R2 archive or its endpoint — exactly as before. A set's tiles already hold
 * the fallback feathered in where the set ends, so the two meet without a
 * step.
 *
 * `MAP_TERRAIN_MANIFEST` names the manifest's key in `MAP_TILES`. Unset, no
 * set answers, the coverage document lists none, no request touches storage
 * for it, and every tile is the fallback's.
 */

import { MEMORY_BUDGET } from './budget.js';
import { createRasterSets } from './rasterSets.js';

/** The one tier: every zoom MapLibre's DEM source requests (`lib/map/style/relief.ts`). */
export const TERRAIN_TIER = 'terrain';

const sets = createRasterSets({
  name: 'terrain',
  prefix: '/map/terrain',
  manifestVariable: 'MAP_TERRAIN_MANIFEST',
  tiers: { [TERRAIN_TIER]: { minZoom: 0, maxZoom: 12 } },
  budgetBytes: MEMORY_BUDGET.terrain,
});

/** Check a terrain manifest exactly as the builder writes it. */
export const parseTerrainManifest = sets.parseManifest;
/** The sets, in priority order, that may hold tile (z, x, y), with their archive keys. */
export function terrainCandidatesFor(manifest, z, x, y) {
  return sets.candidatesFor(manifest, TERRAIN_TIER, z, x, y);
}

/** The published set tile (z, x, y), or `null` when no set has it: then the fallback's. */
export function terrainSetTile(request, env, ctx, z, x, y) {
  return sets.setTile(request, env, ctx, TERRAIN_TIER, z, x, y);
}

/** `/map/terrain/coverage.json`, `/manifest.json`, `/data/…`, or `null` for anything else. */
export function serveTerrainDocument(url, request, env, ctx) {
  return sets.serveDocument(url, request, env, ctx);
}

/** For tests and the development route: forget the per-isolate manifest. */
export function forgetTerrainManifest() {
  sets.forgetManifest();
}
