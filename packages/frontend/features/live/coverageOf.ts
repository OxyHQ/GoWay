/**
 * Which z12 tiles real vehicles of each kind are being drawn in — the value
 * `lib/live/coverage.ts` publishes for other features. Pure.
 *
 * A source counts only while it is `live` (fresh), only for the kinds of
 * vehicle it has actually sent, and only where its coverage meets the
 * (padded) visible map.
 */
import type { LiveSource, LiveTransitMode } from '@goway.to/sdk/live';

import {
  LIVE_COVERAGE_KINDS,
  LIVE_COVERAGE_ZOOM,
  type LiveCoverage,
  type LiveCoverageKind,
  liveCoverageTileOf,
} from '@/lib/live/coverage';

/** The most tiles one kind may list; past it the view is too wide to say. */
export const MAX_COVERAGE_TILES = 1024;

export function coverageKindOf(mode: LiveTransitMode): LiveCoverageKind | null {
  switch (mode) {
    case 'bus':
      return 'bus';
    case 'tram':
      return 'tram';
    case 'rail':
      return 'train';
    case 'subway':
      return 'metro';
    case 'ferry':
      return 'ferry';
    default:
      return null;
  }
}

type Box = { west: number; south: number; east: number; north: number };

function tilesIn(box: Box, out: Set<string>): boolean {
  const [x0, y0] = liveCoverageTileOf(box.north, box.west).split('/').map(Number) as [
    number,
    number,
  ];
  const [x1, y1] = liveCoverageTileOf(box.south, box.east).split('/').map(Number) as [
    number,
    number,
  ];
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_COVERAGE_TILES) return false;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.add(`${x}/${y}`);
  return true;
}

export function coverageOf(
  sources: readonly LiveSource[],
  /** The kinds each source has sent vehicles of. */
  modesBySource: ReadonlyMap<string, ReadonlySet<LiveCoverageKind>>,
  view: Box | null,
): LiveCoverage {
  const kinds = Object.fromEntries(
    LIVE_COVERAGE_KINDS.map((kind) => [kind, { tiles: new Set<string>(), fresh: false }]),
  ) as Record<LiveCoverageKind, { tiles: Set<string>; fresh: boolean }>;
  if (!view || view.west > view.east) return { kinds };
  for (const source of sources) {
    if (source.kind !== 'transit' || source.status !== 'live') continue;
    const modes = modesBySource.get(source.id);
    if (!modes || modes.size === 0) continue;
    const c = source.coverage ?? { west: -180, south: -85, east: 180, north: 85 };
    const box = {
      west: Math.max(c.west, view.west),
      east: Math.min(c.east, view.east),
      south: Math.max(c.south, view.south),
      north: Math.min(c.north, view.north),
    };
    if (box.west > box.east || box.south > box.north) continue;
    for (const kind of modes) {
      const entry = kinds[kind];
      if (tilesIn(box, entry.tiles)) entry.fresh = true;
    }
  }
  return { kinds };
}

export { LIVE_COVERAGE_ZOOM };
