/**
 * A carriageway's cross-section from its tags: which bands it has (traffic
 * lanes, bus lanes, cycle lanes, parking), in which direction each runs, how
 * wide it is, and which line is painted between each pair — the decisions
 * the street mesher draws (`docs/MAP_STREETS.md` → "What is drawn from which
 * tag").
 *
 * ## Recorded, or the class's generic minimum — never invented
 *
 * Every band, arrow and bus lane comes from a tag the piece carries. Where the
 * lane counts are NOT recorded the road still needs a width to be drawn at
 * all, so a class default stands in ({@link LANE_WIDTH_M},
 * {@link defaultLanes}) — that width is styling, and so is the one line drawn
 * on such a road: a dashed centre line on a two-way road of a through class
 * (`tertiary` and up), solid edge lines on a motorway or trunk, nothing else.
 * No lane dividers, no arrows, no bus lane, no crossing are ever drawn from a
 * default.
 *
 * ## Frames
 *
 * Offsets are lateral, in metres from the centreline, POSITIVE TO THE LEFT
 * of the way's drawn direction. Bands are listed from the left edge to the
 * right edge. A lane's `dir` is `1` when it runs the way's drawn direction,
 * `-1` against it. OSM lists `turn:lanes` and `bus:lanes` from the left to
 * the right OF THE TRAVELLER, so a backward list reads right-to-left here.
 *
 * Pure: tested in `components/map/__tests__/cityStreetsLanes.test.ts`.
 */
import type { RoadClass, Side, Turn } from '@/lib/map/cityRoads';

import { busLaneFlags } from '../roads/busLanes';
import { type DrivingSide, kerbSideOf } from '../roads/drivingSide';
import { defaultLanes } from '../roads/roadGraph';
import type { LaneChange, RoadPiece } from '../roads/roadTiles';

/** Where the paint differs by country: the side traffic keeps to, and the centre line's colour. */
export interface PaintRules {
  drivingSide: DrivingSide;
  /** Centre lines (between opposing traffic) yellow, as in the Americas; else white. */
  yellowCentre: boolean;
}

export type BandKind = 'lane' | 'bus' | 'cycle' | 'parking';

export interface Band {
  kind: BandKind;
  /** `1` with the drawn direction, `-1` against it; parking: the adjacent lane's. */
  dir: 1 | -1;
  /** Lateral offsets of its two edges (left > right). */
  left: number;
  right: number;
  /** Recorded turns of this lane (`[]`: recorded as none); `null`: not recorded. */
  turns: Turn[] | null;
  /** Recorded `change:lanes` of this lane (from the traveller's seat); `null`: not recorded. */
  change: LaneChange | null;
}

/**
 * `mixed`: a solid line beside a dashed one (`change:lanes` lets one side
 * cross, not the other) — the solid one on {@link Divider.solidOn}'s side.
 */
export type LineStyle = 'dashed' | 'solid' | 'double' | 'mixed';
export type PaintColour = 'white' | 'yellow';

export interface Divider {
  offset: number;
  style: LineStyle;
  colour: PaintColour;
  /** Painted width of one line, metres. */
  width: number;
  /** Why: `lanes` same-direction lanes, `centre`, `bus`, `cycle`, `edge`. */
  role: 'lanes' | 'centre' | 'bus' | 'cycle' | 'edge';
  /** `mixed` only: the drawn side (of the way's direction) the solid line is on. */
  solidOn?: 'left' | 'right';
}

export interface CrossSection {
  /** Carriageway width, metres: the distance between the kerbs. */
  width: number;
  bands: Band[];
  dividers: Divider[];
  /** Lanes per direction as drawn. */
  forward: number;
  backward: number;
  /** Whether the lane counts were recorded (else a class default, and generic paint only). */
  recorded: boolean;
  /** Whether {@link CrossSection.width} came from the `width` tag. */
  widthRecorded: boolean;
}

