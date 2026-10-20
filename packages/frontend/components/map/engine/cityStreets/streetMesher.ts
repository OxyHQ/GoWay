/**
 * Road tiles → the street surfaces and markings of ONE z15 tile, in that
 * tile's local metres (x east, y north from its north-west corner — the frame
 * `tileModelMatrix` places), for the street-detail renderer
 * (`docs/MAP_STREETS.md`).
 *
 * Pure and synchronous; runs in the street worker, and in the tests.
 *
 * ## How
 *
 * 1. **The graph is the simulation's.** Drivable pieces from the tile and its
 *    loaded neighbours (so a junction near the edge sees all its arms) are
 *    chained junction to junction by `chainPieces` (`roads/roadGraph.ts`),
 *    continuing through a node only where the carriageway does not change
 *    (`lanes.ts` → `sameSection`) and does not turn sharply.
 * 2. **Junctions.** Complete road corridors meet at their actual end
 *    cross-sections. Cuts reserve room for paint; they never erase a bend.
 *    `StreetTopology` unions corridors, subtracts them from sidewalks and
 *    paving, and triangulates one non-overlapping partition per bridge level.
 * 3. **Links** are full centreline strips, `crossSection` wide; recorded
 *    sidewalks are raised slabs beside them; a separately mapped
 *    `footway=sidewalk` is a slab along its line, widened to the nearest
 *    parallel kerb.
 * 4. **Markings** from data only (`lanes.ts`, `markings.ts`): dividers,
 *    crossings at mapped crossings, stop lines at recorded signals, stop and
 *    give-way signs, arrows from `turn:lanes`, bus and cycle lanes, and the
 *    street's name on long straight stretches.
 *
 * Surfaces are clipped to their owning tile after all neighbours contribute
 * to the union. Paint belongs to its anchor's tile. Both have one owner.
 */

import type { DecodedRoadTile, RoadNode, RoadPiece } from '../roads/roadTiles';
import { BRIDGE_MEMBER_MAX_OFFSET_M } from '../roads/bridgeGeometry';
import {
  chainPieces,
  offsetPolyline,
  type Polyline,
  pointAt,
  polyline,
  project,
  simFrame,
  slice,
} from '../roads/roadGraph';
import {
  type Band,
  type CrossSection,
  crossSection,
  LINE_WIDTH_M,
  type PaintRules,
  reverseSection,
  sameSection,
} from './lanes';
import { arrowKey, arrowParts, type CrossingStyle, crossingStyle } from './markings';
import {
  Buffers,
  LAYER,
  MODE,
  PAINT,
  type PackedMarkings,
  type PackedSurfaces,
  packMarkings,
  packSurfaces,
  subdivideSurfaces,
  SURFACE,
} from './meshBuffers';
import { ARROW_CELL, type StreetAtlas } from './streetAtlas';
import { StreetTopology } from './surfaceTopology';
import { densifyToLattice, splitToLattice } from './groundLattice';

const EXTENT = 4096;

/** Geometry constants. All styling — sizes a road-marking code would allow — unless noted. */
export const STREET = {
  /** Kerb height of a sidewalk slab, metres. */
  kerbM: 0.15,
  /** Sidewalk width where none is recorded (`sidewalk:width`), metres. */
  sidewalkM: 2.5,
  /** Half-width of a separately mapped sidewalk away from the road, metres. */
  footwayHalfM: 1.5,
  /** How far a mapped sidewalk reaches for a parallel kerb, metres. */
  kerbReachM: 8,
  /** Longest straight piece of any strip, so the ground can follow terrain, metres. */
  stepM: 6,
  /** Crossing width along the road, metres. */
  crossingM: 3,
  zebraBarM: 0.5,
  zebraPitchM: 1.0,
  /** Dashed lane lines: dash, gap. */
  dashM: [3, 6] as const,
  /** Gap between a stop line and the crossing (or junction) it guards. */
  stopGapM: 1,
  /** Arrows: length along the lane, width across it. */
  arrowM: { length: 5, width: 1.6 },
  /** A second arrow this far behind the first, where the link is long enough. */
  arrowRepeatM: 28,
  /** Lane words: letters stretched this much along the road (for the oblique view). */
  wordStretch: 2.5,
  /** A street name needs this much clear road at either end (stop line, arrows). */
  nameClearM: 14,
  /** Names repeat every so often on a long link. */
  nameEveryM: 180,
  /** Furthest paint is held back at an acute junction, metres. */
  maxTrimM: 40,
} as const;

/** A link: a chain of drivable pieces, junction to junction, in metres. */
interface Link {
  a: number;
  b: number;
  points: [number, number][];
  line: Polyline;
  section: CrossSection;
  /** Sections at either end (the end pieces': turn lanes often start mid-chain). */
  startSection: CrossSection;
  endSection: CrossSection;
  piece: RoadPiece;
  drawable: boolean;
  /** Attached sidewalk width on each side (0: absent or mapped separately). */
  walkLeft: number;
  walkRight: number;
  /** Interior nodes and their stations. */
  interior: { node: number; s: number }[];
  trimA: number;
  trimB: number;
  paving: boolean;
}

interface CarPiece {
  a: number;
  b: number;
  oneway: boolean;
  points: [number, number][];
  section: CrossSection;
  piece: RoadPiece;
  walkLeft: number;
  walkRight: number;
}

export interface StreetMeshInput {
  /** Shared terrain facets used as the seed for adaptive grounding. */
  groundMeshCells?: number;
  /** The tile to mesh, on the z15 grid. */
  tile: { x: number; y: number };
  /** That tile's road data and its loaded neighbours'. */
  tiles: readonly { x: number; y: number; data: DecodedRoadTile }[];
  rules: PaintRules;
  atlas: StreetAtlas;
}

export interface StreetMeshStats {
  links: number;
  junctions: number;
  crossings: number;
  stopLines: number;
  arrows: number;
  words: number;
  names: number;
  sidewalks: number;
  /** Separate cycle tracks drawn (schema 3). */
  cycleways: number;
  surfaceTriangles: number;
  markingTriangles: number;
}

export interface StreetMesh {
  surfaces: PackedSurfaces;
  markings: PackedMarkings;
  stats: StreetMeshStats;
  /**
   * Where each painted name lies: points every few metres along its text, in
   * tile metres — so the host can keep its own flat label for that street off
   * exactly that stretch (`city3dLayer.web.ts` → the label blockers).
   */
  paintedNames: [number, number][];
}

