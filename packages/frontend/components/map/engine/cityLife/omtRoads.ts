/**
 * Worldwide fallback: a road graph healed out of the BASEMAP's OpenMapTiles
 * `transportation` layer, for wherever no compiled road archive covers the
 * view (`docs/MAP_CITY_LIFE.md` → "Worldwide").
 *
 * The compiled archive (`lib/map/cityRoads.ts`) is exact by construction; the
 * basemap is not. Measured on its z14 tiles (the doc's "Where the road graph
 * comes from"): lines are merged and simplified, 16–29% of their ends land on
 * another line's INTERIOR (a T-junction the tile does not split), 36–50% meet
 * nothing at all, and the only attributes a lane graph can use are the class
 * and `oneway`. So this heals it, in the simulation worker, before the same
 * `buildNetwork` the archive feeds:
 *
 *  1. **Classify** each line: car classes (motorway … service, `ramp` →
 *     `*_link`, parking aisles and driveways dropped) and footways (`path` with
 *     a pedestrian subclass). Rail, ferries, piers, construction, tracks:
 *     not roads here.
 *  2. **Clip** each tile's lines to the tile (the tiles overlap by a buffer).
 *  3. **Snap ends** within {@link SNAP_M} of each other to one point, then
 *     onto another line's segment within the same distance (the T-junctions).
 *  4. **Split at crossings**: two segments that cross at grade (same layer,
 *     neither a bridge or tunnel the other is not) get a shared vertex. A
 *     footway crossing a car road becomes a `footway=crossing` there, so cars
 *     yield to people on it and people wait for a gap, as on mapped crossings.
 *  5. **Split** every line at every vertex another line shares, so a piece's
 *     two ends are the graph's only nodes — the archive's own invariant.
 *  6. **Drop fragments**: connected pieces totalling under
 *     {@link MIN_COMPONENT_M} (a stub the clip or the simplifier isolated).
 *  7. **Signals are synthesised**, as simulation: a junction where two major
 *     roads (primary, secondary, trunk) meet gets a two-phase signal; every
 *     other junction runs on the simulation's first-come reservations. Nothing
 *     here claims a real signal exists.
 *
 * Lanes and speeds come from the class (`network.ts` defaults), one-way from
 * the tag. Lower fidelity than the archive, by design and by data; the label
 * says it is simulated either way.
 *
 * Pure and synchronous; positions are GLOBAL z15 tile units, like the road
 * archive's, so the two can sit side by side in one network.
 */
import {
  accessLevel,
  accessOverrides,
  type RoadAccess,
  resolveRoadAccess,
} from '@goway.to/sdk/road-access';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import type { RoadClass } from '@/lib/map/cityRoads';

import type { DecodedRoadTile, RoadNode, RoadPiece } from '../roads/roadTiles';

/** Ends this close (metres) are one junction. */
export const SNAP_M = 4;
/** Connected pieces totalling less than this (metres) are dropped as fragments. */
export const MIN_COMPONENT_M = 120;

const Z15_EXTENT = 4096;

/** One basemap line, classified, in global z15 units. */
export interface OmtLine {
  points: [number, number][];
  highway: RoadClass;
  car: boolean;
  foot: boolean;
  /** Who may use it where that differs from the class (`road-access`); the basemap records only `access`/`service`. */
  access?: Partial<RoadAccess>;
  oneway?: 1 | -1;
  tunnel: boolean;
  /** Bridges and tunnels never join what they pass over or under. */
  level: string;
}

const CAR_CLASS: Record<string, RoadClass> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
  service: 'service',
};
const FOOT_SUBCLASSES = new Set(['footway', 'pedestrian', 'path', 'steps']);
const MAJOR = new Set<string>(['trunk', 'primary', 'secondary']);

