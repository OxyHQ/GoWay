/**
 * Which SOURCES of a raster family are on screen — the satellite imagery's
 * (`imageryCoverage.ts`) or GoWay's own terrain's (`terrainCoverage.ts`) — so
 * the map credits each exactly while it is drawn (AGENTS.md: credits drawn
 * while shown).
 *
 * The Worker's `<family>/coverage.json` (`worker/rasterSets.js`) lists the
 * published sets in priority order: tiers, zooms, sources and the cells each
 * covers. For a view (zoom + bounds) a set is on screen when one of its tiers
 * is drawn at that zoom, the zoom that tier requests is one the set holds,
 * and one of its cells meets the view. Its sources are then credited — every
 * set meeting the view, not only the one in front: a tile's edge can show the
 * set behind, and a credit owed and not drawn is the failure that matters,
 * not one drawn and not owed.
 *
 * Pure, and imported only by the lazily loaded credit hook
 * (`components/map/useSourceCredits.ts`): the tree decoder stays out of the
 * first-paint bundle.
 */
import { coverageAt, type CoverageNode, decodeCoverageTree, EMPTY } from '@/worker/coverageTree.js';

export interface CoverageSet<Tier extends string, Source extends string> {
  id: string;
  tiers: readonly Tier[];
  minZoom: number;
  maxZoom: number;
  sources: readonly Source[];
  bbox: readonly [number, number, number, number];
  cellZoom: number;
  tree: CoverageNode;
}

export interface Coverage<Tier extends string, Source extends string> {
  sets: readonly CoverageSet<Tier, Source>[];
}

export interface CoverageView {
  zoom: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Read a coverage document, keeping only what can be trusted: a set with an
 * unknown tier is ignored, a source this build does not know is not credited
 * by a string the server sent (there is no label for it) — the set is dropped
 * instead, and so is a set whose cells do not decode.
 */
export function parseCoverage<Tier extends string, Source extends string>(
  document: unknown,
  isTier: (value: unknown) => value is Tier,
  isSource: (value: unknown) => value is Source,
): Coverage<Tier, Source> {
  const sets: CoverageSet<Tier, Source>[] = [];
  const raw = (document as { sets?: unknown } | null)?.sets;
  if (!Array.isArray(raw)) return { sets };
  for (const item of raw) {
    const set = item as Record<string, unknown>;
    const tiers = Array.isArray(set.tiers) ? set.tiers.filter(isTier) : [];
    const sources = Array.isArray(set.sources) ? set.sources : [];
    const bbox = set.bbox;
    const cells = set.cells as { maxZoom?: unknown; bits?: unknown } | undefined;
    if (
      typeof set.id !== 'string' ||
      tiers.length === 0 ||
      sources.length === 0 ||
      !sources.every(isSource) ||
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
      sources: sources as Source[],
      bbox: bbox as [number, number, number, number],
      cellZoom: cells?.maxZoom as number,
      tree,
    });
  }
  return { sets };
}

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Does any published cell of `set` meet the view? */
function meetsView(set: CoverageSet<string, string>, view: CoverageView): boolean {
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
function creditableView(view: CoverageView): CoverageView {
  const { west, south, east, north } = view;
  const sane = [west, south, east, north].every(Number.isFinite) && west < east && south < north;
  if (sane) return view;
  return { zoom: view.zoom, west: -180, south: -85.05, east: 180, north: 85.05 };
}

/**
 * The sources on screen, tier by tier in `tiers` order, then in the order
 * their sets are listed. `tierZoom` is the zoom a tier requests at a map
 * zoom, or `null` when the tier is not drawn.
 */
export function sourcesInView<Tier extends string, Source extends string>(
  coverage: Coverage<Tier, Source>,
  rawView: CoverageView,
  tiers: readonly Tier[],
  tierZoom: (tier: Tier, zoom: number) => number | null,
): Source[] {
  const view = creditableView(rawView);
  const out: Source[] = [];
  const add = (source: Source) => {
    if (!out.includes(source)) out.push(source);
  };
  for (const tier of tiers) {
    const z = tierZoom(tier, view.zoom);
    if (z === null) continue;
    for (const set of coverage.sets) {
      if (!set.tiers.includes(tier) || z < set.minZoom || z > set.maxZoom) continue;
      if (meetsView(set, view)) set.sources.forEach(add);
    }
  }
  return out;
}
