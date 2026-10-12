/**
 * A city tile's road layers → road pieces, tagged nodes and turn restrictions
 * in GLOBAL tile units (`lib/map/cityRoads.ts` says why those make topology
 * exact).
 *
 * Runs in the simulation worker, and in the street-detail worker
 * (`engine/cityStreets/`), which reads the schema-2 street properties too
 * (`STREET_PROPS`; absent on a schema-1 tile). Every property came over the
 * network, so each is type- and range-checked and a bad one is dropped: a
 * piece with a nonsense lane count gets the simulation's default, never the
 * nonsense, and one with a garbled `turn_lanes` gets no arrows, never wrong ones.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import {
  CITY_RESTRICTION_LAYER,
  CITY_ROAD_LAYER,
  CITY_ROAD_NODE_LAYER,
  ROAD_CLASSES,
  ROAD_NODE_KINDS,
  type RoadClass,
  type RoadNodeKind,
  SIDES,
  SIDEWALKS,
  type Side,
  type Sidewalk,
  TURNS,
  type Turn,
} from '@/lib/map/cityRoads';
import { CITY_TILE_EXTENT } from '@/lib/map/cityTiles';

/** One road piece: an OSM way between two graph nodes, within one tile. */
export interface RoadPiece {
  way: number;
  highway: RoadClass;
  car: boolean;
  foot: boolean;
  /** `1`/`-1` one-way for cars (against the drawn direction when `-1`); absent: both. */
  oneway?: 1 | -1;
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  /** km/h, recorded. */
  maxspeed?: number;
  sidewalk?: Sidewalk;
  footway?: 'sidewalk' | 'crossing';
  roundabout: boolean;
  tunnel: boolean;
  /** Global tile units (`local + tile × extent`), y down. */
  points: [number, number][];
  // ── Street detail (schema 2, `STREET_PROPS`): absent = not recorded readably ──
  bridge?: boolean;
  name?: string;
  /** Carriageway width, metres. */
  width?: number;
  /** Per lane, in the tag's order (the traveller's left to right), its turns; `[]` for `none`. */
  turnLanes?: Turn[][];
  turnLanesForward?: Turn[][];
  turnLanesBackward?: Turn[][];
  /** Per lane, in the tag's order: designated for buses. */
  busLanes?: boolean[];
  busLanesForward?: boolean[];
  busLanesBackward?: boolean[];
  busway?: Side;
  lanesBus?: number;
  lanesBusForward?: number;
  lanesBusBackward?: number;
  cycleLane?: Side;
  parking?: Side;
  sidewalkWidth?: number;
  /** On a `footway=crossing` piece. */
  crossing?: string;
  crossingMarkings?: string;
}

export interface RoadNode {
  kind: RoadNodeKind;
  crossing?: string;
  /** Schema 2: `crossing:markings`, `crossing_ref`, a signal's or sign's facing. */
  crossingMarkings?: string;
  crossingRef?: string;
  direction?: 'forward' | 'backward';
  /** Global tile units. */
  x: number;
  y: number;
}

export interface TurnRestriction {
  from: number;
  to: number;
  type: 'no' | 'only';
  /** Global tile units of the `via` node. */
  x: number;
  y: number;
}

export interface DecodedRoadTile {
  pieces: RoadPiece[];
  nodes: RoadNode[];
  restrictions: TurnRestriction[];
}

const CLASSES = new Set<string>(ROAD_CLASSES);
const KINDS = new Set<string>(ROAD_NODE_KINDS);
const SIDEWALK_VALUES = new Set<string>(SIDEWALKS);

const SIDE_VALUES = new Set<string>(SIDES);
const TURN_VALUES = new Set<string>(TURNS);

const int = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;

const num = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;

const word = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-z_:;]{1,24}$/.test(value) ? value : undefined;

const side = (value: unknown): Side | undefined =>
  typeof value === 'string' && SIDE_VALUES.has(value) ? (value as Side) : undefined;

/** `left|through;right|none` → `[['left'], ['through', 'right'], []]`, or `undefined` for junk. */
export function parseTurnLanes(value: unknown): Turn[][] | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return undefined;
  const lanes = value.split('|');
  if (lanes.length > 12) return undefined;
  const out: Turn[][] = [];
  for (const lane of lanes) {
    const turns = lane.split(';');
    if (turns.some((t) => !TURN_VALUES.has(t))) return undefined;
    out.push(turns.filter((t) => t !== 'none') as Turn[]);
  }
  return out;
}

/** `--b` → `[false, false, true]`, or `undefined` for junk. */
export function parseBusLanes(value: unknown): boolean[] | undefined {
  if (typeof value !== 'string' || !/^[b-]{1,12}$/.test(value)) return undefined;
  return [...value].map((c) => c === 'b');
}

