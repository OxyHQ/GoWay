/**
 * Road tiles → the lane graph cars drive and the footway graph people walk.
 *
 * Pure and synchronous: it runs in the simulation worker whenever the set of
 * loaded road tiles changes, and in the tests on hand-made tiles.
 *
 * ## The frame
 *
 * Metres, x east and y NORTH, from the north-west corner of one z15 tile, the
 * ORIGIN ({@link SimFrame}). Converting a global tile unit to metres uses the
 * mercator scale at the origin tile's middle latitude — exactly what
 * `tileModelMatrix` uses to turn those metres back into mercator, so an agent
 * lands on the pixel its road is drawn at, wherever it is in the simulated
 * area (a few kilometres; the scale's own drift across that is a few parts in
 * ten thousand of a car's SPEED, never of its position).
 *
 * ## What is built
 *
 *  1. **Links.** Drivable pieces are chained across every node only two of
 *     them meet at (and that agree on direction, lanes and tunnel), so a link
 *     runs junction to junction. Signals and crossings inside a link become
 *     stops along it.
 *  2. **Lanes.** Each direction of a link gets its lanes — recorded `lanes*`
 *     tags, else a default per class — as polylines offset to the side the
 *     country drives on, trimmed back from each junction by about the width of
 *     the roads meeting there.
 *  3. **Connectors.** At each node, every incoming lane is joined to the
 *     outgoing directions it may take — no U-turn except at a dead end, kerb
 *     lane for the kerb-side turn, inner lane for the far one, recorded turn
 *     restrictions applied — by a cubic Bézier across the junction. Two
 *     connectors CONFLICT when their curves cross or they merge into one lane;
 *     the traffic model lets only one of a conflicting set be used at a time.
 *  4. **Signals.** A junction is signalised when a signal node is on it or
 *     within {@link SIGNAL_REACH_M} of it (OSM often tags the stop line, not
 *     the junction). Its approaches split into two phases by axis.
 *  5. **Crossings.** Where a footway crossing meets a road, or a crossing
 *     node is tagged, every lane over it gets a stop that holds while someone
 *     is on the crossing, and the crossing is gated by the junction's signal
 *     when it is near one.
 *  6. **Footways.** Walkable pieces as they are, plus a virtual sidewalk on
 *     each side of a road whose `sidewalk` tag says there is one.
 */
import type { DecodedRoadTile, RoadPiece } from '../roadTiles';
import type { DrivingSide } from './drivingSide';
import { createRng } from './rng';

const EXTENT = 4096;
const ZOOM = 15;

/** A junction's signal also governs signal nodes this close to it (stop lines, crossings). */
export const SIGNAL_REACH_M = 30;

/** Junction nodes closer than this share a signal controller. */
const CLUSTER_M = 25;

/** Lane width, metres. */
const LANE_WIDTH = 3.2;
const MOTORWAY_LANE_WIDTH = 3.6;

/** Default speed per class, km/h, where `maxspeed` is not recorded. A simulation parameter. */
export const DEFAULT_SPEED_KMH: Record<string, number> = {
  motorway: 100,
  motorway_link: 60,
  trunk: 80,
  trunk_link: 50,
  primary: 50,
  primary_link: 40,
  secondary: 50,
  secondary_link: 40,
  tertiary: 40,
  tertiary_link: 30,
  unclassified: 40,
  residential: 30,
  living_street: 15,
  service: 20,
  road: 30,
};

/** Default lanes per direction where `lanes*` is not recorded. A simulation parameter. */
function defaultLanes(highway: string, oneway: boolean): number {
  if (highway === 'motorway' || highway === 'trunk') return 2;
  if (oneway && (highway === 'primary' || highway === 'secondary')) return 2;
  return 1;
}

export interface SimFrame {
  /** The origin tile (z15). */
  originX: number;
  originY: number;
  /** Metres per global tile unit. */
  metresPerUnit: number;
}

/** The frame for an origin tile: metres per tile unit at its middle latitude. */
export function simFrame(originX: number, originY: number): SimFrame {
  const n = 2 ** ZOOM;
  const y = 180 - ((originY + 0.5) / n) * 360;
  const lat = (360 / Math.PI) * Math.atan(Math.exp((y * Math.PI) / 180)) - 90;
  const circumference = 2 * Math.PI * 6371008.8;
  // mercatorPerMetre(lat) = 1 / (C cos lat); one unit is 1/(n·EXTENT) mercator.
  const metresPerUnit = (circumference * Math.cos((lat * Math.PI) / 180)) / (n * EXTENT);
  return { originX, originY, metresPerUnit };
}

/** A polyline with cumulative lengths. */
export interface Polyline {
  xs: Float64Array;
  ys: Float64Array;
  /** `cum[i]`: metres from the start to point i. */
  cum: Float64Array;
  length: number;
}

export interface CrossingStop {
  s: number;
  crossing: number;
}

export interface SignalStop {
  s: number;
  signal: number;
  group: number;
}