/** What a basemap `transportation` feature is to the simulation, or `null`. */
export function classifyOmt(props: Record<string, unknown>): Omit<OmtLine, 'points'> | null {
  const cls = typeof props.class === 'string' ? props.class : '';
  const sub = typeof props.subclass === 'string' ? props.subclass : '';
  const brunnel = typeof props.brunnel === 'string' ? props.brunnel : '';
  const layer = typeof props.layer === 'number' ? props.layer : 0;
  if (props.indoor === 1) return null;
  const level = `${brunnel === 'bridge' || brunnel === 'tunnel' ? brunnel : ''}${layer}`;
  const tunnel = brunnel === 'tunnel';
  const base = CAR_CLASS[cls];
  if (base) {
    // The basemap records only `access` and `service`; the contract reads them like OSM's.
    const access = resolveRoadAccess(base, {
      ...(typeof props.access === 'string' ? { access: props.access } : {}),
      ...(typeof props.service === 'string' ? { service: props.service } : {}),
    });
    if (accessLevel(access.car) === 'none') return null;
    const overrides = accessOverrides(base, access);
    const link =
      props.ramp === 1 && ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(base);
    const highway = (link ? `${base}_link` : base) as RoadClass;
    const line: Omit<OmtLine, 'points'> = { highway, car: true, foot: false, tunnel, level };
    if (Object.keys(overrides).length > 0) line.access = overrides;
    if (props.oneway === 1) line.oneway = 1;
    else if (props.oneway === -1) line.oneway = -1;
    else if (cls === 'motorway' && !link) line.oneway = 1;
    return line;
  }
  if (cls === 'path' && FOOT_SUBCLASSES.has(sub)) {
    return {
      highway: sub === 'steps' ? 'steps' : sub === 'pedestrian' ? 'pedestrian' : 'footway',
      car: false,
      foot: true,
      tunnel,
      level,
    };
  }
  return null;
}

