/**
 * Which imagery sources are ON SCREEN, so the map credits each exactly while
 * it is drawn (AGENTS.md: credits drawn while shown; `docs/MAP_SATELLITE.md`
 * → The credit).
 *
 * The Worker's `/map/satellite/coverage.json` lists the published sets in
 * priority order: tiers, zooms, sources and the cells each covers. For a view
 * (zoom + bounds) a set is on screen when one of its tiers is drawn at that
 * zoom, the zoom that tier requests is one the set holds, and one of its
 * cells meets the view. Its sources are then credited — every set meeting the
 * view, not only the one in front: a tile's edge can show the tier below, and
 * a credit owed and not drawn is the failure that matters, not one drawn and
 * not owed.
 *
 * Pure, and imported only by the lazily loaded credit hook
 * (`components/map/useImageryCredits.ts`): the tree decoder stays out of the
 * first-paint bundle.
 */
import { coverageAt, type CoverageNode, decodeCoverageTree, EMPTY } from '@/worker/coverageTree.js';

import { IMAGERY_TIER_IDS, IMAGERY_TIERS, isImageryTierId, type ImageryTierId } from './imagery';
import { IMAGERY_SOURCES, type ImagerySourceId, isImagerySourceId } from './imagerySources';

export interface ImageryCoverageSet {
  id: string;
  tiers: readonly ImageryTierId[];
  minZoom: number;
  maxZoom: number;
  sources: readonly ImagerySourceId[];
  bbox: readonly [number, number, number, number];
  cellZoom: number;
  tree: CoverageNode;
}

export interface ImageryCoverage {
  sets: readonly ImageryCoverageSet[];
}

export interface ImageryView {
  zoom: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Read the coverage document, keeping only what can be trusted: a set with
 * an unknown tier is ignored, a source this build does not know is not
 * credited by a string the server sent (it cannot be, there is no label for
 * it) — the set is dropped instead, and so is a set whose cells do not decode.
 */
export function parseImageryCoverage(document: unknown): ImageryCoverage {
  const sets: ImageryCoverageSet[] = [];
  const raw = (document as { sets?: unknown } | null)?.sets;
  if (!Array.isArray(raw)) return { sets };
  for (const item of raw) {
    const set = item as Record<string, unknown>;
    const tiers = Array.isArray(set.tiers) ? set.tiers.filter(isImageryTierId) : [];
    const sources = Array.isArray(set.sources) ? set.sources : [];
    const bbox = set.bbox;
    const cells = set.cells as { maxZoom?: unknown; bits?: unknown } | undefined;
    if (
      typeof set.id !== 'string' ||
      tiers.length === 0 ||
      sources.length === 0 ||
      !sources.every(isImagerySourceId) ||
      typeof set.minZoom !== 'number' ||
      typeof set.maxZoom !== 'number' ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      continue;
    }
    let tree: CoverageNode;
    try {
      tree = decodeCoverageTree({ maxZoom: cells?.maxZoom, bits: cells?.bits });
    } catch {
      continue;
    }
    sets.push({
      id: set.id,
      tiers,
      minZoom: set.minZoom,
      maxZoom: set.maxZoom,
      sources: sources as ImagerySourceId[],
      bbox: bbox as [number, number, number, number],
      cellZoom: cells?.maxZoom as number,
      tree,
    });
  }
  return { sets };
}

/** The zoom a tier requests at map zoom `zoom`, or `null` when the tier is not drawn. */
export function tierZoom(tier: ImageryTierId, zoom: number): number | null {
  const range = IMAGERY_TIERS[tier];
  const requested = Math.round(zoom);
  if (requested < range.minZoom) return null;
  return Math.min(requested, range.maxZoom);
}

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Does any published cell of `set` meet the view? */
function meetsView(set: ImageryCoverageSet, view: ImageryView): boolean {
  const [w, s, e, n] = set.bbox;
  if (view.east < w || view.west > e || view.north < s || view.south > n) return false;
  // The coarsest zoom at which the view spans few enough tiles to test one by one.
  let z = set.cellZoom;
  for (; z > 0; z--) {
    const span =
      (Math.floor(lonToX(view.east, z)) - Math.floor(lonToX(view.west, z)) + 1) *
      (Math.floor(latToY(view.south, z)) - Math.floor(latToY(view.north, z)) + 1);
    if (span <= 64) break;
  }
  const n2 = 2 ** z;
  const x0 = Math.max(0, Math.floor(lonToX(view.west, z)));
  const x1 = Math.min(n2 - 1, Math.floor(lonToX(view.east, z)));
  const y0 = Math.max(0, Math.floor(latToY(view.north, z)));
  const y1 = Math.min(n2 - 1, Math.floor(latToY(view.south, z)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (coverageAt(set.tree, set.cellZoom, z, x, y) !== EMPTY) return true;
    }
  }
  return false;
}

/**
 * The view the credit is decided for. A pitched camera over 3D terrain can
 * report bounds that are not finite, or not ordered, once the horizon is in
 * the frame; every comparison against them would then be false and nothing
 * would be credited — the failure that matters. So such a view counts as the
 * whole world: a source is over-credited rather than under-credited.
 */
function creditableView(view: ImageryView): ImageryView {
  const { west, south, east, north } = view;
  const sane = [west, south, east, north].every(Number.isFinite) && west < east && south < north;
  if (sane) return view;
  return { zoom: view.zoom, west: -180, south: -85.05, east: 180, north: 85.05 };
}

/** The sources on screen, in the order their sets are listed (finest tier first). */
export function imagerySourcesInView(
  coverage: ImageryCoverage,
  rawView: ImageryView,
): ImagerySourceId[] {
  const view = creditableView(rawView);
  const out: ImagerySourceId[] = [];
  const add = (source: ImagerySourceId) => {
    if (!out.includes(source)) out.push(source);
  };
  for (const tier of [...IMAGERY_TIER_IDS].reverse()) {
    const z = tierZoom(tier, view.zoom);
    if (z === null) continue;
    for (const set of coverage.sets) {
      if (!set.tiers.includes(tier) || z < set.minZoom || z > set.maxZoom) continue;
      if (meetsView(set, view)) set.sources.forEach(add);
    }
  }
  return out;
}

/**
 * The view both canvases hand the credit — web from `getBounds()` on load and
 * at every settled camera, native from `getBounds()` once its style has
 * loaded and at every `onRegionDidChange` — so the two cannot differ.
 */
export function imageryViewOf(
  zoom: number,
  [west, south, east, north]: readonly [number, number, number, number],
): ImageryView {
  return { zoom, west, south, east, north };
}

/**
 * The imagery sources to credit — THE rule both canvases follow:
 *
 * - no coverage document (not loaded yet, or its fetch failed): every source
 *   GoWay may serve (`IMAGERY_SOURCES`), because imagery may be on screen and
 *   a source drawn uncredited breaks its licence;
 * - no view yet (the map has not reported one): every source a published set
 *   is made of;
 * - otherwise the sources on screen ({@link imagerySourcesInView}).
 *
 * Over-credit while unsure, never under-credit.
 */
export function imageryCreditSources(
  coverage: ImageryCoverage | null,
  view: ImageryView | null,
): ImagerySourceId[] {
  if (!coverage) return Object.keys(IMAGERY_SOURCES) as ImagerySourceId[];
  if (!view) {
    const all: ImagerySourceId[] = [];
    for (const set of coverage.sets) {
      for (const source of set.sources) if (!all.includes(source)) all.push(source);
    }
    return all;
  }
  return imagerySourcesInView(coverage, view);
}