/** A lane or a connector: anything a car can be on. */
export interface Path extends Polyline {
  id: number;
  kind: 'lane' | 'connector';
  /** Speed limit, m/s. */
  speed: number;
  /** Drawn hidden (tunnels). */
  hidden: boolean;
  /** Lanes: the connectors it may continue onto. Connectors: its one target lane. */
  next: number[];
  /** Stops for people on crossings along it. */
  crossings: CrossingStop[];
  /** Mid-link signals along it. */
  signals: SignalStop[];
  // Lane only (−1 / 0 on connectors).
  link: number;
  /** Lanes: the node it ends at (−1 on connectors). */
  endNode: number;
  /** Lanes: 0 is the kerb lane. */
  laneIndex: number;
  /** Lanes: no way on at the end — the loaded network's edge. Cars leave here. */
  terminal: boolean;
  // Connector only (−1 / [] on lanes).
  node: number;
  from: number;
  conflicts: number[];
  /** Signal controller gating entry, and which of its phases. −1: none. */
  signal: number;
  group: number;
  /** Connectors: 0 straight, 1 kerb-side turn, 2 far-side turn, 3 U-turn. */
  turn: number;
}

export interface SignalController {
  node: number;
  /** Seconds. */
  greenA: number;
  greenB: number;
  /** Amber plus all-red between phases. */
  clearance: number;
  cycle: number;
  offset: number;
  /** Mid-link (a pedestrian signal on a straight road): phase A cars, phase B people. */
  midLink: boolean;
}

export interface Crossing {
  node: number;
  x: number;
  y: number;
  /** Footway edges that cross here. */
  pedEdges: number[];
  /** −1: uncontrolled (cars yield to anyone on it). */
  signal: number;
  /** The phase of the CROSSED road: people walk while it is red. */
  group: number;
  /** Lane positions over it: `[path, s]`, for "is a car about to pass". */
  lanes: { path: number; s: number }[];
}

export interface PedEdge extends Polyline {
  id: number;
  a: number;
  b: number;
  /** The crossing it is part of, or −1. */
  crossing: number;
  hidden: boolean;
}

export interface NetworkNode {
  x: number;
  y: number;
  /** Global tile units, for keys. */
  gx: number;
  gy: number;
  carDegree: number;
}

export interface Network {
  frame: SimFrame;
  drivingSide: DrivingSide;
  nodes: NetworkNode[];
  paths: Path[];
  /** Lane path ids, for spawning. */
  lanes: number[];
  signals: SignalController[];
  crossings: Crossing[];
  pedEdges: PedEdge[];
  /** Per node: footway edges touching it. */
  pedAdjacency: number[][];
  stats: NetworkStats;
}

export interface NetworkStats {
  links: number;
  lanes: number;
  connectors: number;
  conflicts: number;
  signals: number;
  crossings: number;
  pedEdges: number;
  restrictionsApplied: number;
  laneKm: number;
  pedKm: number;
  buildMs: number;
}

// ── Geometry ─────────────────────────────────────────────────────────────

function polyline(points: readonly (readonly [number, number])[]): Polyline {
  const n = points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i][0];
    ys[i] = points[i][1];
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  return { xs, ys, cum, length: n > 0 ? cum[n - 1] : 0 };
}

/** The point and heading (radians, from east, counter-clockwise) at `s` metres along. */
export function pointAt(line: Polyline, s: number, out: { x: number; y: number; h: number }): void {
  const { xs, ys, cum } = line;
  const n = xs.length;
  if (n === 1 || line.length <= 0) {
    out.x = xs[0];
    out.y = ys[0];
    out.h = n > 1 ? Math.atan2(ys[n - 1] - ys[0], xs[n - 1] - xs[0]) : 0;
    return;
  }
  const clamped = s <= 0 ? 0 : s >= line.length ? line.length : s;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (clamped - cum[lo]) / span : 0;
  out.x = xs[lo] + (xs[hi] - xs[lo]) * t;
  out.y = ys[lo] + (ys[hi] - ys[lo]) * t;
  out.h = Math.atan2(ys[hi] - ys[lo], xs[hi] - xs[lo]);
}

/** Closest `s` on a polyline to a point, and the distance. */
export function project(line: Polyline, x: number, y: number): { s: number; d: number } {
  let best = { s: 0, d: Number.POSITIVE_INFINITY };
  for (let i = 0; i + 1 < line.xs.length; i++) {
    const ax = line.xs[i];
    const ay = line.ys[i];
    const dx = line.xs[i + 1] - ax;
    const dy = line.ys[i + 1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best.d) best = { s: line.cum[i] + t * Math.sqrt(len2), d };
  }
  return best;
}

/**
 * Offset a polyline sideways: positive `offset` is to the RIGHT of travel.
 * Mitred joins, the mitre capped at twice the offset so a hairpin cannot
 * throw a point across the street.
 */
export function offsetPolyline(
  points: readonly (readonly [number, number])[],
  offset: number,
): [number, number][] {
  const n = points.length;
  if (n < 2 || offset === 0) return points.map(([x, y]) => [x, y]);
  const out: [number, number][] = [];
  const normal = (i: number): [number, number] => {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const len = Math.hypot(dx, dy) || 1;
    // Right of (dx, dy) in a y-north frame is (dy, −dx).
    return [dy / len, -dx / len];
  };
  for (let i = 0; i < n; i++) {
    let nx: number;
    let ny: number;
    if (i === 0) [nx, ny] = normal(0);
    else if (i === n - 1) [nx, ny] = normal(n - 2);
    else {
      const [ax, ay] = normal(i - 1);
      const [bx, by] = normal(i);
      const mx = ax + bx;
      const my = ay + by;
      const mlen = Math.hypot(mx, my);
      if (mlen < 1e-6) {
        [nx, ny] = [ax, ay];
      } else {
        const cos = (mx / mlen) * ax + (my / mlen) * ay;
        const scale = Math.min(2, 1 / Math.max(cos, 0.5));
        nx = (mx / mlen) * scale;
        ny = (my / mlen) * scale;
      }
    }
    out.push([points[i][0] + nx * offset, points[i][1] + ny * offset]);
  }
  return out;
}

