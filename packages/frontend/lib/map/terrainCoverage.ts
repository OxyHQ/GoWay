/**
 * Which of GoWay's own terrain sources are ON SCREEN (`docs/MAP_TERRAIN_GLOBE.md`
 * → "The archive" → The credit): the raster-family coverage
 * (`rasterCoverage.ts`) of `/map/terrain/coverage.json`, one tier, read at the
 * zoom MapLibre's DEM source requests (never past its z12).
 *
 * Pure, and imported only by the lazily loaded credit hook
 * (`components/map/useSourceCredits.ts`).
 */
import { type Coverage, type CoverageView, parseCoverage, sourcesInView } from './rasterCoverage';
import { isTerrainSourceId, type TerrainSourceId } from './terrainSources';

/** The terrain family's one tier (`worker/terrain.js`). */
type TerrainTier = 'terrain';

export const TERRAIN_COVERAGE_PATH = '/map/terrain/coverage.json';
/** The deepest elevation zoom served — the DEM sources' `maxzoom` (`lib/map/style/relief.ts`). */
const TERRAIN_MAX_ZOOM = 12;

export type TerrainCoverage = Coverage<TerrainTier, TerrainSourceId>;

const isTerrainTier = (value: unknown): value is TerrainTier => value === 'terrain';

/** Read `/map/terrain/coverage.json`, keeping only what can be trusted (`parseCoverage`). */
export function parseTerrainCoverage(document: unknown): TerrainCoverage {
  return parseCoverage(document, isTerrainTier, isTerrainSourceId);
}

/** The terrain sources on screen at a settled view. */
export function terrainSourcesInView(
  coverage: TerrainCoverage,
  view: CoverageView,
): TerrainSourceId[] {
  return sourcesInView(coverage, view, ['terrain'], (_tier, zoom) =>
    Math.min(Math.max(0, Math.round(zoom)), TERRAIN_MAX_ZOOM),
  );
}
