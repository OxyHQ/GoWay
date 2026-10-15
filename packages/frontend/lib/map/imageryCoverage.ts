/**
 * Which imagery sources are ON SCREEN, so the map credits each exactly while
 * it is drawn (`docs/MAP_SATELLITE.md` → The credit): the raster-family
 * coverage (`rasterCoverage.ts`) with the imagery's tiers — the finest first,
 * because an orthophoto over the base is what the eye sees.
 *
 * Pure, and imported only by the lazily loaded credit hook
 * (`components/map/useSourceCredits.ts`).
 */
import { IMAGERY_TIER_IDS, IMAGERY_TIERS, isImageryTierId, type ImageryTierId } from './imagery';
import { type ImagerySourceId, isImagerySourceId } from './imagerySources';
import {
  type Coverage,
  type CoverageSet,
  type CoverageView,
  parseCoverage,
  sourcesInView,
} from './rasterCoverage';

export type ImageryCoverageSet = CoverageSet<ImageryTierId, ImagerySourceId>;
export type ImageryCoverage = Coverage<ImageryTierId, ImagerySourceId>;
export type ImageryView = CoverageView;

/** Read `/map/satellite/coverage.json`, keeping only what can be trusted (`parseCoverage`). */
export function parseImageryCoverage(document: unknown): ImageryCoverage {
  return parseCoverage(document, isImageryTierId, isImagerySourceId);
}

/** The zoom a tier requests at map zoom `zoom`, or `null` when the tier is not drawn. */
export function tierZoom(tier: ImageryTierId, zoom: number): number | null {
  const range = IMAGERY_TIERS[tier];
  const requested = Math.round(zoom);
  if (requested < range.minZoom) return null;
  return Math.min(requested, range.maxZoom);
}

/** The sources on screen, in the order their sets are listed (finest tier first). */
export function imagerySourcesInView(
  coverage: ImageryCoverage,
  view: ImageryView,
): ImagerySourceId[] {
  return sourcesInView(coverage, view, [...IMAGERY_TIER_IDS].reverse(), tierZoom);
}
