/**
 * Where GoWay Live is drawing REAL vehicles right now — a tiny, read-only
 * channel for other map features (city life hides its simulated buses where
 * real ones are shown, so the map never shows both).
 *
 * The live feature publishes; anyone may subscribe. Deliberately no imports
 * and no dependency on the live feature itself, so reading it loads nothing
 * of GoWay Live: with live off, coverage is simply always empty.
 *
 *     import { subscribeLiveCoverage } from '@/lib/live/coverage';
 *     const stop = subscribeLiveCoverage((coverage) => {
 *       const bus = coverage.kinds.bus; // { tiles: Set<'x/y' at z12>, fresh }
 *       if (bus.fresh && bus.tiles.has(`${x}/${y}`)) hideSimulatedBusesIn(x, y);
 *     });
 *
 * A tile is in a kind's set when a live source carrying a WHOLE network of
 * that kind covers it (a feed of only some operators' buses never counts)
 * AND it is in (or near) the visible map; `fresh` is false while every such
 * source is stale, unavailable or still starting — in which case a reader
 * should not treat the area as covered.
 */

export type LiveCoverageKind = 'bus' | 'tram' | 'train' | 'metro' | 'ferry';

export const LIVE_COVERAGE_KINDS: readonly LiveCoverageKind[] = [
  'bus',
  'tram',
  'train',
  'metro',
  'ferry',
];

/** The zoom of the coverage tiles: a z12 tile is ~7.4 km across at 41°. */
export const LIVE_COVERAGE_ZOOM = 12;

export interface LiveCoverage {
  kinds: Readonly<Record<LiveCoverageKind, { tiles: ReadonlySet<string>; fresh: boolean }>>;
}

const empty = (): LiveCoverage => ({
  kinds: {
    bus: { tiles: new Set(), fresh: false },
    tram: { tiles: new Set(), fresh: false },
    train: { tiles: new Set(), fresh: false },
    metro: { tiles: new Set(), fresh: false },
    ferry: { tiles: new Set(), fresh: false },
  },
});

let current: LiveCoverage = empty();
const listeners = new Set<(coverage: LiveCoverage) => void>();

/** The coverage now. */
export function getLiveCoverage(): LiveCoverage {
  return current;
}

/** Called with the current coverage at once, then on every change. Returns the unsubscribe. */
export function subscribeLiveCoverage(listener: (coverage: LiveCoverage) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** The live feature's side. Ignored when nothing changed. */
export function publishLiveCoverage(next: LiveCoverage): void {
  if (sameCoverage(current, next)) return;
  current = next;
  for (const listener of listeners) listener(current);
}

/** Back to nothing covered (the live layer was turned off). */
export function clearLiveCoverage(): void {
  publishLiveCoverage(empty());
}

function sameCoverage(a: LiveCoverage, b: LiveCoverage): boolean {
  for (const kind of LIVE_COVERAGE_KINDS) {
    const x = a.kinds[kind];
    const y = b.kinds[kind];
    if (x.fresh !== y.fresh || x.tiles.size !== y.tiles.size) return false;
    for (const tile of x.tiles) if (!y.tiles.has(tile)) return false;
  }
  return true;
}

/** The z12 tile (`x/y`) holding a position — the key readers look up. */
export function liveCoverageTileOf(latitude: number, longitude: number): string {
  const n = 2 ** LIVE_COVERAGE_ZOOM;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((longitude + 180) / 360) * n)));
  const clamped = Math.max(-85.05, Math.min(85.05, latitude));
  const r = (clamped * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)),
  );
  return `${x}/${y}`;
}