/** The schema-2 street properties of a `road` feature, only those that read. */
function streetFields(p: Record<string, unknown>): Partial<RoadPiece> {
  const out: Partial<RoadPiece> = {
    bridge: p.bridge === true ? true : undefined,
    name:
      typeof p.name === 'string' && p.name.trim() !== '' && p.name.length <= 120
        ? p.name.trim()
        : undefined,
    width: num(p.width, 2, 60),
    turnLanes: parseTurnLanes(p.turn_lanes),
    turnLanesForward: parseTurnLanes(p.turn_lanes_forward),
    turnLanesBackward: parseTurnLanes(p.turn_lanes_backward),
    busLanes: parseBusLanes(p.bus_lanes),
    busLanesForward: parseBusLanes(p.bus_lanes_forward),
    busLanesBackward: parseBusLanes(p.bus_lanes_backward),
    busway: side(p.busway),
    lanesBus: int(p.lanes_bus, 1, 12),
    lanesBusForward: int(p.lanes_bus_forward, 1, 12),
    lanesBusBackward: int(p.lanes_bus_backward, 1, 12),
    cycleLane: side(p.cycle_lane),
    parking: side(p.parking),
    sidewalkWidth: num(p.sidewalk_width, 0.5, 20),
    crossing: word(p.crossing),
    crossingMarkings: word(p.crossing_markings),
  };
  for (const key of Object.keys(out) as (keyof RoadPiece)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

/**
 * Decode one tile. `tile` is where it sits (its `x`/`y` at the archive's
 * zoom); its coordinates are offset by `tile × extent` so pieces from
 * neighbouring tiles meet at equal numbers. A tile without road layers (an
 * archive built `--no-roads`, or open country) decodes to empty lists.
 */
export function decodeRoadTile(
  bytes: ArrayBuffer | Uint8Array,
  tile: { x: number; y: number } = { x: 0, y: 0 },
): DecodedRoadTile {
  const out: DecodedRoadTile = { pieces: [], nodes: [], restrictions: [] };
  const vt = new VectorTile(
    new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  );

  const roads = vt.layers[CITY_ROAD_LAYER];
  const scaleOf = (extent: number) => CITY_TILE_EXTENT / extent;
  if (roads) {
    const scale = scaleOf(roads.extent);
    const ox = tile.x * CITY_TILE_EXTENT;
    const oy = tile.y * CITY_TILE_EXTENT;
    for (let i = 0; i < roads.length; i++) {
      const feature = roads.feature(i);
      if (feature.type !== 2) continue;
      const p = feature.properties;
      const highway = p.highway;
      if (typeof highway !== 'string' || !CLASSES.has(highway)) continue;
      const car = p.car === true;
      const foot = p.foot === true;
      if (!car && !foot) continue;
      const way = int(p.way, 0, Number.MAX_SAFE_INTEGER) ?? 0;
      const street = streetFields(p);
      for (const line of feature.loadGeometry()) {
        if (line.length < 2) continue;
        const piece: RoadPiece = {
          way,
          highway: highway as RoadClass,
          car,
          foot,
          roundabout: p.roundabout === true,
          tunnel: p.tunnel === true,
          points: line.map((point) => [ox + point.x * scale, oy + point.y * scale]),
          ...street,
        };
        if (p.oneway === 1 || p.oneway === -1) piece.oneway = p.oneway;
        const lanes = int(p.lanes, 1, 12);
        if (lanes !== undefined) piece.lanes = lanes;
        const forward = int(p.lanes_forward, 1, 12);
        if (forward !== undefined) piece.lanesForward = forward;
        const backward = int(p.lanes_backward, 1, 12);
        if (backward !== undefined) piece.lanesBackward = backward;
        const maxspeed = int(p.maxspeed, 5, 200);
        if (maxspeed !== undefined) piece.maxspeed = maxspeed;
        if (typeof p.sidewalk === 'string' && SIDEWALK_VALUES.has(p.sidewalk)) {
          piece.sidewalk = p.sidewalk as Sidewalk;
        }
        if (p.footway === 'sidewalk' || p.footway === 'crossing') piece.footway = p.footway;
        out.pieces.push(piece);
      }
    }
  }

  const points = (
    layerName: string,
    each: (x: number, y: number, props: Record<string, unknown>) => void,
  ) => {
    const layer = vt.layers[layerName];
    if (!layer) return;
    const scale = scaleOf(layer.extent);
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (feature.type !== 1) continue;
      const point = feature.loadGeometry()[0]?.[0];
      if (!point) continue;
      each(
        tile.x * CITY_TILE_EXTENT + point.x * scale,
        tile.y * CITY_TILE_EXTENT + point.y * scale,
        feature.properties,
      );
    }
  };
  points(CITY_ROAD_NODE_LAYER, (x, y, p) => {
    if (typeof p.kind !== 'string' || !KINDS.has(p.kind)) return;
    const node: RoadNode = { kind: p.kind as RoadNodeKind, x, y };
    if (typeof p.crossing === 'string') node.crossing = p.crossing;
    const markings = word(p.crossing_markings);
    if (markings) node.crossingMarkings = markings;
    const ref = word(p.crossing_ref);
    if (ref) node.crossingRef = ref;
    if (p.direction === 'forward' || p.direction === 'backward') node.direction = p.direction;
    out.nodes.push(node);
  });
  points(CITY_RESTRICTION_LAYER, (x, y, p) => {
    const from = int(p.from, 0, Number.MAX_SAFE_INTEGER);
    const to = int(p.to, 0, Number.MAX_SAFE_INTEGER);
    if (from === undefined || to === undefined) return;
    if (p.type !== 'no' && p.type !== 'only') return;
    out.restrictions.push({ from, to, type: p.type, x, y });
  });
  return out;
}