/** The part of a polyline between `from` and `to` metres along it. */
function slice(line: Polyline, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  const at = { x: 0, y: 0, h: 0 };
  pointAt(line, from, at);
  out.push([at.x, at.y]);
  for (let i = 0; i < line.xs.length; i++) {
    if (line.cum[i] > from && line.cum[i] < to) out.push([line.xs[i], line.ys[i]]);
  }
  pointAt(line, to, at);
  out.push([at.x, at.y]);
  return out;
}

function bezier(
  p0: readonly [number, number],
  h0: number,
  p3: readonly [number, number],
  h3: number,
  uTurn: boolean,
): [number, number][] {
  const dist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  if (dist < 0.05)
    return [
      [p0[0], p0[1]],
      [p3[0], p3[1]],
    ];
  const handle = uTurn ? Math.max(dist * 0.9, 5) : dist * 0.4;
  const p1 = [p0[0] + Math.cos(h0) * handle, p0[1] + Math.sin(h0) * handle];
  const p2 = [p3[0] - Math.cos(h3) * handle, p3[1] - Math.sin(h3) * handle];
  const steps = Math.max(2, Math.min(14, Math.ceil(dist / 1.5)));
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function polylinesCross(a: Polyline, b: Polyline): boolean {
  for (let i = 0; i + 1 < a.xs.length; i++) {
    for (let j = 0; j + 1 < b.xs.length; j++) {
      if (
        segmentsCross(
          a.xs[i],
          a.ys[i],
          a.xs[i + 1],
          a.ys[i + 1],
          b.xs[j],
          b.ys[j],
          b.xs[j + 1],
          b.ys[j + 1],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ── Build ────────────────────────────────────────────────────────────────

export interface NetworkInput {
  /**
   * `source`: where a tile's roads came from (the archive, the basemap). An
   * edge between tiles of different sources is a seam — their geometry does
   * not meet — so it counts as a cut, where cars leave rather than turn round.
   */
  tiles: readonly { x: number; y: number; data: DecodedRoadTile; source?: string }[];
  frame: SimFrame;
  drivingSide: DrivingSide;
  seed: number;
}

interface CarPiece {
  a: number;
  b: number;
  points: [number, number][];
  oneway: boolean;
  fwd: number;
  bwd: number;
  highway: string;
  speedKmh: number;
  tunnel: boolean;
  way: number;
  /** Sidewalks relative to the piece's (possibly reversed) direction. */
  walkLeft: boolean;
  walkRight: boolean;
}

interface Link {
  a: number;
  b: number;
  line: Polyline;
  points: [number, number][];
  oneway: boolean;
  fwd: number;
  bwd: number;
  highway: string;
  speed: number;
  tunnel: boolean;
  wayAtA: number;
  wayAtB: number;
  walkLeft: boolean;
  walkRight: boolean;
  /** Nodes strictly inside the chain. */
  interior: number[];
  halfWidth: number;
  /** Lane path ids, direction 0 (a→b) then 1 (b→a). */
  lanes: [number[], number[]];
}

export function buildNetwork(input: NetworkInput): Network {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const { frame, drivingSide } = input;
  const rng = createRng(input.seed ^ 0x51ed270b);
  const ox = frame.originX * EXTENT;
  const oy = frame.originY * EXTENT;
  const m = frame.metresPerUnit;
  const toMetres = (gx: number, gy: number): [number, number] => [(gx - ox) * m, -(gy - oy) * m];

  // ── Nodes, by exact global position ──
  const nodes: NetworkNode[] = [];
  const nodeIndex = new Map<number, number>();
  const BASE = 2 ** 24;
  const keyOf = (gx: number, gy: number) =>
    (Math.round(gx) - ox + BASE) * 2 ** 26 + (Math.round(gy) - oy + BASE);
  const nodeAt = (gx: number, gy: number): number => {
    const key = keyOf(gx, gy);
    let index = nodeIndex.get(key);
    if (index === undefined) {
      index = nodes.length;
      const [x, y] = toMetres(gx, gy);
      nodes.push({ x, y, gx: Math.round(gx), gy: Math.round(gy), carDegree: 0 });
      nodeIndex.set(key, index);
    }
    return index;
  };
  const findNode = (gx: number, gy: number) => nodeIndex.get(keyOf(gx, gy)) ?? -1;

  const loadedTiles = new Map<string, string>(
    input.tiles.map((t) => [`${t.x}/${t.y}`, t.source ?? '']),
  );
  const joined = (a: string, b: string) =>
    loadedTiles.has(a) && loadedTiles.has(b) && loadedTiles.get(a) === loadedTiles.get(b);
  // A node on the outer edge of the loaded tiles is where the network was CUT,
  // not a dead end: a car reaching it leaves rather than turning round.
  const onCutEdge = (node: NetworkNode): boolean => {
    const { gx, gy } = node;
    const tx = Math.floor(gx / EXTENT);
    const ty = Math.floor(gy / EXTENT);
    if (gx % EXTENT === 0 && !joined(`${tx - 1}/${ty}`, `${tx}/${ty}`)) {
      return true;
    }
    if (gy % EXTENT === 0 && !joined(`${tx}/${ty - 1}`, `${tx}/${ty}`)) {
      return true;
    }
    return false;
  };

  // ── Pieces ──
  const carPieces: CarPiece[] = [];
  const footPieces: { a: number; b: number; points: [number, number][]; piece: RoadPiece }[] = [];
  const crossingPieceNodes = new Set<number>();
  for (const tile of input.tiles) {
    for (const piece of tile.data.pieces) {
      const first = piece.points[0];
      const last = piece.points[piece.points.length - 1];
      let a = nodeAt(first[0], first[1]);
      let b = nodeAt(last[0], last[1]);
      if (a === b && piece.points.length < 3) continue;
      let points = piece.points.map(([gx, gy]) => toMetres(gx, gy));
      if (piece.foot) {
        footPieces.push({ a, b, points, piece });
        if (piece.footway === 'crossing') {
          crossingPieceNodes.add(a);
          crossingPieceNodes.add(b);
        }
      }
      if (!piece.car) continue;
      const oneway = piece.oneway !== undefined || piece.roundabout;
      let reversed = false;
      if (piece.oneway === -1) {
        points = points.slice().reverse();
        [a, b] = [b, a];
        reversed = true;
      }
      let fwd: number;
      let bwd: number;
      if (oneway) {
        fwd = piece.lanesForward ?? piece.lanes ?? defaultLanes(piece.highway, true);
        if (piece.oneway === -1 && piece.lanesBackward) fwd = piece.lanesBackward;
        bwd = 0;
      } else {
        const total = piece.lanes;
        fwd =
          piece.lanesForward ??
          (total ? Math.max(1, Math.floor(total / 2)) : defaultLanes(piece.highway, false));
        bwd =
          piece.lanesBackward ??
          (total ? Math.max(1, total - fwd) : defaultLanes(piece.highway, false));
      }
      const sidewalk = piece.sidewalk;
      let walkLeft = sidewalk === 'both' || sidewalk === 'left';
      let walkRight = sidewalk === 'both' || sidewalk === 'right';
      if (reversed) [walkLeft, walkRight] = [walkRight, walkLeft];
      carPieces.push({
        a,
        b,
        points,
        oneway,
        fwd: Math.min(4, Math.max(1, fwd)),
        bwd: oneway ? 0 : Math.min(4, Math.max(1, bwd)),
        highway: piece.highway,
        speedKmh: piece.maxspeed ?? DEFAULT_SPEED_KMH[piece.highway] ?? 30,
        tunnel: piece.tunnel,
        way: piece.way,
        walkLeft,
        walkRight,
      });
    }
  }

  // ── Car degree and chains ──
  const piecesAt = new Map<number, number[]>();
  for (let i = 0; i < carPieces.length; i++) {
    const { a, b } = carPieces[i];
    for (const n of a === b ? [a] : [a, b]) {
      nodes[n].carDegree++;
      const list = piecesAt.get(n);
      if (list) list.push(i);
      else piecesAt.set(n, [i]);
    }
  }
  const reverseCar = (p: CarPiece): CarPiece => ({
    ...p,
    a: p.b,
    b: p.a,
    points: p.points.slice().reverse(),
    fwd: p.bwd,
    bwd: p.fwd,
    walkLeft: p.walkRight,
    walkRight: p.walkLeft,
  });
  const compatible = (p: CarPiece, q: CarPiece) =>
    p.oneway === q.oneway &&
    p.fwd === q.fwd &&
    p.bwd === q.bwd &&
    p.tunnel === q.tunnel &&
    p.walkLeft === q.walkLeft &&
    p.walkRight === q.walkRight;

  const visited = new Uint8Array(carPieces.length);
  const links: Link[] = [];
  /** Oriented continuation of `piece` through its `b` end, or null. */
  const continueFrom = (piece: CarPiece): { index: number; piece: CarPiece } | null => {
    const n = piece.b;
    if (nodes[n].carDegree !== 2) return null;
    const around = piecesAt.get(n) ?? [];
    for (const index of around) {
      if (visited[index]) continue;
      let next = carPieces[index];
      if (next.a !== n) {
        if (next.oneway) continue; // would run against it
        next = reverseCar(next);
      }
      if (next.a !== n || !compatible(piece, next)) continue;
      return { index, piece: next };
    }
    return null;
  };
  for (let start = 0; start < carPieces.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    // Walk backwards to the chain's first piece, then forwards from it.
    let head = carPieces[start];
    const backwards: CarPiece[] = [];
    for (;;) {
      const back = continueFrom(reverseCar(head));
      if (!back) break;
      visited[back.index] = 1;
      head = reverseCar(back.piece);
      backwards.push(head);
    }
    const chain = [...backwards.reverse(), carPieces[start]];
    let tail = carPieces[start];
    for (;;) {
      const next = continueFrom(tail);
      if (!next) break;
      visited[next.index] = 1;
      chain.push(next.piece);
      tail = next.piece;
    }
    const points: [number, number][] = [];
    const interior: number[] = [];
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i];
      if (i > 0) interior.push(p.a);
      for (let j = i === 0 ? 0 : 1; j < p.points.length; j++) points.push(p.points[j]);
    }
    const first = chain[0];
    const last = chain[chain.length - 1];
    const width = first.highway === 'motorway' ? MOTORWAY_LANE_WIDTH : LANE_WIDTH;
    links.push({
      a: first.a,
      b: last.b,
      line: polyline(points),
      points,
      oneway: first.oneway,
      fwd: first.fwd,
      bwd: first.bwd,
      highway: first.highway,
      speed: first.speedKmh / 3.6,
      tunnel: first.tunnel,
      wayAtA: first.way,
      wayAtB: last.way,
      walkLeft: first.walkLeft,
      walkRight: first.walkRight,
      interior,
      halfWidth: (width * (first.fwd + first.bwd)) / 2,
      lanes: [[], []],
    });
  }

  // ── Junction setbacks ──
  const linksAt = new Map<number, number[]>();
  links.forEach((link, i) => {
    for (const n of link.a === link.b ? [link.a] : [link.a, link.b]) {
      const list = linksAt.get(n);
      if (list) list.push(i);
      else linksAt.set(n, [i]);
    }
  });
  /** The heading a link leaves `node` along, measured ~8 m out (past any kink at the node). */
  const departure = (link: Link, node: number): number => {
    const points = link.a === node ? link.points : link.points.slice().reverse();
    const [x0, y0] = points[0];
    let k = 1;
    while (k < points.length - 1 && Math.hypot(points[k][0] - x0, points[k][1] - y0) < 8) k++;
    return Math.atan2(points[k][1] - y0, points[k][0] - x0);
  };
  /**
   * How far a link's lanes stop short of a junction: until they clear every
   * other road meeting there. Two roads leaving a node at angle θ are
   * `2·d·sin(θ/2)` apart at distance d, so their lanes stop overlapping at
   * `d = (w₁ + w₂) / (2·sin(θ/2))` — a few metres at a crossroads, tens of
   * metres where a slip road peels off at a shallow angle, which is where
   * lanes drawn at their real offsets would otherwise run through each other.
   */
  const setback = (node: number, link: Link): number => {
    const around = linksAt.get(node) ?? [];
    const degree = nodes[node].carDegree;
    if (degree <= 1) return 0;
    const own = departure(link, node);
    // At least a few metres everywhere: where a chain closes on itself or
    // bends at a node, the two lane ends need room for a curve between them.
    let needed = 3;
    for (const index of around) {
      const other = links[index];
      if (other === link) continue;
      const theta = Math.abs(wrapAngle(departure(other, node) - own));
      const apart = 2 * Math.sin(Math.max(theta, 0.15) / 2);
      needed = Math.max(needed, (link.halfWidth + other.halfWidth + 1) / apart);
    }
    const cap = degree === 2 ? 3 : 40;
    return Math.min(needed, cap, link.line.length * 0.42);
  };

  // ── Lanes ──
  const paths: Path[] = [];
  const lanes: number[] = [];
  const sideSign = drivingSide === 'right' ? 1 : -1;
  const newPath = (kind: Path['kind'], line: Polyline, speed: number, hidden: boolean): Path => {
    const path: Path = {
      ...line,
      id: paths.length,
      kind,
      speed,
      hidden,
      next: [],
      crossings: [],
      signals: [],
      link: -1,
      endNode: -1,
      laneIndex: 0,
      terminal: false,
      node: -1,
      from: -1,
      conflicts: [],
      signal: -1,
      group: -1,
      turn: 0,
    };
    paths.push(path);
    return path;
  };
  let laneMetres = 0;
  links.forEach((link, linkIndex) => {
    const width = link.highway === 'motorway' ? MOTORWAY_LANE_WIDTH : LANE_WIDTH;
    for (const dir of [0, 1] as const) {
      const count = dir === 0 ? link.fwd : link.bwd;
      if (count === 0) continue;
      const travel = dir === 0 ? link.points : link.points.slice().reverse();
      const startNode = dir === 0 ? link.a : link.b;
      const endNode = dir === 0 ? link.b : link.a;
      for (let i = 0; i < count; i++) {
        // Lane 0 is the kerb lane. Two-way: the lanes fill one side of the
        // centre line; one-way: they are centred on it.
        const fromCentre = link.oneway
          ? ((count - 1) / 2 - i) * width
          : (count - 1 - i + 0.5) * width;
        const line = polyline(offsetPolyline(travel, fromCentre * sideSign));
        const s0 = setback(startNode, link);
        const s1 = line.length - setback(endNode, link);
        const trimmed = s1 - s0 > 0.5 ? polyline(slice(line, s0, s1)) : line;
        const path = newPath('lane', trimmed, link.speed, link.tunnel);
        path.link = linkIndex;
        path.endNode = endNode;
        path.laneIndex = i;
        link.lanes[dir].push(path.id);
        lanes.push(path.id);
        laneMetres += trimmed.length;
      }
    }
  });

  // ── Restrictions, by via node ──
  const restrictionsAt = new Map<number, { from: number; to: number; type: 'no' | 'only' }[]>();
  for (const tile of input.tiles) {
    for (const r of tile.data.restrictions) {
      const node = findNode(r.x, r.y);
      if (node < 0) continue;
      const list = restrictionsAt.get(node);
      const entry = { from: r.from, to: r.to, type: r.type };
      if (list) list.push(entry);
      else restrictionsAt.set(node, [entry]);
    }
  }
  let restrictionsApplied = 0;

  // ── Connectors ──
  const heading = (line: Polyline, atEnd: boolean) => {
    const n = line.xs.length;
    return atEnd
      ? Math.atan2(line.ys[n - 1] - line.ys[n - 2], line.xs[n - 1] - line.xs[n - 2])
      : Math.atan2(line.ys[1] - line.ys[0], line.xs[1] - line.xs[0]);
  };
  const kerbTurnSign = drivingSide === 'right' ? -1 : 1; // right turn is negative (clockwise)
  const connectorsAt = new Map<number, number[]>();
  for (const [node, around] of linksAt) {
    // Directions arriving at and leaving this node.
    const incoming: { link: number; dir: 0 | 1; lanes: number[]; way: number }[] = [];
    const outgoing: { link: number; dir: 0 | 1; lanes: number[]; way: number }[] = [];
    for (const li of around) {
      const link = links[li];
      if (link.b === node && link.lanes[0].length > 0) {
        incoming.push({ link: li, dir: 0, lanes: link.lanes[0], way: link.wayAtB });
      }
      if (link.a === node && link.lanes[1].length > 0) {
        incoming.push({ link: li, dir: 1, lanes: link.lanes[1], way: link.wayAtA });
      }
      if (link.a === node && link.lanes[0].length > 0) {
        outgoing.push({ link: li, dir: 0, lanes: link.lanes[0], way: link.wayAtA });
      }
      if (link.b === node && link.lanes[1].length > 0) {
        outgoing.push({ link: li, dir: 1, lanes: link.lanes[1], way: link.wayAtB });
      }
    }
    const cut = onCutEdge(nodes[node]);
    const created: number[] = [];
    for (const inc of incoming) {
      let options = outgoing.filter((out) => !(out.link === inc.link && out.dir !== inc.dir));
      // A dead end (a cul-de-sac, not the edge of what is loaded): turn round.
      if (options.length === 0 && !cut) options = outgoing;
      const rules = restrictionsAt.get(node)?.filter((r) => r.from === inc.way && inc.way !== 0);
      if (rules && rules.length > 0) {
        const before = options.length;
        for (const rule of rules) {
          options =
            rule.type === 'only'
              ? options.filter((out) => out.way === rule.to)
              : options.filter((out) => out.way !== rule.to);
        }
        if (options.length !== before) restrictionsApplied++;
      }
      const laneCount = inc.lanes.length;
      for (let i = 0; i < laneCount; i++) {
        const fromPath = paths[inc.lanes[i]];
        const h0 = heading(fromPath, true);
        const end: [number, number] = [
          fromPath.xs[fromPath.xs.length - 1],
          fromPath.ys[fromPath.ys.length - 1],
        ];
        const candidates: { out: (typeof outgoing)[number]; turn: number; kind: string }[] = [];
        for (const out of options) {
          const target = paths[out.lanes[0]];
          const turn = wrapAngle(heading(target, false) - h0);
          const uTurn = out.link === inc.link && out.dir !== inc.dir;
          const kind =
            uTurn || Math.abs(turn) > 2.6
              ? 'far'
              : Math.abs(turn) < 0.6
                ? 'straight'
                : Math.sign(turn) === kerbTurnSign
                  ? 'kerb'
                  : 'far';
          candidates.push({ out, turn, kind });
        }
        // Lane discipline: kerb lane turns kerb-side, inner lane far-side.
        let allowed = candidates;
        if (laneCount > 1) {
          allowed = candidates.filter((c) =>
            i === 0
              ? c.kind !== 'far'
              : i === laneCount - 1
                ? c.kind !== 'kerb'
                : c.kind === 'straight',
          );
          if (allowed.length === 0) allowed = candidates;
        }
        for (const { out, kind } of allowed) {
          const m = out.lanes.length;
          const j = kind === 'kerb' ? 0 : kind === 'far' ? m - 1 : Math.min(i, m - 1);
          const target = paths[out.lanes[j]];
          const start: [number, number] = [target.xs[0], target.ys[0]];
          const uTurn = out.link === inc.link && out.dir !== inc.dir;
          const line = polyline(bezier(end, h0, start, heading(target, false), uTurn));
          const speed = Math.min(fromPath.speed, target.speed, kind === 'straight' ? 1e9 : 6);
          const connector = newPath('connector', line, speed, fromPath.hidden && target.hidden);
          connector.node = node;
          connector.from = fromPath.id;
          connector.next = [target.id];
          connector.turn = uTurn ? 3 : kind === 'straight' ? 0 : kind === 'kerb' ? 1 : 2;
          fromPath.next.push(connector.id);
          created.push(connector.id);
        }
      }
    }
    for (const inc of incoming) {
      for (const lane of inc.lanes) paths[lane].terminal = paths[lane].next.length === 0;
    }
    if (created.length > 0) connectorsAt.set(node, created);
  }

  // ── Conflicts ──
  let conflictPairs = 0;
  for (const created of connectorsAt.values()) {
    if (created.length < 2) continue;
    for (let i = 0; i < created.length; i++) {
      const p = paths[created[i]];
      for (let j = i + 1; j < created.length; j++) {
        const q = paths[created[j]];
        if (p.from === q.from) continue; // diverging from one lane: follow, never collide
        if (p.next[0] === q.next[0] || polylinesCross(p, q)) {
          p.conflicts.push(q.id);
          q.conflicts.push(p.id);
          conflictPairs++;
        }
      }
    }
  }

  // ── Signals ──
  const signals: SignalController[] = [];
  const signalAt = new Map<number, number>();
  const signalNodes = new Set<number>();
  for (const tile of input.tiles) {
    for (const special of tile.data.nodes) {
      const isSignal =
        special.kind === 'signals' ||
        (special.kind === 'crossing' && special.crossing === 'traffic_signals');
      if (!isSignal) continue;
      const node = findNode(special.x, special.y);
      if (node >= 0 && nodes[node].carDegree > 0) signalNodes.add(node);
    }
  }
  // Junctions on a grid of SIGNAL_REACH_M cells, for "the junction near this signal".
  const junctionGrid = new Map<number, number[]>();
  const cellOf = (v: number) => Math.floor(v / SIGNAL_REACH_M);
  const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
  nodes.forEach((node, index) => {
    if (node.carDegree < 3) return;
    const key = cellKey(cellOf(node.x), cellOf(node.y));
    const list = junctionGrid.get(key);
    if (list) list.push(index);
    else junctionGrid.set(key, [index]);
  });
  const nearestJunction = (node: number): number => {
    const { x, y } = nodes[node];
    if (nodes[node].carDegree >= 3) return node;
    let best = -1;
    let bestD = SIGNAL_REACH_M;
    const cx = cellOf(x);
    const cy = cellOf(y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of junctionGrid.get(cellKey(cx + dx, cy + dy)) ?? []) {
          const d = Math.hypot(nodes[index].x - x, nodes[index].y - y);
          if (d < bestD) {
            bestD = d;
            best = index;
          }
        }
      }
    }
    return best;
  };
  const controllerFor = (node: number, midLink: boolean): number => {
    const existing = signalAt.get(node);
    if (existing !== undefined) return existing;
    // Junction nodes a few metres apart (a dual carriageway, a chamfered
    // corner) are ONE junction to a driver: one controller, one cycle.
    if (!midLink) {
      for (const [other, id] of signalAt) {
        if (signals[id].midLink) continue;
        if (
          Math.hypot(nodes[other].x - nodes[node].x, nodes[other].y - nodes[node].y) < CLUSTER_M
        ) {
          signalAt.set(node, id);
          return id;
        }
      }
    }
    const greenA = midLink ? rng.range(24, 36) : rng.range(18, 30);
    const greenB = midLink ? rng.range(10, 16) : rng.range(18, 30);
    const clearance = 4;
    const cycle = greenA + greenB + 2 * clearance;
    const id = signals.length;
    signals.push({ node, greenA, greenB, clearance, cycle, offset: rng.range(0, cycle), midLink });
    signalAt.set(node, id);
    return id;
  };
  /** The phase (0/1) of an approach arriving at a junction with heading `h`. */
  const phaseAxes = new Map<number, number>();
  const groupFor = (junction: number, h: number): number => {
    const axis = ((h % Math.PI) + Math.PI) % Math.PI;
    // Per controller, so the nodes of one clustered junction agree on phases.
    const key = signalAt.get(junction) ?? -1 - junction;
    let reference = phaseAxes.get(key);
    if (reference === undefined) {
      reference = axis;
      phaseAxes.set(key, axis);
    }
    const diff = Math.abs(axis - reference);
    return Math.min(diff, Math.PI - diff) < Math.PI / 4 ? 0 : 1;
  };
  const signalledJunctions = new Set<number>();
  for (const node of signalNodes) {
    const junction = nearestJunction(node);
    if (junction >= 0) {
      signalledJunctions.add(junction);
      controllerFor(junction, false);
    }
  }
  // Gate every connector of a signalled junction by its approach's phase.
  for (const junction of signalledJunctions) {
    const controller = signalAt.get(junction) as number;
    for (const id of connectorsAt.get(junction) ?? []) {
      const connector = paths[id];
      const from = paths[connector.from];
      connector.signal = controller;
      connector.group = groupFor(junction, heading(from, true));
    }
  }
  // A signal with no junction near it is a mid-block pedestrian light.
  const linkOfInterior = new Map<number, number>();
  links.forEach((link, i) => {
    for (const n of link.interior) linkOfInterior.set(n, i);
  });
  for (const node of signalNodes) {
    if (nearestJunction(node) >= 0) continue;
    const li = linkOfInterior.get(node);
    if (li === undefined) continue;
    const controller = controllerFor(node, true);
    for (const dir of [0, 1] as const) {
      for (const id of links[li].lanes[dir]) {
        const lane = paths[id];
        const { s, d } = project(lane, nodes[node].x, nodes[node].y);
        if (d < links[li].halfWidth + 3 && s > 1 && s < lane.length - 1) {
          lane.signals.push({ s: Math.max(0, s - 4), signal: controller, group: 0 });
        }
      }
    }
  }

  // ── Footways ──
  const pedEdges: PedEdge[] = [];
  const pedAdjacency: number[][] = nodes.map(() => []);
  let pedMetres = 0;
  const addPedEdge = (
    a: number,
    b: number,
    points: [number, number][],
    hidden: boolean,
  ): PedEdge => {
    const edge: PedEdge = {
      ...polyline(points),
      id: pedEdges.length,
      a,
      b,
      crossing: -1,
      hidden,
    };
    pedEdges.push(edge);
    pedAdjacency[a].push(edge.id);
    if (b !== a) pedAdjacency[b].push(edge.id);
    pedMetres += edge.length;
    return edge;
  };
  const crossingEdges: { edge: PedEdge; node: number }[] = [];
  for (const { a, b, points, piece } of footPieces) {
    if (points.length < 2) continue;
    const edge = addPedEdge(a, b, points, piece.tunnel);
    if (piece.footway === 'crossing') {
      const roadEnd = nodes[a].carDegree > 0 ? a : nodes[b].carDegree > 0 ? b : -1;
      if (roadEnd >= 0) crossingEdges.push({ edge, node: roadEnd });
    }
  }
  for (const link of links) {
    for (const side of [link.walkRight ? 1 : 0, link.walkLeft ? -1 : 0]) {
      if (side === 0) continue;
      const points = offsetPolyline(link.points, side * (link.halfWidth + 2));
      addPedEdge(link.a, link.b, points, link.tunnel);
    }
  }

  // ── Crossings ──
  const connectorsInto = new Map<number, number[]>();
  for (const path of paths) {
    if (path.kind !== 'connector') continue;
    const list = connectorsInto.get(path.next[0]);
    if (list) list.push(path.id);
    else connectorsInto.set(path.next[0], [path.id]);
  }
  const crossings: Crossing[] = [];
  const crossingAt = new Map<number, number>();
  const crossingNodes = new Set<number>(crossingPieceNodes);
  for (const tile of input.tiles) {
    for (const special of tile.data.nodes) {
      if (special.kind !== 'crossing') continue;
      const node = findNode(special.x, special.y);
      if (node >= 0) crossingNodes.add(node);
    }
  }
  for (const node of crossingNodes) {
    if (nodes[node].carDegree === 0) continue;
    const id = crossings.length;
    const crossing: Crossing = {
      node,
      x: nodes[node].x,
      y: nodes[node].y,
      pedEdges: [],
      signal: -1,
      group: 0,
      lanes: [],
    };
    // The links over it: as an interior node, or at either end.
    const over: number[] = [];
    const li = linkOfInterior.get(node);
    if (li !== undefined) over.push(li);
    for (const end of linksAt.get(node) ?? []) over.push(end);
    for (const linkIndex of over) {
      const link = links[linkIndex];
      for (const dir of [0, 1] as const) {
        for (const laneId of link.lanes[dir]) {
          const lane = paths[laneId];
          const { s, d } = project(lane, crossing.x, crossing.y);
          if (d > link.halfWidth + 4) continue;
          if (s > 0.5 && s < lane.length - 0.5) {
            lane.crossings.push({ s, crossing: id });
            crossing.lanes.push({ path: laneId, s });
          } else {
            // At the junction itself: the stop goes on the connectors leaving
            // or entering this lane, where they pass the crossing.
            const connectors =
              s <= 0.5
                ? (connectorsInto.get(laneId) ?? []).map((c) => paths[c])
                : lane.next.map((c) => paths[c]);
            for (const connector of connectors) {
              const hit = project(connector, crossing.x, crossing.y);
              if (hit.d < link.halfWidth + 4) {
                connector.crossings.push({ s: hit.s, crossing: id });
                crossing.lanes.push({ path: connector.id, s: hit.s });
              }
            }
          }
        }
      }
    }
    // Gated by a signal: its own (mid-block) or a junction's within reach.
    const own = signalAt.get(node);
    if (own !== undefined && signals[own].midLink) {
      // A mid-block light: phase A is the cars', so people walk in phase B.
      crossing.signal = own;
      crossing.group = 0;
    } else {
      const junction = nearestJunction(node);
      if (junction >= 0 && signalledJunctions.has(junction)) {
        crossing.signal = signalAt.get(junction) as number;
        // The crossed road's phase: the heading of the road through the crossing.
        const linkIndex = over[0];
        if (linkIndex !== undefined) {
          const link = links[linkIndex];
          const h = Math.atan2(
            link.points[link.points.length - 1][1] - link.points[0][1],
            link.points[link.points.length - 1][0] - link.points[0][0],
          );
          crossing.group = groupFor(junction, h);
        }
      }
    }
    for (const lane of crossing.lanes) {
      for (const stop of paths[lane.path].crossings) {
        if (stop.crossing === id) stop.s = Math.max(0, stop.s - 2.5);
      }
    }
    crossings.push(crossing);
    crossingAt.set(node, id);
  }
  for (const { edge, node } of crossingEdges) {
    const id = crossingAt.get(node);
    if (id === undefined) continue;
    edge.crossing = id;
    crossings[id].pedEdges.push(edge.id);
  }

  for (const path of paths) path.crossings.sort((p, q) => p.s - q.s);

  const connectors = paths.length - lanes.length;
  return {
    frame,
    drivingSide,
    nodes,
    paths,
    lanes,
    signals,
    crossings,
    pedEdges,
    pedAdjacency,
    stats: {
      links: links.length,
      lanes: lanes.length,
      connectors,
      conflicts: conflictPairs,
      signals: signals.length,
      crossings: crossings.length,
      pedEdges: pedEdges.length,
      restrictionsApplied,
      laneKm: laneMetres / 1000,
      pedKm: pedMetres / 1000,
      buildMs: typeof performance !== 'undefined' ? performance.now() - started : 0,
    },
  };
}

/**
 * Whether a controller's phase lets traffic in at `t` seconds. `clearance`
 * between the phases is amber-then-red for everyone: nobody NEW enters.
 */
export function phaseGreen(controller: SignalController, group: number, t: number): boolean {
  const local =
    (((t + controller.offset) % controller.cycle) + controller.cycle) % controller.cycle;
  if (group === 0) return local < controller.greenA;
  const startB = controller.greenA + controller.clearance;
  return local >= startB && local < startB + controller.greenB;
}
