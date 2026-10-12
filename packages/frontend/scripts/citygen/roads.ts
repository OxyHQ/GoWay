/**
 * OSM extract → the road layers of the city tiles (`lib/map/cityRoads.ts`).
 *
 * Its own passes over the extract, beside the building compiler
 * (`compile.ts`) rather than inside it: the two keep different elements and
 * different node sets, and either can change without touching the other.
 *
 *  1. **Ways and relations.** Ways whose `highway` is a road class are kept
 *     with their refs and the tags the simulation reads; `type=restriction`
 *     relations with a node `via` are kept with their from/via/to members.
 *  2. **Nodes.** Positions of every node a kept way uses, and the tags of the
 *     ones among them marked as signals, crossings, stops or give-ways.
 *
 * Then each way is split at every node it shares with another kept way (a
 * junction), at every tagged node (so a crossing or a signal is always a
 * piece end) and at every tile edge, and each piece goes to the one tile it
 * lies in. `cityRoads.ts` explains why that makes topology exact by position.
 *
 * Memory is the building compiler's layout: a sorted id array and two
 * coordinate arrays for the nodes roads use, 24 bytes a node.
 */
import { closeSync, openSync } from 'node:fs';

import {
  CITY_RESTRICTION_LAYER,
  CITY_ROAD_LAYER,
  CITY_ROAD_NODE_LAYER,
  ROAD_CLASSES,
  type RoadClass,
  type RoadNodeKind,
  type Sidewalk,
} from '../../lib/map/cityRoads';
import { CITY_TILE_EXTENT } from '../../lib/map/cityTiles';
import { collectGarbage, rssMb } from './memory';
import { type EncodedFeature, type EncodedLayer, encodeLines, encodePoint } from './mvtEncode';
import { type BlobRef, MEMBER_NODE, MEMBER_WAY, readBlob, readBlock, scanBlobs } from './osmPbf';
import {
  type Refusals,
  STREET_WAY_KEYS,
  type StreetProperties,
  streetNodeProperties,
  streetProperties,
} from './streetTags';

type Tags = Record<string, string>;

/** The way tags the road layer reads. Everything else is dropped on read. */
const KEPT_WAY_KEYS = new Set([
  'highway',
  'area',
  'access',
  'vehicle',
  'motor_vehicle',
  'motorcar',
  'foot',
  'service',
  'oneway',
  'junction',
  'lanes',
  'lanes:forward',
  'lanes:backward',
  'maxspeed',
  'sidewalk',
  'sidewalk:both',
  'sidewalk:left',
  'sidewalk:right',
  'footway',
  'tunnel',
  'covered',
  'indoor',
  // The street-detail properties (`streetTags.ts`).
  ...STREET_WAY_KEYS,
]);

const CLASSES = new Set<string>(ROAD_CLASSES);

const CAR_CLASSES = new Set<string>([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'road',
]);

const FOOT_CLASSES = new Set<string>([
  'pedestrian',
  'footway',
  'path',
  'steps',
  'living_street',
  'track',
]);

/** `service=*` values that are not through roads a simulated car should use. */
const PRIVATE_SERVICE = new Set(['parking_aisle', 'driveway', 'drive-through', 'emergency_access']);

const NO = new Set(['no', 'private', 'false']);
const YES = new Set(['yes', 'designated', 'permissive', 'destination', 'true', '1']);

/** The properties a `road` feature carries; absent = OSM does not record it. */
export type RoadProperties = StreetProperties & {
  highway: RoadClass;
  car: boolean;
  foot: boolean;
  cycle?: boolean;
  oneway?: 1 | -1;
  lanes?: number;
  lanes_forward?: number;
  lanes_backward?: number;
  maxspeed?: number;
  sidewalk?: Sidewalk;
  footway?: 'sidewalk' | 'crossing';
  roundabout?: boolean;
  tunnel?: boolean;
};

function lanesOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,2}$/.test(value.trim())) return undefined;
  const n = Number(value);
  return n >= 1 && n <= 12 ? n : undefined;
}

/**
 * `maxspeed` in km/h: a number, `N mph`, `N km/h`, or `walk`. Country-implicit
 * values (`ES:urban`, `RU:living_street`) and `none` are not numbers and are
 * refused — the simulation's class default applies, and says so.
 */