/** Spacing of the {@link StreetMesh.paintedNames} points along a name, metres. */
export const PAINTED_NAME_STEP_M = 6;

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/** Signed offset along a sidewalk's (possibly mitred) left normal to a kerb segment. */
export function kerbOffset(
  x: number,
  y: number,
  nx: number,
  ny: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number | null {
  const dx = bx - ax;
  const dy = by - ay;
  const det = cross(nx, ny, dx, dy);
  if (Math.abs(det) < 1e-6) return null;
  const along = cross(ax - x, ay - y, nx, ny) / det;
  if (along < 0 || along > 1) return null;
  return cross(ax - x, ay - y, dx, dy) / det;
}

/** Unit right normals of a polyline, mitred (the simulation's `offsetPolyline` at 1 m). */
function rightNormals(points: readonly [number, number][]): [number, number][] {
  return offsetPolyline(points, 1).map(([x, y], i) => [x - points[i][0], y - points[i][1]]);
}

/** Insert points so no segment is longer than `step`. */
export function resample(points: readonly [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  if (points.length > 0) out.push([...points[points.length - 1]] as [number, number]);
  return out;
}

/** Upper-case for paint, and the English street-type suffixes US pavements abbreviate. */
const SUFFIX: Record<string, string> = {
  AVENUE: 'AVE',
  STREET: 'ST',
  BOULEVARD: 'BLVD',
  ROAD: 'RD',
  DRIVE: 'DR',
  PLACE: 'PL',
  LANE: 'LN',
  PARKWAY: 'PKWY',
  HIGHWAY: 'HWY',
  EXPRESSWAY: 'EXPY',
  TERRACE: 'TER',
  COURT: 'CT',
};
export function paintedName(name: string): string {
  const upper = name.toUpperCase();
  const words = upper.split(' ');
  const last = words[words.length - 1];
  if (words.length > 1 && SUFFIX[last]) words[words.length - 1] = SUFFIX[last];
  return words.join(' ');
}

/**
 * Whether every character can be drawn glyph by glyph: Latin, Greek,
 * Cyrillic, CJK, kana, hangul. A script that needs shaping (Arabic, Hebrew,
 * the Indic scripts, Thai) is not painted rather than painted wrong.
 */
export function paintableScript(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x0590) continue;
    if (c >= 0x1e00 && c <= 0x1fff) continue; // Latin and Greek extended
    if (c >= 0x2000 && c <= 0x206f) continue; // punctuation
    if (c >= 0x3000 && c <= 0x30ff) continue; // CJK punctuation, kana
    if (c >= 0x3400 && c <= 0x9fff) continue; // CJK
    if (c >= 0xac00 && c <= 0xd7af) continue; // hangul
    return false;
  }
  return true;
}

