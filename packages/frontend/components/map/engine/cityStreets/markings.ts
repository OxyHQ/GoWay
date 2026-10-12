/**
 * Which marking a tag combination draws: a crossing's pattern, a lane's arrow.
 * Pure decisions, separate from the geometry so every tag combination —
 * junk included — is a test (`components/map/__tests__/cityStreetsMarkings.test.ts`).
 *
 * The rule is the honesty rule of `docs/MAP_3D_CITY.md`: a crossing is drawn
 * only where OSM maps one, in the pattern OSM records; an arrow only where
 * `turn:lanes` records the lane's turns.
 */
import type { Turn } from '@/lib/map/cityRoads';

import type { RoadNode, RoadPiece } from '../roads/roadTiles';

/**
 * How a crossing is painted. `zebra`: bars parallel to the traffic; `ladder`:
 * bars between two transverse lines; `lines`: the two transverse lines only;
 * `dashes`/`dots`: the two lines broken; `surface`: a tinted surface;
 * `none`: mapped, but unmarked (or nothing readable says how).
 */
export type CrossingStyle = 'zebra' | 'ladder' | 'lines' | 'dashes' | 'dots' | 'surface' | 'none';

const FROM_MARKINGS: Record<string, CrossingStyle> = {
  zebra: 'zebra',
  'zebra:double': 'zebra',
  'zebra:paired': 'zebra',
  'zebra:bicolour': 'zebra',
  ladder: 'ladder',
  'ladder:skewed': 'ladder',
  'ladder:paired': 'ladder',
  lines: 'lines',
  'lines:paired': 'lines',
  dashes: 'dashes',
  'dashes:paired': 'dashes',
  dots: 'dots',
  surface: 'surface',
  no: 'none',
  // A pictogram is not a crossing pattern this renderer can draw honestly.
  pictograms: 'none',
};

/**
 * The style of a crossing from what OSM records about it, most specific
 * first: `crossing:markings` on the node, then on the `footway=crossing` way
 * across the road (New York records it there, on the way), then
 * `crossing_ref`, then `crossing`.
 *
 * - `zebra`, `marked`, `uncontrolled` (and `crossing_ref=zebra`): a zebra —
 *   the owner's rule, and what those values mean on the wiki.
 * - `traffic_signals` with no recorded pattern: two transverse lines, the
 *   least a signalled crossing is painted with — the claim is "a marked
 *   crossing is here", not a pattern.
 * - `crossing_ref=pelican|toucan|puffin|pegasus` (UK signalled): lines.
 * - `unmarked`, `informal`, `no`, `crossing:markings=no`, anything unreadable:
 *   nothing.
 * - `crossing:markings=yes`: marked, pattern unknown → lines.
 */
export function crossingStyle(
  node: Pick<RoadNode, 'crossing' | 'crossingMarkings' | 'crossingRef'> | null,
  way: Pick<RoadPiece, 'crossing' | 'crossingMarkings'> | null,
): CrossingStyle {
  for (const markings of [node?.crossingMarkings, way?.crossingMarkings]) {
    if (!markings) continue;
    if (markings === 'yes') return 'lines';
    const style = FROM_MARKINGS[markings];
    if (style) return style;
  }
  const ref = node?.crossingRef;
  if (ref === 'zebra') return 'zebra';
  if (ref === 'pelican' || ref === 'toucan' || ref === 'puffin' || ref === 'pegasus') {
    return 'lines';
  }
  const crossing = node?.crossing ?? way?.crossing;
  switch (crossing) {
    case 'zebra':
    case 'marked':
    case 'uncontrolled':
      return 'zebra';
    case 'traffic_signals':
      return 'lines';
    default:
      return 'none';
  }
}

/**
 * The arrow shapes the atlas draws. A lane's recorded turns become one shape:
 * the union of its directions, each drawn from the same base.
 */
export const ARROW_PARTS = [
  'through',
  'left',
  'right',
  'slight_left',
  'slight_right',
  'reverse',
  'merge_to_left',
  'merge_to_right',
] as const;
export type ArrowPart = (typeof ARROW_PARTS)[number];

/**
 * A lane's turns → the parts of its arrow, sorted (the atlas key), or `null`
 * when nothing is to be drawn (`none`, an empty lane, or an unrecorded one).
 * `sharp_*` draws as the plain turn; `reverse` points to the side traffic
 * crosses (left where it keeps right) — the atlas mirrors it.
 */
export function arrowParts(turns: readonly Turn[] | null): ArrowPart[] | null {
  if (!turns || turns.length === 0) return null;
  const parts = new Set<ArrowPart>();
  for (const turn of turns) {
    if (turn === 'none') continue;
    if (turn === 'sharp_left') parts.add('left');
    else if (turn === 'sharp_right') parts.add('right');
    else parts.add(turn);
  }
  if (parts.size === 0) return null;
  return ARROW_PARTS.filter((p) => parts.has(p));
}

/** The atlas key of an arrow: its parts, and the side a U-turn bends to. */
export function arrowKey(parts: readonly ArrowPart[], drivingSide: 'left' | 'right'): string {
  const key = parts.join('+');
  return parts.includes('reverse') && drivingSide === 'left' ? `${key}@lht` : key;
}