export function parseMaxspeed(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim().toLowerCase();
  if (raw === 'walk') return 6;
  const match = /^(\d{1,3}(?:\.\d+)?)\s*(km\/h|kmh|kph|mph|knots)?$/.exec(raw);
  if (!match) return undefined;
  const n = Number(match[1]);
  const kmh = match[2] === 'mph' ? n * 1.609344 : match[2] === 'knots' ? n * 1.852 : n;
  return kmh >= 5 && kmh <= 200 ? Math.round(kmh) : undefined;
}

function sidewalkOf(tags: Tags): Sidewalk | undefined {
  const value = tags.sidewalk;
  if (value === 'both' || value === 'left' || value === 'right' || value === 'separate') {
    return value;
  }
  if (value === 'yes') return 'both';
  if (value === 'no' || value === 'none') return 'no';
  const both = tags['sidewalk:both'];
  const left = tags['sidewalk:left'];
  const right = tags['sidewalk:right'];
  if (both === 'separate' || left === 'separate' || right === 'separate') return 'separate';
  if (both === 'yes') return 'both';
  if (both === 'no') return 'no';
  const l = left === 'yes';
  const r = right === 'yes';
  if (l && r) return 'both';
  if (l) return 'left';
  if (r) return 'right';
  if (left === 'no' && right === 'no') return 'no';
  return undefined;
}

/** A way's road properties, or `null` when it is not a road the layer keeps. */
export function roadProperties(tags: Tags): RoadProperties | null {
  const highway = tags.highway;
  if (!highway || !CLASSES.has(highway)) return null;
  if (tags.area === 'yes' || tags.indoor === 'yes') return null;

  const access = tags.access;
  const motor = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle;
  let car = CAR_CLASSES.has(highway);
  if (car && access !== undefined && NO.has(access) && !(motor && YES.has(motor))) car = false;
  if (car && motor !== undefined && NO.has(motor)) car = false;
  if (car && highway === 'service' && PRIVATE_SERVICE.has(tags.service ?? '')) car = false;

  let foot = FOOT_CLASSES.has(highway) || (highway === 'cycleway' && YES.has(tags.foot ?? ''));
  if (foot && tags.foot !== undefined && NO.has(tags.foot)) foot = false;
  if (foot && access === 'no' && !(tags.foot && YES.has(tags.foot))) foot = false;
  // A separate cycle track is kept for the street detail even where it is
  // neither a car's nor a person's (`ROAD_PROPS.cycle`).
  const cycle = highway === 'cycleway';
  if (!car && !foot && !cycle) return null;

  const props: RoadProperties = { highway: highway as RoadClass, car, foot };
  if (cycle) props.cycle = true;
  const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular';
  if (roundabout) props.roundabout = true;
  if (car) {
    const oneway = tags.oneway;
    if (oneway === '-1' || oneway === 'reverse') props.oneway = -1;
    else if (oneway === 'yes' || oneway === 'true' || oneway === '1') props.oneway = 1;
    else if (oneway !== 'no' && (roundabout || highway === 'motorway')) props.oneway = 1;
    const lanes = lanesOf(tags.lanes);
    if (lanes !== undefined) props.lanes = lanes;
    const forward = lanesOf(tags['lanes:forward']);
    if (forward !== undefined) props.lanes_forward = forward;
    const backward = lanesOf(tags['lanes:backward']);
    if (backward !== undefined) props.lanes_backward = backward;
    const maxspeed = parseMaxspeed(tags.maxspeed);
    if (maxspeed !== undefined) props.maxspeed = maxspeed;
    const sidewalk = sidewalkOf(tags);
    if (sidewalk !== undefined) props.sidewalk = sidewalk;
  }
  if (highway === 'footway' && (tags.footway === 'sidewalk' || tags.footway === 'crossing')) {
    props.footway = tags.footway;
  }
  const tunnel = tags.tunnel;
  if (tunnel === 'yes' || tunnel === 'building_passage' || tags.covered === 'yes') {
    props.tunnel = true;
  }
  return props;
}

/** A tagged node's properties on the tile: its kind, and the street detail it records. */
export type RoadNodeProperties = {
  kind: RoadNodeKind;
  crossing?: string;
  crossing_markings?: string;
  crossing_ref?: string;
  direction?: 'forward' | 'backward';
};