export function meshStreetTile(input: StreetMeshInput): StreetMesh {
  const { tile, rules, atlas } = input;
  const frame = simFrame(tile.x, tile.y);
  const m = frame.metresPerUnit;
  const size = EXTENT * m;
  const lattice = input.groundMeshCells ? { cells: input.groundMeshCells, sizeM: size } : null;
  const ox = tile.x * EXTENT;
  const oy = tile.y * EXTENT;
  const toMetres = (gx: number, gy: number): [number, number] => [(gx - ox) * m, -(gy - oy) * m];
  const inTile = (x: number, y: number) => x >= 0 && x < size && y <= 0 && y > -size;
  /** Whether a polyline comes within `margin` metres of the tile (else nothing of it is ours). */
  const touches = (points: readonly [number, number][], margin = 1) => {
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1],
        [bx, by] = points[i];
      if (
        Math.max(ax, bx) >= -margin &&
        Math.min(ax, bx) <= size + margin &&
        Math.max(ay, by) >= -size - margin &&
        Math.min(ay, by) <= margin
      )
        return true;
    }
    return false;
  };

  const paintedNames: [number, number][] = [];
  const stats: StreetMeshStats = {
    links: 0,
    junctions: 0,
    crossings: 0,
    stopLines: 0,
    arrows: 0,
    words: 0,
    names: 0,
    sidewalks: 0,
    cycleways: 0,
    surfaceTriangles: 0,
    markingTriangles: 0,
  };

  // ── Nodes ──
  const nodeIndex = new Map<number, number>();
  const nodePos: [number, number][] = [];
  // Global tile units relative to the tile, as one exact number (the simulation's key).
  const BASE = 2 ** 24;
  const nodeOf = (gx: number, gy: number): number => {
    const key = (Math.round(gx) - ox + BASE) * 2 ** 26 + (Math.round(gy) - oy + BASE);
    let index = nodeIndex.get(key);
    if (index === undefined) {
      index = nodePos.length;
      nodePos.push(toMetres(gx, gy));
      nodeIndex.set(key, index);
    }
    return index;
  };
  const tagged = new Map<number, RoadNode>();
  const crossingWays = new Map<number, { dir: [number, number]; piece: RoadPiece }>();
  const footways: { points: [number, number][]; piece: RoadPiece }[] = [];
  const carPieces: CarPiece[] = [];

  for (const t of input.tiles) {
    for (const node of t.data.nodes) tagged.set(nodeOf(node.x, node.y), node);
    for (const piece of t.data.pieces) {
      const first = piece.points[0];
      const last = piece.points[piece.points.length - 1];
      const a = nodeOf(first[0], first[1]);
      const b = nodeOf(last[0], last[1]);
      const points = piece.points.map(([gx, gy]) => toMetres(gx, gy));
      if (!piece.car && !piece.motorOnly) {
        if (piece.footway === 'crossing') {
          for (const [end, from, to] of [
            [a, points[0], points[1]],
            [b, points[points.length - 1], points[points.length - 2]],
          ] as const) {
            const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
            if (len > 0) {
              crossingWays.set(end, {
                dir: [(to[0] - from[0]) / len, (to[1] - from[1]) / len],
                piece,
              });
            }
          }
        } else if (!piece.tunnel) {
          footways.push({ points, piece });
        }
        continue;
      }
      if (a === b && points.length < 3) continue;
      let section = crossSection(piece, rules);
      let pts = points;
      let [pa, pb] = [a, b];
      const sw = piece.sidewalkWidth ?? STREET.sidewalkM;
      // A separate sidewalk is drawn only from its own mapped geometry.
      const walk = (side: 'left' | 'right') =>
        piece.sidewalk === 'both' || piece.sidewalk === side ? sw : 0;
      let walkLeft = walk('left');
      let walkRight = walk('right');
      if (piece.oneway === -1) {
        // Travel along the drawn direction, as the simulation does.
        pts = pts.slice().reverse();
        [pa, pb] = [pb, pa];
        section = reverseSection(section);
        [walkLeft, walkRight] = [walkRight, walkLeft];
      }
      carPieces.push({
        a: pa,
        b: pb,
        oneway: piece.oneway !== undefined || piece.roundabout,
        points: pts,
        section,
        piece,
        walkLeft,
        walkRight,
      });
    }
  }

  // ── Links ──
  const degree = new Map<number, number>();
  for (const p of carPieces) {
    for (const n of p.a === p.b ? [p.a] : [p.a, p.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
  }
  const reverse = (p: CarPiece): CarPiece => ({
    ...p,
    a: p.b,
    b: p.a,
    points: p.points.slice().reverse(),
    section: reverseSection(p.section),
    walkLeft: p.walkRight,
    walkRight: p.walkLeft,
  });
  const heading = (pts: readonly [number, number][], end: boolean) => {
    const [x0, y0] = end ? pts[pts.length - 2] : pts[0];
    const [x1, y1] = end ? pts[pts.length - 1] : pts[1];
    return Math.atan2(y1 - y0, x1 - x0);
  };
  const compatible = (p: CarPiece, q: CarPiece) => {
    const turn = Math.abs(
      Math.atan2(
        Math.sin(heading(q.points, false) - heading(p.points, true)),
        Math.cos(heading(q.points, false) - heading(p.points, true)),
      ),
    );
    return (
      turn < 0.9 &&
      sameSection(p.section, q.section) &&
      p.piece.tunnel === q.piece.tunnel &&
      (p.piece.bridge ?? false) === (q.piece.bridge ?? false) &&
      p.walkLeft === q.walkLeft &&
      p.walkRight === q.walkRight &&
      (p.piece.highway === 'living_street') === (q.piece.highway === 'living_street')
    );
  };
  const links: Link[] = [];
  for (const chain of chainPieces(carPieces, (n) => degree.get(n) ?? 0, reverse, compatible)) {
    const points: [number, number][] = [];
    const interior: { node: number; s: number }[] = [];
    let s = 0;
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i];
      if (i > 0) interior.push({ node: p.a, s });
      for (let j = i === 0 ? 0 : 1; j < p.points.length; j++) points.push(p.points[j]);
      for (let j = 1; j < p.points.length; j++) {
        s += Math.hypot(p.points[j][0] - p.points[j - 1][0], p.points[j][1] - p.points[j - 1][1]);
      }
    }
    const first = chain[0];
    const last = chain[chain.length - 1];
    const line = polyline(points);
    if (line.length < 0.5) continue;
    const highway = first.piece.highway;
    links.push({
      a: first.a,
      b: last.b,
      points,
      line,
      section: first.section,
      startSection: first.section,
      endSection: last.section,
      piece: chain[Math.floor(chain.length / 2)].piece,
      drawable: !first.piece.tunnel,
      walkLeft: first.walkLeft,
      walkRight: first.walkRight,
      interior,
      trimA: 0,
      trimB: 0,
      paving: highway === 'living_street' || highway === 'pedestrian',
    });
  }
  stats.links = links.length;

  // Bridge spans are chained independently of lane/sidewalk section changes.
  // A change of width must not anchor the middle of a deck to the valley floor.
  const bridgePaths: [number, number][][] = [];
  const bridgePieces = carPieces.filter((p) => p.piece.bridge && !p.piece.tunnel);
  const bridgeDegree = new Map<number, number>();
  for (const p of bridgePieces)
    for (const n of [p.a, p.b]) bridgeDegree.set(n, (bridgeDegree.get(n) ?? 0) + 1);
  for (const chain of chainPieces(
    bridgePieces,
    (n) => bridgeDegree.get(n) ?? 0,
    reverse,
    () => true,
  )) {
    bridgePaths.push(chain.flatMap((p, i) => (i ? p.points.slice(1) : p.points)));
  }
  const bridgeLines = bridgePaths.map(polyline);
  const bridgeOf = (points: [number, number][], bridge?: boolean) => {
    if (!bridge) return 0;
    const line = polyline(points),
      middle = { x: 0, y: 0, h: 0 };
    pointAt(line, line.length / 2, middle);
    let best = -1,
      distance = Infinity;
    for (let i = 0; i < bridgeLines.length; i++) {
      const match = project(bridgeLines[i], middle.x, middle.y);
      const at = { x: 0, y: 0, h: 0 };
      pointAt(bridgeLines[i], match.s, at);
      if (
        match.d < distance &&
        match.d < BRIDGE_MEMBER_MAX_OFFSET_M &&
        Math.abs(Math.cos(at.h - middle.h)) > 0.9
      ) {
        best = i;
        distance = match.d;
      }
    }
    if (best >= 0) return best + 1;
    bridgePaths.push(points);
    bridgeLines.push(line);
    return bridgePaths.length;
  };
  const linkBridge = new Map(links.map((link) => [link, bridgeOf(link.points, link.piece.bridge)]));
  let activeBridge = 0;
  const bridgeDomains: [number, number][][][] = [];

  // ── Junction arms and paint clearances ──
  interface Arm {
    link: Link;
    atA: boolean;
    u: [number, number];
    angle: number;
    hw: number;
    need: number;
  }
  const armsAt = new Map<number, Arm[]>();
  for (const link of links) {
    for (const atA of link.a === link.b ? [true, false] : [true, false]) {
      const node = atA ? link.a : link.b;
      const pts = atA ? link.points : link.points.slice().reverse();
      const [x0, y0] = pts[0];
      let k = 1;
      while (k < pts.length - 1 && Math.hypot(pts[k][0] - x0, pts[k][1] - y0) < 8) k++;
      const dx = pts[k][0] - x0;
      const dy = pts[k][1] - y0;
      const len = Math.hypot(dx, dy) || 1;
      const arm: Arm = {
        link,
        atA,
        u: [dx / len, dy / len],
        angle: Math.atan2(dy, dx),
        hw: link.section.width / 2,
        need: 0,
      };
      const list = armsAt.get(node);
      if (list) list.push(arm);
      else armsAt.set(node, [arm]);
    }
  }
  for (const [node, arms] of armsAt) {
    if (arms.length < 2) continue;
    arms.sort((p, q) => p.angle - q.angle);
    for (let k = 0; k < arms.length; k++) {
      const p = arms[k];
      const q = arms[(k + 1) % arms.length];
      let delta = q.angle - p.angle;
      if (k === arms.length - 1) delta += 2 * Math.PI;
      const convex = delta < Math.PI - 0.1 && delta > 0.05;
      if (!convex) continue;
      const n1: [number, number] = [-p.u[1], p.u[0]];
      const n2: [number, number] = [-q.u[1], q.u[0]];
      const wx = -n2[0] * q.hw - n1[0] * p.hw;
      const wy = -n2[1] * q.hw - n1[1] * p.hw;
      const det = cross(p.u[0], p.u[1], q.u[0], q.u[1]);
      const t = cross(wx, wy, q.u[0], q.u[1]) / det;
      const s = cross(wx, wy, p.u[0], p.u[1]) / det;
      p.need = Math.max(p.need, t);
      q.need = Math.max(q.need, s);
    }
    // A two-arm junction carrying a crossing keeps the crossing clear of lane lines.
    const crossingHere = tagged.get(node)?.kind === 'crossing' || crossingWays.has(node);
    const minimum = arms.length === 2 ? (crossingHere ? STREET.crossingM / 2 + 0.5 : 2) : 1;
    for (const arm of arms) {
      const trim = Math.min(Math.max(arm.need, minimum), STREET.maxTrimM);
      if (arm.atA) arm.link.trimA = Math.max(arm.link.trimA, trim);
      else arm.link.trimB = Math.max(arm.link.trimB, trim);
    }
  }
  for (const link of links) {
    const total = link.trimA + link.trimB;
    const room = link.line.length * 0.9;
    if (total > room) {
      link.trimA *= room / total;
      link.trimB *= room / total;
    }
  }

  // Builders: simple level (z16+) and full (z17+), surfaces and markings.
  const linkBodies = new Map(
    links.map((link) => [
      link,
      resample(slice(link.line, link.trimA, link.line.length - link.trimB), STREET.stepM),
    ]),
  );
  const surf = { simple: new Buffers(), full: new Buffers() };
  const topology = new StreetTopology(size, STREET.stepM * 4);
  const tint = new Buffers();
  const paint = new Buffers();
  const sdf = new Buffers();

  const emitPolygon = (ring: readonly [number, number][], z: number, material: number) => {
    if (activeBridge) {
      bridgeDomains[activeBridge - 1] ??= [];
      bridgeDomains[activeBridge - 1].push(ring.map(([x, y]) => [x, y]));
    }
    topology.add(ring, z, material, activeBridge);
  };
  /**
   * A strip along `points` between lateral offsets `left[i]` and `right[i]`
   * (positive to the left), owned segment by segment.
   */
  const emitStrip = (
    points: readonly [number, number][],
    left: readonly number[],
    right: readonly number[],
    z: number,
    material: number,
  ) => {
    if (points.length < 2) return;
    const normals = rightNormals(points);
    const edge = (i: number, offset: number): [number, number] => [
      points[i][0] - normals[i][0] * offset,
      points[i][1] - normals[i][1] * offset,
    ];
    emitPolygon(
      [
        ...points.map((_, i) => edge(i, left[i])),
        ...points.map((_, i) => edge(i, right[i])).reverse(),
      ],
      z,
      material,
    );
  };
  const lateral = (points: readonly [number, number][], offset: number) =>
    offsetPolyline(points, -offset);

  /** A painted line (strip of centre points + half-width offsets), owned segment by segment. */
  const emitLine = (
    path: readonly [number, number][],
    halfWidth: number,
    colour: number,
    into = paint,
    owned = true,
  ) => {
    if (path.length < 2) return;
    const points = lattice ? densifyToLattice(path, lattice) : path;
    const normals = rightNormals(points);
    let prev: [number, number] | null = null;
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i];
      const [nx, ny] = normals[i];
      const attr = [colour, MODE.line, LAYER.paint, activeBridge];
      const l = into.vertex(x, y, 0, attr, [-nx * halfWidth, -ny * halfWidth], [-1, 0]);
      const r = into.vertex(x, y, 0, attr, [nx * halfWidth, ny * halfWidth], [1, 0]);
      if (prev && (!owned || inTile((x + points[i - 1][0]) / 2, (y + points[i - 1][1]) / 2))) {
        into.triangle(prev[0], prev[1], r);
        into.triangle(prev[0], r, l);
      }
      prev = [l, r];
    }
  };
  /** A flat tinted quad. */
  const emitTintQuad = (corners4: readonly [number, number][], colour: number) => {
    const attr = [colour, MODE.flat, LAYER.tint, activeBridge];
    const base = tint.vertexCount;
    for (const [x, y] of corners4) tint.vertex(x, y, 0, attr, [0, 0], [0, 0]);
    tint.triangle(base, base + 1, base + 2);
    tint.triangle(base, base + 2, base + 3);
  };
  /**
   * An SDF quad: `centre`, `up` (unit: the cell's top), `right` (unit), its
   * half-extents, and the atlas rectangle (texels).
   */
  const emitSdf = (
    centre: [number, number],
    up: [number, number],
    right: [number, number],
    halfUp: number,
    halfRight: number,
    rect: { x: number; y: number; w: number; h: number },
  ) => {
    const attr = [PAINT.white, MODE.sdf, LAYER.paint, activeBridge];
    const corner = (su: number, sr: number): [number, number] => [
      centre[0] + up[0] * halfUp * su + right[0] * halfRight * sr,
      centre[1] + up[1] * halfUp * su + right[1] * halfRight * sr,
    ];
    const base = sdf.vertexCount;
    const quads: [[number, number], [number, number]][] = [
      [corner(1, -1), [rect.x, rect.y]],
      [corner(1, 1), [rect.x + rect.w, rect.y]],
      [corner(-1, 1), [rect.x + rect.w, rect.y + rect.h]],
      [corner(-1, -1), [rect.x, rect.y + rect.h]],
    ];
    for (const [[x, y], uv] of quads) sdf.vertex(x, y, 0, attr, [0, 0], uv);
    sdf.triangle(base, base + 1, base + 2);
    sdf.triangle(base, base + 2, base + 3);
  };

  /**
   * Lay out a text in the map's glyphs: `null` when a glyph is missing (the
   * text is then not drawn at all, never drawn with holes).
   */
  const layout = (text: string) => {
    const glyphs: {
      rect: { x: number; y: number; w: number; h: number } | null;
      x0: number;
      y0: number;
      w: number;
      h: number;
    }[] = [];
    let pen = 0;
    for (const ch of text) {
      const glyph = atlas.glyph(ch.codePointAt(0) ?? 0);
      if (!glyph) return null;
      const g = glyph.metrics;
      if (glyph.rect) {
        glyphs.push({
          rect: glyph.rect,
          x0: pen + g.left - 3,
          // Down from the ascender line, MapLibre's convention (`build-map-glyphs.ts`).
          y0: -g.top - 3,
          w: g.width + 6,
          h: g.height + 6,
        });
      }
      pen += g.advance;
    }
    return { glyphs, advance: pen };
  };
  /** Cap height's middle, em px below the ascender line (Inter: 24 − 0.727 · 24 / 2). */
  const CAP_MIDDLE = 24 - (0.727 * 24) / 2;
  const emitText = (
    text: NonNullable<ReturnType<typeof layout>>,
    centre: [number, number],
    along: [number, number],
    emM: number,
    stretch = 1,
  ) => {
    const k = emM / 24;
    const up: [number, number] = [-along[1], along[0]];
    const start = -text.advance / 2;
    for (const g of text.glyphs) {
      if (!g.rect) continue;
      const cx = (start + g.x0 + g.w / 2) * k;
      const cy = -(g.y0 + g.h / 2 - CAP_MIDDLE) * k * stretch;
      emitSdf(
        [centre[0] + along[0] * cx + up[0] * cy, centre[1] + along[1] * cx + up[1] * cy],
        up,
        along,
        (g.h / 2) * k * stretch,
        (g.w / 2) * k,
        g.rect,
      );
    }
  };

  // ── Junction surfaces ──
  // The only extra area is the bevel between the actual end cross-sections.
  // A fillet extrapolated from distant tangents can erase bends and create
  // fictitious circular islands when neighbouring intersections are close.
  for (const [node, arms] of armsAt) {
    if (arms.length < 2 || arms.every((a) => !a.link.drawable)) continue;
    const [jx, jy] = nodePos[node];
    if (inTile(jx, jy)) stats.junctions++;
    activeBridge = arms.every((a) => a.link.piece.bridge) ? (linkBridge.get(arms[0].link) ?? 0) : 0;
    const endpoints: [number, number][] = [];
    for (const arm of arms) {
      const pts = arm.atA ? arm.link.points : arm.link.points.slice().reverse();
      const dx = pts[1][0] - pts[0][0],
        dy = pts[1][1] - pts[0][1];
      const length = Math.hypot(dx, dy) || 1;
      for (const side of [-1, 1])
        endpoints.push([jx - (dy / length) * arm.hw * side, jy + (dx / length) * arm.hw * side]);
    }
    endpoints.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const half = (points: [number, number][]) => {
      const hull: [number, number][] = [];
      for (const p of points) {
        while (hull.length >= 2) {
          const a = hull[hull.length - 2],
            b = hull[hull.length - 1];
          if (cross(b[0] - a[0], b[1] - a[1], p[0] - b[0], p[1] - b[1]) > 0) break;
          hull.pop();
        }
        hull.push(p);
      }
      return hull.slice(0, -1);
    };
    emitPolygon(
      [...half(endpoints), ...half(endpoints.slice().reverse())],
      0,
      arms.every((a) => a.link.paving) ? SURFACE.paving : SURFACE.asphalt,
    );
  }

  // ── Kerb lines (for mapped sidewalks to reach), on a 10 m grid ──
  const kerbGrid = new Map<number, [number, number, number, number, number][]>();
  const cellKey = (cx: number, cy: number) => (cx + 4096) * 8192 + (cy + 4096);
  const cell = (x: number, y: number) => cellKey(Math.floor(x / 10), Math.floor(y / 10));
  const addKerb = (pts: readonly [number, number][]) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const seg: [number, number, number, number, number] = [
        pts[i][0],
        pts[i][1],
        pts[i + 1][0],
        pts[i + 1][1],
        activeBridge,
      ];
      const cells = new Set([
        cell(seg[0], seg[1]),
        cell(seg[2], seg[3]),
        cell((seg[0] + seg[2]) / 2, (seg[1] + seg[3]) / 2),
      ]);
      for (const key of cells) {
        const list = kerbGrid.get(key);
        if (list) list.push(seg);
        else kerbGrid.set(key, [seg]);
      }
    }
  };

  /**
   * A crossing centred at `p` on a carriageway `width` wide running along `u`:
   * across it in the direction of the mapped `footway=crossing` way when one
   * meets the node (skewed crossings stay skewed), else square to the road.
   */
  const paintCrossing = (
    p: [number, number],
    u: [number, number],
    width: number,
    style: CrossingStyle,
    node: number | undefined,
  ) => {
    if (style === 'none' || !inTile(p[0], p[1])) return;
    stats.crossings++;
    const left: [number, number] = [-u[1], u[0]];
    const way = node !== undefined ? crossingWays.get(node) : undefined;
    let dir: [number, number] = left;
    if (way && Math.abs(cross(u[0], u[1], way.dir[0], way.dir[1])) > 0.5) {
      dir = way.dir[0] * left[0] + way.dir[1] * left[1] >= 0 ? way.dir : [-way.dir[0], -way.dir[1]];
    }
    const span = width / Math.abs(cross(u[0], u[1], dir[0], dir[1]));
    const half = STREET.crossingM / 2;
    const at = (along: number, across: number): [number, number] => [
      p[0] + dir[0] * across + u[0] * along,
      p[1] + dir[1] * across + u[1] * along,
    ];
    if (style === 'zebra' || style === 'ladder') {
      const bars = Math.max(1, Math.floor(span / STREET.zebraPitchM));
      const start = -((bars - 1) * STREET.zebraPitchM) / 2;
      for (let i = 0; i < bars; i++) {
        const x = start + i * STREET.zebraPitchM;
        emitLine([at(-half, x), at(half, x)], STREET.zebraBarM / 2, PAINT.white, paint, false);
      }
    }
    if (style === 'ladder' || style === 'lines') {
      for (const side of [-half, half]) {
        emitLine([at(side, -span / 2), at(side, span / 2)], 0.1, PAINT.white, paint, false);
      }
    }
    if (style === 'dashes' || style === 'dots') {
      const [dash, gap] = style === 'dashes' ? [0.6, 0.6] : [0.3, 0.3];
      const w = style === 'dashes' ? 0.12 : 0.15;
      for (const side of [-half, half]) {
        for (let x = -span / 2; x + dash <= span / 2 + 1e-6; x += dash + gap) {
          emitLine([at(side, x), at(side, x + dash)], w, PAINT.white, paint, false);
        }
      }
    }
    if (style === 'surface') {
      emitTintQuad(
        [at(-half, -span / 2), at(-half, span / 2), at(half, span / 2), at(half, -span / 2)],
        PAINT.crossing,
      );
    }
  };
  /** The crossing style at a node, if it is a crossing at all. */
  const crossingAt = (node: number): CrossingStyle | null => {
    const tag = tagged.get(node);
    const way = crossingWays.get(node);
    if (tag?.kind !== 'crossing' && !way) return null;
    return crossingStyle(tag?.kind === 'crossing' ? tag : null, way?.piece ?? null);
  };

  // Crossings where the carriageway changes (a two-arm junction): across the wider arm.
  for (const [node, arms] of armsAt) {
    if (arms.length !== 2 || !arms.every((a) => a.link.drawable)) continue;
    const style = crossingAt(node);
    if (!style) continue;
    const wide = arms[0].hw >= arms[1].hw ? arms[0] : arms[1];
    activeBridge = linkBridge.get(wide.link) ?? 0;
    paintCrossing(nodePos[node], wide.u, wide.hw * 2, style, node);
  }

  // ── Links: surfaces, sidewalks, markings ──
  interface Crosswalk {
    s: number;
    style: CrossingStyle;
    /** At a two-arm junction ending the link: painted there, not by the link. */
    end?: boolean;
  }
  const crosswalksOf = new Map<Link, Crosswalk[]>();
  for (const link of links) {
    const list: Crosswalk[] = [];
    for (const { node, s } of link.interior) {
      const style = crossingAt(node);
      if (style) list.push({ s, style });
    }
    for (const [node, s] of [
      [link.a, 0],
      [link.b, link.line.length],
    ] as const) {
      const style = armsAt.get(node)?.length === 2 ? crossingAt(node) : null;
      if (style) list.push({ s, style, end: true });
    }
    crosswalksOf.set(link, list);
  }

  const signalNear = (link: Link, atB: boolean, reach: number, kind: RoadNode['kind']) => {
    const end = atB ? link.b : link.a;
    if (tagged.get(end)?.kind === kind && kind === 'signals') return true;
    return link.interior.some(({ node, s }) => {
      const dist = atB ? link.line.length - s : s;
      return dist <= reach && tagged.get(node)?.kind === kind;
    });
  };

  for (const link of links) {
    if (!link.drawable || (!link.piece.bridge && !touches(link.points, STREET.kerbReachM)))
      continue;
    activeBridge = linkBridge.get(link) ?? 0;
    const { section, line } = link;
    const s0 = link.trimA;
    const s1 = line.length - link.trimB;
    const hw = section.width / 2;
    const body = linkBodies.get(link) ?? [];
    const material = link.paving ? SURFACE.paving : SURFACE.asphalt;
    // The surface follows the complete surveyed centreline. Junction cuts
    // limit markings and kerbs, never erase the road's underlying corridor.
    const corridor = link.points;
    emitStrip(
      corridor,
      corridor.map(() => hw),
      corridor.map(() => -hw),
      0,
      material,
    );
    addKerb(lateral(corridor, hw));
    addKerb(lateral(corridor, -hw));
    for (const [side, width] of [
      [1, link.walkLeft],
      [-1, link.walkRight],
    ] as const) {
      if (width <= 0) continue;
      stats.sidewalks++;
      const inner = corridor.map(() => side * hw);
      const outer = corridor.map(() => side * (hw + width));
      emitStrip(
        corridor,
        side > 0 ? outer : inner,
        side > 0 ? inner : outer,
        STREET.kerbM,
        SURFACE.sidewalk,
      );
    }

    // Cuts affect paint only; short links still retain their full surface.
    if (s1 - s0 < 0.2) continue;
    // Markings.
    const crosswalks = crosswalksOf.get(link) ?? [];
    const blocked: [number, number][] = crosswalks
      .filter((c) => c.style !== 'none')
      .map((c) => [c.s - STREET.crossingM / 2 - 0.5, c.s + STREET.crossingM / 2 + 0.5]);
    const stops: { s: number; toB: boolean; give: boolean }[] = [];
    for (const toB of [false, true]) {
      const end = toB ? link.b : link.a;
      const junction = (degree.get(end) ?? 0) >= 3;
      if (!junction) continue;
      const signals = signalNear(link, toB, 35, 'signals');
      const stop = signalNear(link, toB, 20, 'stop');
      const give = !signals && !stop && signalNear(link, toB, 20, 'give_way');
      if (!signals && !stop && !give) continue;
      const trim = toB ? link.trimB : link.trimA;
      const fromEnd = (s: number) => (toB ? line.length - s : s);
      const near = crosswalks
        .filter((c) => c.style !== 'none' && fromEnd(c.s) < 25)
        .map((c) => fromEnd(c.s) + STREET.crossingM / 2 + STREET.stopGapM);
      const dist = Math.max(trim + STREET.stopGapM, ...near);
      const s = toB ? line.length - dist : dist;
      if (s <= s0 || s >= s1) continue;
      stops.push({ s, toB, give });
      blocked.push([s - 1, s + 1]);
    }
    // Mid-block signals: stop lines both ways at their crossing.
    for (const { node, s } of link.interior) {
      if (tagged.get(node)?.kind !== 'signals') continue;
      if (s < 35 || line.length - s < 35) continue;
      const crosswalk = crosswalks.find((c) => Math.abs(c.s - s) < 3 && c.style !== 'none');
      const off = (crosswalk ? STREET.crossingM / 2 : 0) + STREET.stopGapM;
      for (const toB of [true, false]) {
        const at = toB ? s - off : s + off;
        if (at > s0 && at < s1) {
          stops.push({ s: at, toB, give: false });
          blocked.push([at - 1, at + 1]);
        }
      }
    }
    const open = (a: number, b: number): [number, number][] => {
      let spans: [number, number][] = [[a, b]];
      for (const [x, y] of blocked) {
        spans = spans.flatMap(([p, q]) =>
          y <= p || x >= q
            ? [[p, q] as [number, number]]
            : ([
                [p, x],
                [y, q],
              ].filter(([u, v]) => v - u > 0.3) as [number, number][]),
        );
      }
      return spans;
    };

    // Bus and cycle lanes: tinted.
    for (const band of section.bands) {
      if (band.kind !== 'bus' && band.kind !== 'cycle') continue;
      const colour = band.kind === 'bus' ? PAINT.bus : PAINT.cycle;
      const l = lateral(body, band.left);
      const r = lateral(body, band.right);
      for (let i = 0; i + 1 < body.length; i++) {
        if (!inTile((body[i][0] + body[i + 1][0]) / 2, (body[i][1] + body[i + 1][1]) / 2)) continue;
        emitTintQuad([l[i], r[i], r[i + 1], l[i + 1]], colour);
      }
    }
    // Dividers: each is one or two painted lines, solid or dashed.
    for (const divider of section.dividers) {
      const colour = divider.colour === 'yellow' ? PAINT.yellow : PAINT.white;
      const apart = (LINE_WIDTH_M.doubleGap + divider.width) / 2;
      const lines: { offset: number; dashed: boolean }[] =
        divider.style === 'double'
          ? [
              { offset: divider.offset + apart, dashed: false },
              { offset: divider.offset - apart, dashed: false },
            ]
          : divider.style === 'mixed'
            ? [
                { offset: divider.offset + apart, dashed: divider.solidOn !== 'left' },
                { offset: divider.offset - apart, dashed: divider.solidOn !== 'right' },
              ]
            : [{ offset: divider.offset, dashed: divider.style === 'dashed' }];
      for (const [a, b] of open(s0, s1)) {
        for (const { offset, dashed } of lines) {
          const spans: [number, number][] = [];
          if (dashed) {
            const [dash, gap] = STREET.dashM;
            const period = dash + gap;
            for (let k = Math.floor(a / period); k * period < b; k++) {
              const x = Math.max(a, k * period);
              const y = Math.min(b, k * period + dash);
              if (y - x > 0.3) spans.push([x, y]);
            }
          } else spans.push([a, b]);
          for (const [x, y] of spans) {
            const centre = resample(slice(line, x, y), STREET.stepM);
            emitLine(lateral(centre, offset), divider.width / 2, colour);
          }
        }
      }
    }

    const travel = (b: Band) => b.kind === 'lane' || b.kind === 'bus';
    const frameAt = (s: number) => {
      const at = { x: 0, y: 0, h: 0 };
      pointAt(line, s, at);
      const u: [number, number] = [Math.cos(at.h), Math.sin(at.h)];
      const left: [number, number] = [-u[1], u[0]];
      return { p: [at.x, at.y] as [number, number], u, left };
    };
    // Crossings.
    for (const c of crosswalks) {
      if (c.style === 'none' || c.end) continue;
      const { p, u } = frameAt(c.s);
      const node = link.interior.find((i) => i.s === c.s)?.node;
      paintCrossing(p, u, section.width, c.style, node);
    }
    // Stop and give-way lines across the lanes that approach.
    for (const stop of stops) {
      const { p, left } = frameAt(stop.s);
      if (!inTile(p[0], p[1])) continue;
      const dir = stop.toB ? 1 : -1;
      const bands = section.bands.filter((b) => travel(b) && b.dir === dir);
      if (bands.length === 0) continue;
      stats.stopLines++;
      const hi = Math.max(...bands.map((b) => b.left));
      const lo = Math.min(...bands.map((b) => b.right));
      const across = (o: number): [number, number] => [p[0] + left[0] * o, p[1] + left[1] * o];
      if (stop.give) {
        for (let o = lo + 0.15; o + 0.5 <= hi; o += 1.0) {
          emitLine([across(o), across(o + 0.5)], 0.15, PAINT.white, paint, false);
        }
      } else
        emitLine(
          [across(lo + 0.1), across(hi - 0.1)],
          LINE_WIDTH_M.stop / 2,
          PAINT.white,
          paint,
          false,
        );
    }

    // Arrows and lane words, at each end the lanes run toward.
    for (const toB of [true, false]) {
      const dir = toB ? 1 : -1;
      const endSection = toB ? link.endSection : link.startSection;
      const trim = toB ? link.trimB : link.trimA;
      const stop = stops.find((s) => s.toB === toB);
      const fromEnd = stop ? (toB ? line.length - stop.s : stop.s) : trim + 1;
      const otherTrim = toB ? link.trimA : link.trimB;
      const usable = line.length - otherTrim - 6;
      const station = (d: number) => (toB ? line.length - d : d);
      for (const band of endSection.bands) {
        if (!travel(band) || band.dir !== dir) continue;
        const centre = (band.left + band.right) / 2;
        const parts = arrowParts(band.turns);
        let behind = fromEnd + 1.5;
        if (parts) {
          const rect = atlas.arrow(arrowKey(parts, rules.drivingSide), parts);
          if (rect) {
            for (const d of [
              behind + STREET.arrowM.length / 2,
              behind + STREET.arrowM.length / 2 + STREET.arrowRepeatM,
            ]) {
              if (d + STREET.arrowM.length / 2 > usable) break;
              const f = frameAt(station(d));
              const fwd: [number, number] = toB ? f.u : [-f.u[0], -f.u[1]];
              const c: [number, number] = [
                f.p[0] + f.left[0] * centre,
                f.p[1] + f.left[1] * centre,
              ];
              if (!inTile(c[0], c[1])) continue;
              stats.arrows++;
              const right: [number, number] = [fwd[1], -fwd[0]];
              const lengthPx = ARROW_CELL.height;
              const widthPx = ARROW_CELL.width;
              const halfUp = (STREET.arrowM.length / 2) * (lengthPx / ARROW_CELL.shapeLength);
              const halfRight =
                (STREET.arrowM.width / 2) * (widthPx / (2 * ARROW_CELL.shapeHalfWidth));
              // The cell's shape sits `pad` px above its bottom: shift the quad so the shape is centred.
              const shift =
                ((ARROW_CELL.pad - (lengthPx - ARROW_CELL.shapeLength - ARROW_CELL.pad)) / 2) *
                (STREET.arrowM.length / ARROW_CELL.shapeLength);
              emitSdf(
                [c[0] + fwd[0] * shift, c[1] + fwd[1] * shift],
                fwd,
                right,
                halfUp,
                halfRight,
                rect,
              );
            }
          }
          behind += STREET.arrowM.length + 2;
        }
        if (band.kind === 'bus') {
          const word = layout('BUS');
          const width = (band.left - band.right) * 0.7;
          if (word && word.advance > 0) {
            const emM = width / (word.advance / 24);
            const length = emM * 0.727 * STREET.wordStretch;
            const d = behind + 2 + length / 2;
            if (d + length / 2 <= usable) {
              const f = frameAt(station(d));
              const fwd: [number, number] = toB ? f.u : [-f.u[0], -f.u[1]];
              const c: [number, number] = [
                f.p[0] + f.left[0] * centre,
                f.p[1] + f.left[1] * centre,
              ];
              if (inTile(c[0], c[1])) {
                stats.words++;
                emitText(word, c, [fwd[1], -fwd[0]], emM, STREET.wordStretch);
              }
            }
          }
        }
      }
    }

    // The street's name, on straight stretches clear of the ends' markings.
    if (link.piece.name && paintableScript(link.piece.name)) {
      const text = layout(paintedName(link.piece.name));
      const lanes = section.bands.filter(travel);
      if (text && text.advance > 0 && lanes.length > 0) {
        // Read with the traffic on a one-way street; eastward (else northward) on a two-way one.
        const oneway = section.forward === 0 || section.backward === 0;
        const lo = link.trimA + STREET.nameClearM + (stops.some((s) => !s.toB) ? 8 : 0);
        const hi =
          line.length - link.trimB - STREET.nameClearM - (stops.some((s) => s.toB) ? 8 : 0);
        const mid = (lo + hi) / 2;
        const count = Math.max(1, Math.floor((hi - lo) / STREET.nameEveryM));
        for (let i = 0; i < count; i++) {
          const s = count === 1 ? mid : lo + ((hi - lo) * (i + 0.5)) / count;
          const f = frameAt(s);
          let along = f.u;
          if (!oneway && (along[0] < -0.2 || (Math.abs(along[0]) <= 0.2 && along[1] < 0))) {
            along = [-along[0], -along[1]];
          }
          const readsWithDrawn = along[0] * f.u[0] + along[1] * f.u[1] > 0;
          const dir = readsWithDrawn ? 1 : -1;
          const own = lanes.filter((b) => b.dir === dir);
          const pool = own.length > 0 ? own : lanes;
          const band = pool[Math.floor(pool.length / 2)];
          const laneW = band.left - band.right;
          const emM = Math.min(3.2, Math.max(1.6, laneW * 0.75));
          const length = (text.advance / 24) * emM;
          if (s - length / 2 < lo || s + length / 2 > hi) continue;
          if (blocked.some(([x, y]) => y > s - length / 2 && x < s + length / 2)) continue;
          // Straight: the line within the text's span strays under 0.3 m from its chord.
          const a = frameAt(s - length / 2).p;
          const b = frameAt(s + length / 2).p;
          let straight = true;
          for (let k = 1; k < 8 && straight; k++) {
            const q = frameAt(s - length / 2 + (length * k) / 8).p;
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            if (Math.abs(cross(b[0] - a[0], b[1] - a[1], q[0] - a[0], q[1] - a[1])) / len > 0.3) {
              straight = false;
            }
          }
          if (!straight) continue;
          const centre = (band.left + band.right) / 2;
          const c: [number, number] = [f.p[0] + f.left[0] * centre, f.p[1] + f.left[1] * centre];
          if (!inTile(c[0], c[1])) continue;
          stats.names++;
          emitText(text, c, along, emM);
          const steps = Math.max(1, Math.round(length / PAINTED_NAME_STEP_M));
          for (let k = 0; k <= steps; k++) {
            const d = -length / 2 + (length * k) / steps;
            paintedNames.push([c[0] + along[0] * d, c[1] + along[1] * d]);
          }
        }
      }
    }
  }

  // ── Separately mapped sidewalks and other paths ──
  const nearestKerb = (x: number, y: number, tx: number, ty: number) => {
    const best = { left: Number.POSITIVE_INFINITY, right: Number.POSITIVE_INFINITY };
    const cx = Math.floor(x / 10);
    const cy = Math.floor(y / 10);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const [ax, ay, bx, by, bridge] of kerbGrid.get(cellKey(cx + i, cy + j)) ?? []) {
          if (bridge !== activeBridge) continue;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          if (len2 < 1e-6) continue;
          if (Math.abs(dx * tx + dy * ty) / (Math.sqrt(len2) * Math.hypot(tx, ty)) < 0.7) continue;
          // Intersect the actual lateral ray, never reach diagonally for a
          // segment endpoint beyond a junction. That Euclidean distance
          // widened sidewalks into triangular wedges over the carriageway.
          const offset = kerbOffset(x, y, -ty, tx, ax, ay, bx, by);
          if (offset === null || Math.abs(offset) * Math.hypot(tx, ty) > STREET.kerbReachM)
            continue;
          if (offset > 0) best.left = Math.min(best.left, offset);
          else best.right = Math.min(best.right, -offset);
        }
      }
    }
    return best;
  };
  const PATH_HALF: Partial<Record<RoadPiece['highway'], number>> = {
    pedestrian: 2.5,
    footway: 1,
    path: 0.75,
    steps: 1,
    track: 1.25,
  };
  for (const { points, piece } of footways) {
    if (!piece.bridge && !touches(points)) continue;
    activeBridge = bridgeOf(points, piece.bridge);
    const body = resample(points, 4);
    if (piece.footway === 'sidewalk') {
      stats.sidewalks++;
      const left: number[] = [];
      const right: number[] = [];
      const normals = rightNormals(body);
      for (let i = 0; i < body.length; i++) {
        const [nx, ny] = normals[i];
        const kerb = nearestKerb(body[i][0], body[i][1], -ny, nx);
        // Reach the kerb on the road's side (never past it), the default the other way.
        left.push(
          Number.isFinite(kerb.left) ? Math.max(0.3, kerb.left - 0.02) : STREET.footwayHalfM,
        );
        right.push(
          Number.isFinite(kerb.right) ? Math.max(0.3, kerb.right - 0.02) : STREET.footwayHalfM,
        );
      }
      const smooth = (v: number[]) =>
        v.map((_, i) => Math.min(v[Math.max(0, i - 1)], v[i], v[Math.min(v.length - 1, i + 1)]));
      const l = smooth(left);
      const r = smooth(right).map((x) => -x);
      emitStrip(body, l, r, STREET.kerbM, SURFACE.sidewalk);
      continue;
    }
    if (piece.highway === 'cycleway') {
      // A separate cycle track (schema 3): asphalt, tinted as a cycle lane is,
      // its recorded width or a styling 2 m.
      stats.cycleways++;
      const halfWidth = Math.min(2.5, Math.max(0.6, (piece.width ?? 2) / 2));
      emitStrip(
        body,
        body.map(() => halfWidth),
        body.map(() => -halfWidth),
        0,
        SURFACE.asphalt,
      );
      const l = lateral(body, halfWidth);
      const r = lateral(body, -halfWidth);
      for (let i = 0; i + 1 < body.length; i++) {
        if (!inTile((body[i][0] + body[i + 1][0]) / 2, (body[i][1] + body[i + 1][1]) / 2)) continue;
        emitTintQuad([l[i], r[i], r[i + 1], l[i + 1]], PAINT.cycle);
      }
      continue;
    }
    const half =
      piece.highway === 'pedestrian' && piece.width ? piece.width / 2 : PATH_HALF[piece.highway];
    if (!half) continue;
    emitStrip(
      body,
      body.map(() => half),
      body.map(() => -half),
      0,
      SURFACE.paving,
    );
  }

  topology.build(surf.simple, surf.full);
  if (lattice) {
    for (const b of [surf.simple, surf.full, tint, sdf]) splitToLattice(b, lattice);
  } else {
    for (const b of [surf.simple, surf.full, tint, paint, sdf]) subdivideSurfaces(b, STREET.stepM);
  }
  const surfaces = packSurfaces([surf.simple], [surf.full]);
  surfaces.bridges = bridgePaths;
  surfaces.bridgeDomains = bridgePaths.map((_, i) => bridgeDomains[i] ?? []);
  const markings = packMarkings([tint, paint], [sdf]);
  stats.surfaceTriangles = surfaces.indices.length / 3;
  stats.markingTriangles = markings.indices.length / 3;
  return { surfaces, markings, stats, paintedNames };
}