/** Lane width by class, metres — a styling default for drawing, not a fact about the street. */
export const LANE_WIDTH_M: Record<RoadClass, number> = {
  motorway: 3.5,
  motorway_link: 3.5,
  trunk: 3.5,
  trunk_link: 3.5,
  primary: 3.25,
  primary_link: 3.25,
  secondary: 3.25,
  secondary_link: 3.25,
  tertiary: 3.1,
  tertiary_link: 3.1,
  unclassified: 3,
  residential: 3,
  living_street: 2.75,
  service: 2.75,
  road: 3,
  pedestrian: 3,
  footway: 2,
  path: 1.5,
  steps: 2,
  cycleway: 2,
  track: 2.5,
};

export const PARKING_WIDTH_M = 2.2;
export const CYCLE_LANE_WIDTH_M = 1.5;

/** Painted widths, metres (styling within the usual 0.1–0.6 m of road-marking codes). */
export const LINE_WIDTH_M = {
  lanes: 0.15,
  centre: 0.15,
  /** The gap between the two lines of a double line. */
  doubleGap: 0.12,
  bus: 0.3,
  cycle: 0.2,
  edge: 0.2,
  stop: 0.4,
} as const;

/** Classes whose two-way carriageway gets a generic centre line when lanes are not recorded. */
const THROUGH_CLASSES = new Set<RoadClass>([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
]);
const EDGE_LINE_CLASSES = new Set<RoadClass>(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const MAJOR_CLASSES = new Set<RoadClass>(['motorway', 'trunk', 'primary']);
const MIDDLE_CLASSES = new Set<RoadClass>(['secondary', 'tertiary']);

/** Coarse boxes `[west, south, east, north]` where centre lines are yellow (styling). */
const YELLOW_CENTRE: readonly (readonly [number, number, number, number])[] = [
  [-170, 14, -50, 72], // Canada, the United States, Mexico
  [-118, -56, -34, 14], // Central and South America
  [4.5, 57.9, 31.2, 71.2], // Norway
  [20.5, 59.7, 31.6, 70.1], // Finland
  [124.5, 33, 131, 38.7], // South Korea
];

export function paintRulesAt(lng: number, lat: number, drivingSide: DrivingSide): PaintRules {
  const yellowCentre = YELLOW_CENTRE.some(
    ([w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n,
  );
  return { drivingSide, yellowCentre };
}

/** A per-lane list, used only when it has exactly the lane count it describes. */
function fits<T>(list: T[] | undefined, count: number): T[] | null {
  return list && list.length === count ? list : null;
}

/** Lanes per direction from the recorded counts and per-lane lists; `null` when nothing records them. */
function recordedCounts(piece: RoadPiece): { forward: number; backward: number } | null {
  if (piece.oneway === 1 || piece.oneway === -1) {
    const travel = piece.oneway === 1 ? piece.lanesForward : piece.lanesBackward;
    const listed =
      piece.turnLanes?.length ??
      piece.busLanes?.length ??
      piece.changeLanes?.length ??
      (piece.oneway === 1
        ? (piece.turnLanesForward?.length ??
          piece.busLanesForward?.length ??
          piece.changeLanesForward?.length)
        : (piece.turnLanesBackward?.length ??
          piece.busLanesBackward?.length ??
          piece.changeLanesBackward?.length));
    const n = piece.lanes ?? travel ?? listed;
    if (n === undefined) return null;
    return piece.oneway === 1 ? { forward: n, backward: 0 } : { forward: 0, backward: n };
  }
  let forward =
    piece.lanesForward ??
    piece.turnLanesForward?.length ??
    piece.busLanesForward?.length ??
    piece.changeLanesForward?.length;
  let backward =
    piece.lanesBackward ??
    piece.turnLanesBackward?.length ??
    piece.busLanesBackward?.length ??
    piece.changeLanesBackward?.length;
  if (piece.lanes !== undefined) {
    if (forward !== undefined && backward === undefined) backward = piece.lanes - forward;
    else if (backward !== undefined && forward === undefined) forward = piece.lanes - backward;
    else if (forward === undefined && backward === undefined) {
      // An odd count without a split is often a centre turn lane; drawn as
      // the larger half forward — the split is styling, the total is not.
      forward = Math.ceil(piece.lanes / 2);
      backward = piece.lanes - forward;
    }
  }
  if (forward === undefined || backward === undefined) return null;
  if (forward < 1 || backward < 1) {
    // `lanes=2` + `lanes:forward=2` on a two-way road: inconsistent. Not drawn as recorded.
    return null;
  }
  return { forward, backward };
}

/** The side a travel direction keeps its kerb on, in DRAWN terms. */
function kerbSide(dir: 1 | -1, rules: PaintRules): 'left' | 'right' {
  return kerbSideOf(dir, rules.drivingSide);
}

interface Lane {
  change: LaneChange | null;
  kind: 'lane' | 'bus';
  dir: 1 | -1;
  turns: Turn[] | null;
}

/**
 * The traffic lanes of one direction, in the TRAVELLER's left-to-right
 * order, with the recorded turns and bus designations applied.
 */
function directionLanes(
  piece: RoadPiece,
  dir: 1 | -1,
  count: number,
  recorded: boolean,
  rules: PaintRules,
): Lane[] {
  const lanes: Lane[] = Array.from({ length: count }, () => ({
    kind: 'lane',
    dir,
    turns: null,
    change: null,
  }));
  if (!recorded || count === 0) return lanes;
  const oneway = piece.oneway === 1 || piece.oneway === -1;
  // A one-way road's plain key describes its only direction; a two-way road's
  // describes neither (OSM wants `:forward`/`:backward` there).
  const forDirection = <T>(
    plain: T | undefined,
    forward: T | undefined,
    backward: T | undefined,
  ) => {
    const directional = dir === 1 ? forward : backward;
    return oneway ? (plain ?? directional) : directional;
  };
  const turns = fits(
    forDirection(piece.turnLanes, piece.turnLanesForward, piece.turnLanesBackward),
    count,
  );
  if (turns) {
    for (let i = 0; i < count; i++) lanes[i].turns = turns[i];
  }
  const changes = fits(
    forDirection(piece.changeLanes, piece.changeLanesForward, piece.changeLanesBackward),
    count,
  );
  if (changes) {
    for (let i = 0; i < count; i++) lanes[i].change = changes[i];
  }
  busLaneFlags(piece, dir, rules.drivingSide, count).forEach((bus, i) => {
    if (bus) lanes[i].kind = 'bus';
  });
  return lanes;
}

/**
 * The sides a `left|right|both` value names. `both` from a plain key on a
 * one-way road (`cycleway=lane`) means the side traffic keeps to; parking
 * recorded on both sides is on both sides.
 */
function sidesOf(
  value: Side | undefined,
  oneway: boolean,
  travelKerb: 'left' | 'right',
  plainBothIsKerb: boolean,
) {
  if (!value) return { left: false, right: false };
  if (value === 'both' && oneway && plainBothIsKerb) {
    return { left: travelKerb === 'left', right: travelKerb === 'right' };
  }
  return { left: value !== 'right', right: value !== 'left' };
}

/** The cross-section of a drivable piece. */
export function crossSection(piece: RoadPiece, rules: PaintRules): CrossSection {
  const oneway = piece.oneway === 1 || piece.oneway === -1;
  const counted = recordedCounts(piece);
  const recorded = counted !== null;
  const fallback = defaultLanes(piece.highway, oneway);
  const forward = counted ? counted.forward : piece.oneway === -1 ? 0 : fallback;
  const backward = counted ? counted.backward : piece.oneway === 1 ? 0 : fallback;

  const fwd = directionLanes(piece, 1, forward, recorded, rules);
  const bwd = directionLanes(piece, -1, backward, recorded, rules);
  // Drawn order, left → right: the backward traveller's list reads right-to-left.
  const travel: Lane[] =
    rules.drivingSide === 'right' ? [...bwd.reverse(), ...fwd] : [...fwd, ...bwd.reverse()];

  // Kerb bands: cycle lanes (recorded only) inside parking (recorded only).
  const travelDir: 1 | -1 = piece.oneway === -1 ? -1 : 1;
  const travelKerb = kerbSide(travelDir, rules);
  const cycle = sidesOf(piece.cycleLane, oneway, travelKerb, true);
  const parking = sidesOf(piece.parking, oneway, travelKerb, false);

  const laneCount = travel.length;
  const fixed =
    (cycle.left ? CYCLE_LANE_WIDTH_M : 0) +
    (cycle.right ? CYCLE_LANE_WIDTH_M : 0) +
    (parking.left ? PARKING_WIDTH_M : 0) +
    (parking.right ? PARKING_WIDTH_M : 0);
  let laneWidth = LANE_WIDTH_M[piece.highway];
  let widthRecorded = false;
  if (piece.width !== undefined && laneCount > 0) {
    // A measured carriageway must not be rejected against ASSUMED lanes:
    // a wide road without lane tags still has its recorded width. Keep its
    // generic bands unmarked rather than inventing a count from that width.
    // Only recorded counts can contradict a measured per-lane width.
    const each = (piece.width - fixed) / laneCount;
    if (recorded ? each >= 2.3 && each <= 5 : each > 0) {
      laneWidth = each;
      widthRecorded = true;
    }
  }
  const width = laneWidth * laneCount + fixed;

  const bands: Band[] = [];
  let at = width / 2;
  const push = (
    kind: BandKind,
    dir: 1 | -1,
    w: number,
    turns: Turn[] | null,
    change: LaneChange | null = null,
  ) => {
    bands.push({ kind, dir, left: at, right: at - w, turns, change });
    at -= w;
  };
  const edgeDir = (side: 'left' | 'right'): 1 | -1 =>
    (side === 'left' ? travel[0]?.dir : travel.at(-1)?.dir) ?? travelDir;
  if (parking.left) push('parking', edgeDir('left'), PARKING_WIDTH_M, null);
  if (cycle.left) push('cycle', edgeDir('left'), CYCLE_LANE_WIDTH_M, null);
  for (const lane of travel) push(lane.kind, lane.dir, laneWidth, lane.turns, lane.change);
  if (cycle.right) push('cycle', edgeDir('right'), CYCLE_LANE_WIDTH_M, null);
  if (parking.right) push('parking', edgeDir('right'), PARKING_WIDTH_M, null);

  return {
    width,
    bands,
    dividers: dividersFor(piece.highway, bands, recorded, rules),
    forward,
    backward,
    recorded,
    widthRecorded,
  };
}

/**
 * The line between two same-direction lanes: dashed, unless `change:lanes`
 * records that one or both may not cross — solid where neither may, a solid
 * line beside a dashed one where only one may (the solid on the side whose
 * traffic may not cross). `a` is the drawn-left band.
 */
export function laneLine(a: Band, b: Band): Pick<Divider, 'style' | 'solidOn'> {
  if (!a.change || !b.change) return { style: 'dashed' };
  // Toward the other band: from the drawn left, that is the traveller's right
  // when the lanes run with the way, their left when against it.
  const aCrosses = a.dir === 1 ? a.change.right : a.change.left;
  const bCrosses = b.dir === 1 ? b.change.left : b.change.right;
  if (aCrosses && bCrosses) return { style: 'dashed' };
  if (!aCrosses && !bCrosses) return { style: 'solid' };
  return { style: 'mixed', solidOn: aCrosses ? 'right' : 'left' };
}

/** The line painted between each pair of bands, and at the edges. */
export function dividersFor(
  highway: RoadClass,
  bands: readonly Band[],
  recorded: boolean,
  rules: PaintRules,
): Divider[] {
  const out: Divider[] = [];
  const centreColour: PaintColour = rules.yellowCentre ? 'yellow' : 'white';
  const isTravel = (b: Band) => b.kind === 'lane' || b.kind === 'bus';
  for (let i = 0; i + 1 < bands.length; i++) {
    const a = bands[i];
    const b = bands[i + 1];
    const offset = a.right;
    if (isTravel(a) && isTravel(b)) {
      if (a.dir !== b.dir) {
        if (!recorded) {
          // The generic minimum: a dashed centre line on a through road.
          if (THROUGH_CLASSES.has(highway)) {
            out.push({
              offset,
              style: 'dashed',
              colour: centreColour,
              width: LINE_WIDTH_M.centre,
              role: 'centre',
            });
          }
          continue;
        }
        const both =
          bands.filter((x) => isTravel(x) && x.dir === 1).length >= 2 &&
          bands.filter((x) => isTravel(x) && x.dir === -1).length >= 2;
        const style: LineStyle =
          both || MAJOR_CLASSES.has(highway)
            ? 'double'
            : MIDDLE_CLASSES.has(highway)
              ? 'solid'
              : 'dashed';
        out.push({
          offset,
          style,
          colour: centreColour,
          width: LINE_WIDTH_M.centre,
          role: 'centre',
        });
      } else if (!recorded) {
        // Same-direction lanes we only assumed: no divider.
      } else if (a.kind === 'bus' || b.kind === 'bus') {
        out.push({ offset, style: 'solid', colour: 'white', width: LINE_WIDTH_M.bus, role: 'bus' });
      } else {
        out.push({
          offset,
          colour: 'white',
          width: LINE_WIDTH_M.lanes,
          role: 'lanes',
          ...laneLine(a, b),
        });
      }
    } else if (a.kind === 'cycle' || b.kind === 'cycle') {
      if (a.kind !== 'parking' && b.kind !== 'parking') {
        out.push({
          offset,
          style: 'solid',
          colour: 'white',
          width: LINE_WIDTH_M.cycle,
          role: 'cycle',
        });
      }
    }
  }
  if (EDGE_LINE_CLASSES.has(highway)) {
    const travel = bands.filter(isTravel);
    if (travel.length > 0) {
      const inset = LINE_WIDTH_M.edge;
      out.push({
        offset: travel[0].left - inset,
        style: 'solid',
        colour: 'white',
        width: LINE_WIDTH_M.edge,
        role: 'edge',
      });
      out.push({
        offset: (travel.at(-1)?.right ?? 0) + inset,
        style: 'solid',
        colour: 'white',
        width: LINE_WIDTH_M.edge,
        role: 'edge',
      });
    }
  }
  return out;
}

/** Whether two pieces draw the same carriageway (so a link may run through their joint). */
export function sameSection(a: CrossSection, b: CrossSection): boolean {
  if (Math.abs(a.width - b.width) > 0.01 || a.bands.length !== b.bands.length) return false;
  for (let i = 0; i < a.bands.length; i++) {
    const x = a.bands[i];
    const y = b.bands[i];
    if (x.kind !== y.kind || x.dir !== y.dir) return false;
  }
  return (
    a.dividers.length === b.dividers.length &&
    a.dividers.every(
      (d, i) =>
        d.style === b.dividers[i].style &&
        d.colour === b.dividers[i].colour &&
        d.solidOn === b.dividers[i].solidOn,
    )
  );
}

/**
 * Reverse a cross-section, for walking a piece against its drawn direction
 * (a link chains pieces drawn either way): offsets negate, the band order
 * flips, and each direction swaps.
 */
export function reverseSection(section: CrossSection): CrossSection {
  return {
    ...section,
    forward: section.backward,
    backward: section.forward,
    bands: section.bands
      .map((b) => ({ ...b, dir: (b.dir === 1 ? -1 : 1) as 1 | -1, left: -b.right, right: -b.left }))
      .reverse(),
    dividers: section.dividers
      .map((d) => ({
        ...d,
        offset: -d.offset,
        ...(d.solidOn
          ? { solidOn: d.solidOn === 'left' ? ('right' as const) : ('left' as const) }
          : {}),
      }))
      .reverse(),
  };
}