/** What a tagged node is to the simulation, or `null`. */
export function roadNodeKind(tags: Tags): { kind: RoadNodeKind; crossing?: string } | null {
  const highway = tags.highway;
  if (highway === 'traffic_signals') return { kind: 'signals' };
  if (highway === 'crossing') {
    const crossing = tags.crossing;
    return crossing ? { kind: 'crossing', crossing } : { kind: 'crossing' };
  }
  if (highway === 'stop') return { kind: 'stop' };
  if (highway === 'give_way') return { kind: 'give_way' };
  return null;
}

/** {@link roadNodeKind} plus the street-detail properties (`streetTags.ts`). */
export function roadNodeProperties(tags: Tags, refused?: Refusals): RoadNodeProperties | null {
  const kind = roadNodeKind(tags);
  if (!kind) return null;
  return { ...kind, ...streetNodeProperties(tags, refused) };
}

/** The node keys {@link roadNodeProperties} reads. */
const KEPT_NODE_KEYS = new Set([
  'highway',
  'crossing',
  'crossing:markings',
  'crossing_ref',
  'direction',
  'traffic_signals:direction',
]);

const RESTRICTIONS =
  /^(no_left_turn|no_right_turn|no_straight_on|no_u_turn|only_left_turn|only_right_turn|only_straight_on)$/;

export interface RoadCoverage {
  ways: number;
  carWays: number;
  footWays: number;
  byClass: Record<string, number>;
  withLanes: number;
  withMaxspeed: number;
  maxspeedRefused: number;
  withSidewalk: number;
  oneway: number;
  sidewalkFootways: number;
  crossingFootways: number;
  tunnels: number;
  pieces: number;
  nodes: Record<string, number>;
  restrictions: number;
  restrictionsSkipped: number;
  missingNodes: number;
  /** Street detail (`streetTags.ts`): car ways recording each, and values refused by key. */
  street: {
    named: number;
    width: number;
    turnLanes: number;
    busLanes: number;
    cycleLanes: number;
    parking: number;
    changeLanes: number;
    cycleways: number;
    refused: Refusals;
  };
}

export interface RoadTile {
  roads: EncodedFeature[];
  nodes: EncodedFeature[];
  restrictions: EncodedFeature[];
}

export interface RoadCompileResult {
  tiles: Map<string, RoadTile>;
  coverage: RoadCoverage;
  timings: Record<string, number>;
}

export interface RoadCompileOptions {
  pbf: string;
  zoom: number;
  /** `[west, south, east, north]`: keep pieces whose first segment's midpoint is inside. */
  bbox?: [number, number, number, number];
  /** Keep only the tiles this returns true for: a region's owned tiles (`ownership.ts`). */
  keepTile?: (x: number, y: number) => boolean;
  log?: (line: string) => void;
}

/** The road layers of one tile, in the order they are written. Empty layers are skipped by the encoder. */
export function roadLayers(tile: RoadTile | undefined): EncodedLayer[] {
  if (!tile) return [];
  return [
    { name: CITY_ROAD_LAYER, features: tile.roads },
    { name: CITY_ROAD_NODE_LAYER, features: tile.nodes },
    { name: CITY_RESTRICTION_LAYER, features: tile.restrictions },
  ];
}

const mercX = (lon: number) => (lon + 180) / 360;
function mercY(lat: number): number {
  const phi = (Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}

function lowerBound(sorted: Float64Array, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Cut a polyline in GLOBAL tile units (`mercator × 2^z × extent`) at every
 * tile edge, and group the result by tile. Each piece's points lie inside (or
 * on the edge of) its tile; a cut point is computed once and written to both
 * pieces, so the two tiles agree on it exactly.
 */
export function splitAtTileEdges(
  points: readonly (readonly [number, number])[],
  extent = CITY_TILE_EXTENT,
): { tx: number; ty: number; points: [number, number][] }[] {
  const pieces: { tx: number; ty: number; points: [number, number][] }[] = [];
  let current: { tx: number; ty: number; points: [number, number][] } | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const cuts: number[] = [];
    const across = (a: number, b: number) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let k = Math.floor(lo / extent) + 1; k * extent < hi; k++) {
        cuts.push((k * extent - a) / (b - a));
      }
    };
    if (ax !== bx) across(ax, bx);
    if (ay !== by) across(ay, by);
    cuts.sort((a, b) => a - b);
    const stops: [number, number][] = [[ax, ay]];
    for (const t of cuts) {
      if (t <= 0 || t >= 1) continue;
      stops.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
    stops.push([bx, by]);
    for (let j = 0; j + 1 < stops.length; j++) {
      const [px, py] = stops[j];
      const [qx, qy] = stops[j + 1];
      if (px === qx && py === qy) continue;
      const tx = Math.floor((px + qx) / 2 / extent);
      const ty = Math.floor((py + qy) / 2 / extent);
      if (!current || current.tx !== tx || current.ty !== ty) {
        current = { tx, ty, points: [[px, py]] };
        pieces.push(current);
      }
      current.points.push([qx, qy]);
    }
  }
  return pieces;
}