/** Clip a polyline to `[x0, x1] × [y0, y1]` (Liang–Barsky per segment), as runs inside. */
function clipToBox(
  points: [number, number][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    let inside = true;
    for (const [p, q] of [
      [-dx, ax - x0],
      [dx, x1 - ax],
      [-dy, ay - y0],
      [dy, y1 - ay],
    ]) {
      if (p === 0) {
        if (q < 0) inside = false;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (!inside || t0 > t1) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    const start: [number, number] = [ax + dx * t0, ay + dy * t0];
    const end: [number, number] = [ax + dx * t1, ay + dy * t1];
    if (run.length === 0) run.push(start);
    run.push(end);
    if (t1 < 1) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * The car roads and footways of one basemap tile (any zoom ≤ 15), clipped to
 * the tile, in global z15 units.
 */
export function decodeOmtRoads(
  bytes: ArrayBuffer | Uint8Array,
  tile: { z: number; x: number; y: number },
  sourceLayer: string,
): OmtLine[] {
  const vt = new VectorTile(
    new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  );
  const layer = vt.layers[sourceLayer];
  if (!layer) return [];
  const scale = 2 ** (15 - tile.z) * Z15_EXTENT;
  const unit = scale / layer.extent;
  const ox = tile.x * scale;
  const oy = tile.y * scale;
  const out: OmtLine[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2) continue;
    const kind = classifyOmt(feature.properties);
    if (!kind) continue;
    for (const line of feature.loadGeometry()) {
      const points = line.map((p): [number, number] => [ox + p.x * unit, oy + p.y * unit]);
      for (const run of clipToBox(points, ox, oy, ox + scale, oy + scale)) {
        out.push({ ...kind, points: run });
      }
    }
  }
  return out;
}

/** A uniform grid over integer points, for "what is near here". */
class Grid<T> {
  private cells = new Map<number, T[]>();
  constructor(private readonly size: number) {}
  private key(cx: number, cy: number) {
    return cx * 4294967296 + cy;
  }
  add(x: number, y: number, item: T) {
    const key = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
    const list = this.cells.get(key);
    if (list) list.push(item);
    else this.cells.set(key, [item]);
  }
  near(x: number, y: number, each: (item: T) => void) {
    const cx = Math.floor(x / this.size);
    const cy = Math.floor(y / this.size);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++)
        for (const item of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) each(item);
    }
  }
}

const keyOf = (x: number, y: number) => `${x},${y}`;

export interface HealStats {
  lines: number;
  snappedEnds: number;
  tJunctions: number;
  crossings: number;
  pieces: number;
  droppedFragments: number;
  signals: number;
  /** Milliseconds per stage. */
  ms: Record<string, number>;
}

/**
 * Heal classified lines into road pieces whose ends are exact shared integer
 * points, plus synthesised signal nodes (see the module header).
 */
export function healRoads(
  input: readonly OmtLine[],
  metresPerUnit: number,
): { pieces: RoadPiece[]; nodes: RoadNode[]; stats: HealStats } {
  const tolerance = Math.max(1, Math.round(SNAP_M / metresPerUnit));
  const stats: HealStats = {
    lines: input.length,
    snappedEnds: 0,
    tJunctions: 0,
    crossings: 0,
    pieces: 0,
    droppedFragments: 0,
    signals: 0,
    ms: {},
  };
  let lap = typeof performance !== 'undefined' ? performance.now() : 0;
  const mark = (stage: string) => {
    if (typeof performance === 'undefined') return;
    const t = performance.now();
    stats.ms[stage] = Math.round(t - lap);
    lap = t;
  };
  // Integer coordinates, repeats removed.
  const lines = input
    .map((line) => {
      const points: [number, number][] = [];
      for (const [x, y] of line.points) {
        const p: [number, number] = [Math.round(x), Math.round(y)];
        const last = points[points.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
      }
      return { ...line, points, splits: new Set<number>() };
    })
    .filter((line) => line.points.length >= 2);

  // 3a. Ends within tolerance become one point (the first one seen).
  const ends = new Grid<[number, number]>(tolerance);
  for (const line of lines) {
    for (const index of [0, line.points.length - 1]) {
      const p = line.points[index];
      let target: [number, number] | null = null;
      ends.near(p[0], p[1], (q) => {
        if (!target && Math.hypot(q[0] - p[0], q[1] - p[1]) <= tolerance) target = q;
      });
      if (target) {
        const [tx, ty] = target as [number, number];
        if (tx !== p[0] || ty !== p[1]) stats.snappedEnds++;
        line.points[index] = [tx, ty];
      } else {
        ends.add(p[0], p[1], p);
      }
    }
  }

  mark('ends');
  // Segment index for T-junctions and crossings.
  const cell = Math.max(tolerance * 4, Math.round(40 / metresPerUnit));
  const segments = new Grid<{ line: number; i: number }>(cell);
  lines.forEach((line, li) => {
    for (let i = 0; i + 1 < line.points.length; i++) {
      const [ax, ay] = line.points[i];
      const [bx, by] = line.points[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
      let lastX = Number.NaN;
      let lastY = Number.NaN;
      for (let k = 0; k <= steps; k++) {
        const x = ax + ((bx - ax) * k) / steps;
        const y = ay + ((by - ay) * k) / steps;
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        if (cx === lastX && cy === lastY) continue;
        lastX = cx;
        lastY = cy;
        segments.add(x, y, { line: li, i });
      }
    }
  });
  mark('index');
  /** Vertices to insert: per line, `[segment index, t, x, y]`. */
  const inserts = new Map<number, [number, number, number, number][]>();
  const insert = (line: number, i: number, t: number, x: number, y: number) => {
    const list = inserts.get(line);
    if (list) list.push([i, t, x, y]);
    else inserts.set(line, [[i, t, x, y]]);
  };

  // 3b. An end near another line's segment interior lands on it: a T-junction.
  lines.forEach((line, li) => {
    for (const index of [0, line.points.length - 1]) {
      const [px, py] = line.points[index];
      let best: { line: number; i: number; t: number; d: number } | null = null;
      segments.near(px, py, ({ line: other, i }) => {
        if (other === li) return;
        const o = lines[other];
        if (o.level !== line.level) return;
        const [ax, ay] = o.points[i];
        const [bx, by] = o.points[i + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return;
        const t = ((px - ax) * dx + (py - ay) * dy) / len2;
        if (t <= 0 || t >= 1) return;
        const d = Math.hypot(ax + dx * t - px, ay + dy * t - py);
        if (d <= tolerance && (!best || d < best.d)) best = { line: other, i, t, d };
      });
      if (best) {
        const { line: other, i, t } = best as { line: number; i: number; t: number };
        const o = lines[other];
        const x = Math.round(o.points[i][0] + (o.points[i + 1][0] - o.points[i][0]) * t);
        const y = Math.round(o.points[i][1] + (o.points[i + 1][1] - o.points[i][1]) * t);
        line.points[index] = [x, y];
        insert(other, i, t, x, y);
        stats.tJunctions++;
      }
    }
  });

  mark('tees');
  // 4. Proper crossings at grade.
  const crossingVertices = new Set<string>();
  const candidates = new Set<number>();
  lines.forEach((line, li) => {
    for (let i = 0; i + 1 < line.points.length; i++) {
      const [ax, ay] = line.points[i];
      const [bx, by] = line.points[i + 1];
      // Every other segment near this one's cells, once each.
      candidates.clear();
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
      for (let k = 0; k <= steps; k += 1) {
        const x = ax + ((bx - ax) * k) / steps;
        const y = ay + ((by - ay) * k) / steps;
        segments.near(x, y, ({ line: other, i: j }) => {
          if (other > li) candidates.add(other * 1048576 + j);
        });
      }
      for (const candidate of candidates) {
        const other = Math.floor(candidate / 1048576);
        const j = candidate - other * 1048576;
        const o = lines[other];
        if (o.level !== line.level) continue;
        const [cx, cy] = o.points[j];
        const [dx, dy] = o.points[j + 1];
        const rx = bx - ax;
        const ry = by - ay;
        const sx = dx - cx;
        const sy = dy - cy;
        const den = rx * sy - ry * sx;
        if (den === 0) continue;
        const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
        const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
        if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) continue;
        const x = Math.round(ax + rx * t);
        const y = Math.round(ay + ry * t);
        insert(li, i, t, x, y);
        insert(other, j, u, x, y);
        stats.crossings++;
        if (line.car !== o.car) crossingVertices.add(keyOf(x, y));
      }
    }
  });

  mark('crossings');
  // Apply the inserted vertices.
  for (const [li, list] of inserts) {
    const line = lines[li];
    list.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const out: [number, number][] = [];
    let k = 0;
    for (let i = 0; i < line.points.length; i++) {
      out.push(line.points[i]);
      while (k < list.length && list[k][0] === i) {
        const [, , x, y] = list[k++];
        const last = out[out.length - 1];
        if (last[0] !== x || last[1] !== y) out.push([x, y]);
      }
    }
    line.points = out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
  }

  // 5. Split at every vertex two lines share (and at the ends).
  const uses = new Map<string, number>();
  for (const line of lines) {
    const seen = new Set<string>();
    for (const [x, y] of line.points) {
      const key = keyOf(x, y);
      if (seen.has(key)) continue;
      seen.add(key);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const raw: RoadPiece[] = [];
  for (const line of lines) {
    let run: [number, number][] = [line.points[0]];
    for (let i = 1; i < line.points.length; i++) {
      run.push(line.points[i]);
      const last = i === line.points.length - 1;
      if (last || (uses.get(keyOf(...line.points[i])) ?? 0) >= 2) {
        if (run.length >= 2) {
          const piece: RoadPiece = {
            way: 0,
            highway: line.highway,
            car: line.car,
            foot: line.foot,
            roundabout: false,
            tunnel: line.tunnel,
            points: run,
          };
          if (line.oneway) piece.oneway = line.oneway;
          if (line.access) piece.access = line.access;
          // A footway meeting a car road where they crossed: a crossing.
          if (
            line.foot &&
            (crossingVertices.has(keyOf(...run[0])) ||
              crossingVertices.has(keyOf(...run[run.length - 1])))
          ) {
            piece.footway = 'crossing';
          }
          raw.push(piece);
        }
        run = [line.points[i]];
      }
    }
  }

  mark('split');
  // 6. Drop fragments: components (car and foot apart) under the minimum length.
  const pieces: RoadPiece[] = [];
  for (const mode of ['car', 'foot'] as const) {
    const ofMode = raw.filter((p) => p[mode]);
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) as string;
      parent.set(k, r);
      return r;
    };
    for (const p of ofMode) {
      const a = keyOf(...p.points[0]);
      const b = keyOf(...p.points[p.points.length - 1]);
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      parent.set(find(a), find(b));
    }
    const length = new Map<string, number>();
    const lengthOf = (p: RoadPiece) => {
      let sum = 0;
      for (let i = 1; i < p.points.length; i++) {
        sum += Math.hypot(p.points[i][0] - p.points[i - 1][0], p.points[i][1] - p.points[i - 1][1]);
      }
      return sum * metresPerUnit;
    };
    for (const p of ofMode) {
      const root = find(keyOf(...p.points[0]));
      length.set(root, (length.get(root) ?? 0) + lengthOf(p));
    }
    for (const p of ofMode) {
      const root = find(keyOf(...p.points[0]));
      if ((length.get(root) ?? 0) >= MIN_COMPONENT_M) {
        if (mode === 'car' || !p.car) pieces.push(p);
      } else {
        stats.droppedFragments++;
      }
    }
  }
  stats.pieces = pieces.length;

  // 7. Synthesised signals where two major roads meet.
  const majorsAt = new Map<string, number>();
  for (const p of pieces) {
    if (!p.car || !MAJOR.has(p.highway)) continue;
    for (const end of [p.points[0], p.points[p.points.length - 1]]) {
      const key = keyOf(...end);
      majorsAt.set(key, (majorsAt.get(key) ?? 0) + 1);
    }
  }
  const carDegree = new Map<string, number>();
  for (const p of pieces) {
    if (!p.car) continue;
    for (const end of [p.points[0], p.points[p.points.length - 1]]) {
      const key = keyOf(...end);
      carDegree.set(key, (carDegree.get(key) ?? 0) + 1);
    }
  }
  const nodes: RoadNode[] = [];
  for (const [key, majors] of majorsAt) {
    // Two majors through the node (4 ends) and a junction at all.
    if (majors >= 3 && (carDegree.get(key) ?? 0) >= 3) {
      const [x, y] = key.split(',').map(Number);
      nodes.push({ kind: 'signals', x, y });
    }
  }
  stats.signals = nodes.length;
  mark('rest');
  return { pieces, nodes, stats };
}

/**
 * Cut healed pieces at z15 tile edges and keep only the tiles in `keep`:
 * each becomes a road tile like the archive's, so `buildNetwork` takes both.
 */
export function piecesForTiles(
  healed: { pieces: RoadPiece[]; nodes: RoadNode[] },
  keep: ReadonlySet<string>,
): Map<string, DecodedRoadTile> {
  const out = new Map<string, DecodedRoadTile>();
  const tileFor = (key: string) => {
    let tile = out.get(key);
    if (!tile) {
      tile = { pieces: [], nodes: [], restrictions: [] };
      out.set(key, tile);
    }
    return tile;
  };
  for (const piece of healed.pieces) {
    let current: { key: string; points: [number, number][] } | null = null;
    const flush = () => {
      if (current && current.points.length >= 2 && keep.has(current.key)) {
        tileFor(current.key).pieces.push({ ...piece, points: current.points });
      }
      current = null;
    };
    for (let i = 0; i + 1 < piece.points.length; i++) {
      const [ax, ay] = piece.points[i];
      const [bx, by] = piece.points[i + 1];
      const cuts: number[] = [];
      const across = (a: number, b: number) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let k = Math.floor(lo / Z15_EXTENT) + 1; k * Z15_EXTENT < hi; k++)
          cuts.push((k * Z15_EXTENT - a) / (b - a));
      };
      if (ax !== bx) across(ax, bx);
      if (ay !== by) across(ay, by);
      cuts.sort((p, q) => p - q);
      const stops: [number, number][] = [[ax, ay]];
      for (const t of cuts)
        if (t > 0 && t < 1) stops.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      stops.push([bx, by]);
      for (let j = 0; j + 1 < stops.length; j++) {
        const [px, py] = stops[j];
        const [qx, qy] = stops[j + 1];
        if (px === qx && py === qy) continue;
        const key = `${Math.floor((px + qx) / 2 / Z15_EXTENT)}/${Math.floor((py + qy) / 2 / Z15_EXTENT)}`;
        if (!current || (current as { key: string }).key !== key) {
          flush();
          current = { key, points: [[px, py]] };
        }
        (current as { points: [number, number][] }).points.push([qx, qy]);
      }
    }
    flush();
  }
  for (const node of healed.nodes) {
    const key = `${Math.floor(node.x / Z15_EXTENT)}/${Math.floor(node.y / Z15_EXTENT)}`;
    if (keep.has(key)) tileFor(key).nodes.push(node);
  }
  return out;
}
