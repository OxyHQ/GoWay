/**
 * Real first: where the live layer has real vehicles of a class, the
 * simulation runs none of that class.
 *
 * City life is FILLER (`docs/MAP_CITY_LIFE.md` → "Real first"). For every
 * vehicle class a real feed can carry — buses, trams, trains, metro, ferries —
 * the live layer reports which z12 tiles it has active, FRESH data for; in
 * those tiles the simulation spawns none of that class, and any of its
 * simulated vehicles already there fade out. Never both for the same class in
 * the same place. Cars and people have no open real source, so they stay
 * simulated everywhere.
 *
 * The live layer publishes its coverage on `lib/live/coverage.ts` (only
 * sources carrying a WHOLE network of a kind count); the renderer subscribes
 * (`subscribeLiveCoverage`) and forwards the fresh tiles to the simulation
 * worker as {@link CoveredTiles}. With the live layer off, coverage is empty
 * and the simulation fills everything.
 *
 * Pure: no renderer, no map engine, no worker; the channel's types, zoom and
 * tile key are the live layer's own, never restated here. Tested in
 * `__tests__/cityLifeRealFirst.test.ts`.
 */
import {
  LIVE_COVERAGE_KINDS,
  type LiveCoverage,
  type LiveCoverageKind,
  liveCoverageTileOf,
} from '@/lib/live/coverage';


/** The vehicle classes a real feed can cover: the live layer's coverage kinds. */
export const REAL_CLASSES = LIVE_COVERAGE_KINDS;
export type RealClass = LiveCoverageKind;

/** What the worker is sent: per class, the z12 tiles real data owns. Stale data owns nothing. */
export type CoveredTiles = Partial<Record<RealClass, string[]>>;

/**
 * The tiles the simulation must leave to real data. Only FRESH coverage
 * counts: a feed that went quiet is not real traffic any more, and the gap is
 * filled again rather than left empty.
 */
export function coveredTiles(coverage: LiveCoverage): CoveredTiles {
  const out: CoveredTiles = {};
  for (const kind of REAL_CLASSES) {
    const entry = coverage.kinds[kind];
    if (!entry.fresh || entry.tiles.size === 0) continue;
    out[kind] = [...entry.tiles].sort();
  }
  return out;
}

/**
 * The classes with fresh real data anywhere in a view's box: what the label
 * calls "live" in view. A box's z12 tiles are few (a city view spans a
 * handful), so this enumerates them.
 */
export function liveClassesInView(
  coverage: LiveCoverage,
  bounds: { west: number; south: number; east: number; north: number },
): RealClass[] {
  const [x0, y0] = liveCoverageTileOf(bounds.north, bounds.west).split('/').map(Number);
  const [x1, y1] = liveCoverageTileOf(bounds.south, bounds.east).split('/').map(Number);
  const live: RealClass[] = [];
  for (const kind of REAL_CLASSES) {
    const entry = coverage.kinds[kind];
    if (!entry.fresh || entry.tiles.size === 0) continue;
    let found = false;
    for (let x = x0; x <= x1 && !found; x++) {
      for (let y = y0; y <= y1 && !found; y++) found = entry.tiles.has(`${x}/${y}`);
    }
    if (found) live.push(kind);
  }
  return live;
}