export function compileRoads(options: RoadCompileOptions): RoadCompileResult {
  const log = options.log ?? (() => {});
  const timings: Record<string, number> = {};
  let started = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - started);
    started = now;
    log(`  roads ${name.padEnd(10)} ${(timings[name] / 1000).toFixed(1)} s · rss ${rssMb()} MB`);
  };

  const blobs = scanBlobs(options.pbf);
  const fd = openSync(options.pbf, 'r');
  const nodeBlobs: BlobRef[] = [];

  // ── Pass 1: road ways, node-via restrictions ────────────────────────────
  const ways: { id: number; props: RoadProperties; refs: Float64Array }[] = [];
  const restrictions: { from: number; via: number; to: number; type: 'no' | 'only' }[] = [];
  let restrictionsSkipped = 0;
  let maxspeedRefused = 0;
  const refused: Refusals = {};
  for (const blob of blobs) {
    if (blob.type !== 'OSMData') continue;
    const bytes = readBlob(fd, blob);
    let strings: string[] = [];
    const contents = readBlock(bytes, {
      onStrings(table) {
        strings = table;
      },
      onWay(id, keys, vals, refs) {
        let isHighway = false;
        for (const k of keys) {
          if (strings[k] === 'highway') {
            isHighway = true;
            break;
          }
        }
        if (!isHighway || refs.length < 2) return;
        const tags: Tags = {};
        for (let i = 0; i < keys.length; i++) {
          const key = strings[keys[i]];
          if (KEPT_WAY_KEYS.has(key)) tags[key] = strings[vals[i]];
        }
        const base = roadProperties(tags);
        if (!base) return;
        const props: RoadProperties = { ...base, ...streetProperties(tags, base.car, refused) };
        if (props.car && tags.maxspeed !== undefined && props.maxspeed === undefined) {
          maxspeedRefused++;
        }
        ways.push({ id, props, refs: Float64Array.from(refs) });
      },
      onRelation(_id, keys, vals, memberIds, memberTypes, roles) {
        let type: string | undefined;
        let restriction: string | undefined;
        for (let i = 0; i < keys.length; i++) {
          const key = strings[keys[i]];
          if (key === 'type') type = strings[vals[i]];
          else if (key === 'restriction' || key === 'restriction:motorcar') {
            restriction = strings[vals[i]];
          }
        }
        if (type !== 'restriction' || !restriction) return;
        if (!RESTRICTIONS.test(restriction)) {
          restrictionsSkipped++;
          return;
        }
        let from: number | undefined;
        let to: number | undefined;
        let via: number | undefined;
        let ok = true;
        for (let i = 0; i < memberIds.length; i++) {
          const role = strings[roles[i]];
          if (role === 'from' && memberTypes[i] === MEMBER_WAY && from === undefined) {
            from = memberIds[i];
          } else if (role === 'to' && memberTypes[i] === MEMBER_WAY && to === undefined) {
            to = memberIds[i];
          } else if (role === 'via' && memberTypes[i] === MEMBER_NODE && via === undefined) {
            via = memberIds[i];
          } else if (role === 'from' || role === 'to' || role === 'via') {
            ok = false; // a via way, or several from/to: not modelled
          }
        }
        if (!ok || from === undefined || to === undefined || via === undefined) {
          restrictionsSkipped++;
          return;
        }
        restrictions.push({ from, via, to, type: restriction.startsWith('only') ? 'only' : 'no' });
      },
    });
    if (contents.nodes) nodeBlobs.push(blob);
  }
  lap('ways+rels');
  // Only the ways a restriction names need their id on the tile: the rest
  // would be a unique number per piece, measured at a third of the bytes.
  const named = new Set<number>();
  for (const restriction of restrictions) {
    named.add(restriction.from);
    named.add(restriction.to);
  }

  // ── Pass 2: node positions and node tags ────────────────────────────────
  let refCount = 0;
  for (const way of ways) refCount += way.refs.length;
  const all = new Float64Array(refCount);
  let at = 0;
  for (const way of ways) {
    all.set(way.refs, at);
    at += way.refs.length;
  }
  all.sort();
  // How many way-occurrences each node has: 2+ is a junction.
  let unique = 0;
  const uses = new Uint16Array(all.length);
  for (let i = 0; i < all.length; i++) {
    if (i === 0 || all[i] !== all[i - 1]) {
      all[unique] = all[i];
      uses[unique] = 1;
      unique++;
    } else if (uses[unique - 1] < 65535) {
      uses[unique - 1]++;
    }
  }
  const nodeIds = all.subarray(0, unique);
  const nodeX = new Float64Array(unique).fill(Number.NaN);
  const nodeY = new Float64Array(unique).fill(Number.NaN);
  const special = new Map<number, RoadNodeProperties>();
  for (const blob of nodeBlobs) {
    let strings: string[] = [];
    readBlock(readBlob(fd, blob), {
      wantNodes: true,
      onStrings(table) {
        strings = table;
      },
      onNode(id, lon, lat) {
        const index = lowerBound(nodeIds, id);
        if (index < unique && nodeIds[index] === id) {
          nodeX[index] = mercX(lon);
          nodeY[index] = mercY(lat);
        }
      },
      onTaggedNode(id, _lon, _lat, keys, vals) {
        let tags: Tags | null = null;
        for (let i = 0; i < keys.length; i++) {
          const key = strings[keys[i]];
          if (!KEPT_NODE_KEYS.has(key)) continue;
          tags ??= {};
          tags[key] = strings[vals[i]];
        }
        if (!tags?.highway) return;
        const index = lowerBound(nodeIds, id);
        if (index >= unique || nodeIds[index] !== id) return;
        const kind = roadNodeProperties(tags, refused);
        if (kind) special.set(index, kind);
      },
    });
  }
  closeSync(fd);
  collectGarbage();
  lap('nodes');

  // ── Split, tile, encode ─────────────────────────────────────────────────
  const span = 2 ** options.zoom;
  const unit = span * CITY_TILE_EXTENT;
  const box = options.bbox
    ? {
        x0: mercX(options.bbox[0]) * unit,
        x1: mercX(options.bbox[2]) * unit,
        y0: mercY(options.bbox[3]) * unit,
        y1: mercY(options.bbox[1]) * unit,
      }
    : null;
  const inBox = (x: number, y: number) =>
    !box || (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1);
  // A regional build keeps only the tiles its region owns (`ownership.ts`).
  // Every piece is already cut to one tile, so the decision is per tile and
  // the neighbouring region's archive holds the rest of a road that crosses.
  const tileKept = (tx: number, ty: number) => !options.keepTile || options.keepTile(tx, ty);
  const tiles = new Map<string, RoadTile>();
  const tileFor = (tx: number, ty: number): RoadTile => {
    const key = `${options.zoom}/${tx}/${ty}`;
    let tile = tiles.get(key);
    if (!tile) {
      tile = { roads: [], nodes: [], restrictions: [] };
      tiles.set(key, tile);
    }
    return tile;
  };
  const coverage: RoadCoverage = {
    ways: 0,
    carWays: 0,
    footWays: 0,
    byClass: {},
    withLanes: 0,
    withMaxspeed: 0,
    maxspeedRefused,
    withSidewalk: 0,
    oneway: 0,
    sidewalkFootways: 0,
    crossingFootways: 0,
    tunnels: 0,
    pieces: 0,
    nodes: {},
    restrictions: 0,
    restrictionsSkipped,
    missingNodes: 0,
    street: {
      named: 0,
      width: 0,
      turnLanes: 0,
      busLanes: 0,
      cycleLanes: 0,
      parking: 0,
      changeLanes: 0,
      cycleways: 0,
      refused,
    },
  };

  const indexOf = (ref: number): number => {
    const index = lowerBound(nodeIds, ref);
    return index < unique && nodeIds[index] === ref && !Number.isNaN(nodeX[index]) ? index : -1;
  };
  const emittedNodes = new Set<number>();

  for (const way of ways) {
    const { props, refs } = way;
    const id = named.has(way.id) ? way.id : 0;
    const properties: Record<string, string | number | boolean> = id
      ? { way: id, ...props }
      : { ...props };
    let anyPiece = false;
    let chain: number[] = [];
    const flush = () => {
      if (chain.length >= 2) {
        const global = chain.map((index) => [nodeX[index] * unit, nodeY[index] * unit] as const);
        for (const piece of splitAtTileEdges(global)) {
          const [p, q] = piece.points;
          if (!inBox((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)) continue;
          if (!tileKept(piece.tx, piece.ty)) continue;
          const ox = piece.tx * CITY_TILE_EXTENT;
          const oy = piece.ty * CITY_TILE_EXTENT;
          const geometry = encodeLines([piece.points.map(([x, y]) => [x - ox, y - oy] as const)]);
          if (geometry.length === 0) continue;
          tileFor(piece.tx, piece.ty).roads.push({ id, type: 2, geometry, properties });
          coverage.pieces++;
          anyPiece = true;
        }
      }
      chain = [];
    };
    for (let i = 0; i < refs.length; i++) {
      const index = indexOf(refs[i]);
      if (index < 0) {
        // A node outside the extract: the way stops there and resumes after.
        coverage.missingNodes++;
        flush();
        continue;
      }
      chain.push(index);
      const last = i === refs.length - 1;
      if (!last && chain.length >= 2 && (uses[index] >= 2 || special.has(index))) {
        flush();
        chain.push(index);
      }
      const kind = special.get(index);
      if (kind && !emittedNodes.has(index)) {
        emittedNodes.add(index);
        const gx = nodeX[index] * unit;
        const gy = nodeY[index] * unit;
        const tx = Math.floor(gx / CITY_TILE_EXTENT);
        const ty = Math.floor(gy / CITY_TILE_EXTENT);
        if (inBox(gx, gy) && tileKept(tx, ty)) {
          tileFor(tx, ty).nodes.push({
            id: 0,
            type: 1,
            geometry: encodePoint([gx - tx * CITY_TILE_EXTENT, gy - ty * CITY_TILE_EXTENT]),
            properties: { ...kind },
          });
          coverage.nodes[kind.kind] = (coverage.nodes[kind.kind] ?? 0) + 1;
        }
      }
    }
    flush();
    if (!anyPiece) continue;
    coverage.ways++;
    if (props.car) coverage.carWays++;
    if (props.foot) coverage.footWays++;
    coverage.byClass[props.highway] = (coverage.byClass[props.highway] ?? 0) + 1;
    if (props.lanes !== undefined || props.lanes_forward !== undefined) coverage.withLanes++;
    if (props.maxspeed !== undefined) coverage.withMaxspeed++;
    if (props.sidewalk !== undefined) coverage.withSidewalk++;
    if (props.oneway !== undefined) coverage.oneway++;
    if (props.footway === 'sidewalk') coverage.sidewalkFootways++;
    if (props.footway === 'crossing') coverage.crossingFootways++;
    if (props.tunnel) coverage.tunnels++;
    if (props.cycle) coverage.street.cycleways++;
    if (props.car) {
      const street = coverage.street;
      if (props.name) street.named++;
      if (props.width !== undefined) street.width++;
      if (props.turn_lanes || props.turn_lanes_forward || props.turn_lanes_backward) {
        street.turnLanes++;
      }
      if (
        props.bus_lanes ||
        props.bus_lanes_forward ||
        props.bus_lanes_backward ||
        props.busway ||
        props.lanes_bus ||
        props.lanes_bus_forward ||
        props.lanes_bus_backward
      ) {
        street.busLanes++;
      }
      if (props.cycle_lane) street.cycleLanes++;
      if (props.parking) street.parking++;
      if (props.change_lanes || props.change_lanes_forward || props.change_lanes_backward) {
        street.changeLanes++;
      }
    }
  }

  for (const restriction of restrictions) {
    const index = indexOf(restriction.via);
    if (index < 0) continue;
    const gx = nodeX[index] * unit;
    const gy = nodeY[index] * unit;
    const tx = Math.floor(gx / CITY_TILE_EXTENT);
    const ty = Math.floor(gy / CITY_TILE_EXTENT);
    if (!inBox(gx, gy) || !tileKept(tx, ty)) continue;
    tileFor(tx, ty).restrictions.push({
      id: 0,
      type: 1,
      geometry: encodePoint([gx - tx * CITY_TILE_EXTENT, gy - ty * CITY_TILE_EXTENT]),
      properties: { from: restriction.from, to: restriction.to, type: restriction.type },
    });
    coverage.restrictions++;
  }
  lap('tiles');
  return { tiles, coverage, timings };
}
