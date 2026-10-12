/**
 * OSM way and node tags → the street-detail properties of the road tiles
 * (`lib/map/cityRoads.ts` → `STREET_PROPS`, `STREET_NODE_PROPS`), for the
 * street renderer (`docs/MAP_STREETS.md`).
 *
 * Pure. Every value is what OSM records, normalised; a value that cannot be
 * read is REFUSED (absent on the tile, counted under its key in the receipt),
 * never coerced into something plausible — a lane pattern with a typo would
 * otherwise paint an arrow nobody recorded.
 */
import { type Side, TURNS } from '../../lib/map/cityRoads';

type Tags = Record<string, string>;

/** The way keys this module reads (the compiler keeps them on read). */
export const STREET_WAY_KEYS = [
  'name',
  'width',
  'turn:lanes',
  'turn:lanes:forward',
  'turn:lanes:backward',
  'bus:lanes',
  'bus:lanes:forward',
  'bus:lanes:backward',
  'psv:lanes',
  'psv:lanes:forward',
  'psv:lanes:backward',
  'busway',
  'busway:left',
  'busway:right',
  'busway:both',
  'lanes:bus',
  'lanes:bus:forward',
  'lanes:bus:backward',
  'lanes:psv',
  'lanes:psv:forward',
  'lanes:psv:backward',
  'cycleway',
  'cycleway:left',
  'cycleway:right',
  'cycleway:both',
  'parking:lane:left',
  'parking:lane:right',
  'parking:lane:both',
  'parking:left',
  'parking:right',
  'parking:both',
  'sidewalk:width',
  'sidewalk:both:width',
  'sidewalk:left:width',
  'sidewalk:right:width',
  'bridge',
  'crossing',
  'crossing:markings',
  'change:lanes',
  'change:lanes:forward',
  'change:lanes:backward',
] as const;

/** The street properties of one way; absent = OSM does not record it (readably). */
export interface StreetProperties {
  name?: string;
  width?: number;
  turn_lanes?: string;
  turn_lanes_forward?: string;
  turn_lanes_backward?: string;
  bus_lanes?: string;
  bus_lanes_forward?: string;
  bus_lanes_backward?: string;
  busway?: Side;
  lanes_bus?: number;
  lanes_bus_forward?: number;
  lanes_bus_backward?: number;
  cycle_lane?: Side;
  parking?: Side;
  sidewalk_width?: number;
  bridge?: boolean;
  crossing?: string;
  crossing_markings?: string;
  change_lanes?: string;
  change_lanes_forward?: string;
  change_lanes_backward?: string;
}

/** What could not be read, by tag key (the receipt's `refused`). */
export type Refusals = Record<string, number>;

const refuse = (refused: Refusals | undefined, key: string) => {
  if (refused) refused[key] = (refused[key] ?? 0) + 1;
};

/**
 * A length in metres: `12`, `12 m`, `12.5m`, `40 ft`, `40'`, `12'6"`. Anything
 * else — `wide`, `~10`, `10;12`, a range — is not a length.
 */
export function parseLengthM(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim().toLowerCase();
  let match = /^(\d{1,3}(?:\.\d+)?)\s*(m)?$/.exec(raw);
  if (match) return Number(match[1]);
  match = /^(\d{1,3}(?:\.\d+)?)\s*(ft|feet)$/.exec(raw);
  if (match) return Number(match[1]) * 0.3048;
  match = /^(\d{1,3})'(?:\s*(\d{1,2})")?$/.exec(raw);
  if (match) return Number(match[1]) * 0.3048 + Number(match[2] ?? 0) * 0.0254;
  return undefined;
}

const TURN_SET = new Set<string>(TURNS);

/**
 * `turn:lanes` normalised: one entry per lane, `|`-separated, each lane's
 * values `;`-separated in the tag's order, an empty lane as `none`. `null`
 * when ANY value is unknown (`left;slight`, `straight`, `l`): the whole tag
 * is refused, since one wrong lane would shift every arrow after it.
 */
export function normaliseTurnLanes(value: string | undefined): string | null {
  if (value === undefined) return null;
  const lanes = value.split('|');
  if (lanes.length === 0 || lanes.length > 12) return null;
  const out: string[] = [];
  for (const lane of lanes) {
    const values = lane
      .split(';')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== '');
    if (values.length === 0) {
      out.push('none');
      continue;
    }
    if (values.some((v) => !TURN_SET.has(v))) return null;
    out.push(values.join(';'));
  }
  return out.join('|');
}

/**
 * `bus:lanes` / `psv:lanes` → one character per lane: `b` when the lane is
 * designated (or reserved: `designated`, `only`) for buses, `-` otherwise
 * (`yes`, `no`, `permissive`, empty: open to other traffic too, or closed to
 * buses). `null` for a value that is neither, or more than 12 lanes.
 */
export function normaliseBusLanes(value: string | undefined): string | null {
  if (value === undefined) return null;
  const lanes = value.split('|');
  if (lanes.length === 0 || lanes.length > 12) return null;
  let out = '';
  for (const lane of lanes) {
    const v = lane.trim().toLowerCase();
    if (v === 'designated' || v === 'only') out += 'b';
    else if (v === '' || v === 'yes' || v === 'no' || v === 'permissive' || v === 'destination') {
      out += '-';
    } else return null;
  }
  return out;
}

/** Merge two per-lane patterns of the same length (bus OR psv designated). */
function mergeBus(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null || a.length !== b.length) return a;
  let out = '';
  for (let i = 0; i < a.length; i++) out += a[i] === 'b' || b[i] === 'b' ? 'b' : '-';
  return out;
}

function count(value: string | undefined): number | null {
  if (value === undefined) return null;
  return /^\d{1,2}$/.test(value.trim()) && Number(value) <= 12 ? Number(value) : null;
}

/**
 * A side from the `<key>`, `<key>:left`, `<key>:right`, `<key>:both` family,
 * for the values `is` accepts. The plain key means both sides (`busway=lane`,
 * `cycleway=lane`, as their wiki pages define them on a two-way road; on a
 * one-way road the renderer reads `both` as the side traffic keeps to).
 */
function sideOf(tags: Tags, key: string, is: (value: string) => boolean): Side | undefined {
  const both = tags[`${key}:both`];
  const left = tags[`${key}:left`];
  const right = tags[`${key}:right`];
  const l = (left !== undefined && is(left)) || (both !== undefined && is(both));
  const r = (right !== undefined && is(right)) || (both !== undefined && is(both));
  if (l && r) return 'both';
  if (l) return 'left';
  if (r) return 'right';
  const plain = tags[key];
  if (plain !== undefined && is(plain)) return 'both';
  return undefined;
}

const PARKING_ON_CARRIAGEWAY = new Set([
  'parallel',
  'diagonal',
  'perpendicular',
  'marked',
  'inline',
  'lane',
]);

const CHANGE: Record<string, string> = { yes: 'y', no: 'n', not_right: 'l', not_left: 'r' };

/**
 * `change:lanes` → one character per lane (`lib/map/cityRoads.ts` →
 * `STREET_PROPS.changeLanes`), or `null` when any lane's value is unknown —
 * one wrong lane would shift every line after it.
 */
export function normaliseChangeLanes(value: string | undefined): string | null {
  if (value === undefined) return null;
  const lanes = value.split('|');
  if (lanes.length < 1 || lanes.length > 12) return null;
  let out = '';
  for (const lane of lanes) {
    const code = CHANGE[lane.trim().toLowerCase()];
    if (!code) return null;
    out += code;
  }
  return out;
}

/** `crossing:markings` values: the documented set, plus `yes` and `no`. */
export const CROSSING_MARKINGS = new Set([
  'yes',
  'no',
  'zebra',
  'lines',
  'ladder',
  'dashes',
  'dots',
  'surface',
  'pictograms',
  'ladder:skewed',
  'ladder:paired',
  'zebra:double',
  'zebra:paired',
  'zebra:bicolour',
  'lines:paired',
  'dashes:paired',
]);

/** `crossing:markings`, lower case, if it is one of {@link CROSSING_MARKINGS}. */
export function normaliseCrossingMarkings(value: string | undefined): string | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  return CROSSING_MARKINGS.has(v) ? v : null;
}

/** `crossing=*` lower case, if it is a single word. */
function crossingValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  return /^[a-z_]{2,24}$/.test(v) ? v : null;
}

/**
 * The street properties of a road way (`car`: whether the road layer kept it
 * as drivable — lane tags are read only there; a footway gets its crossing).
 */
export function streetProperties(tags: Tags, car: boolean, refused?: Refusals): StreetProperties {
  const props: StreetProperties = {};
  const name = tags.name?.trim();
  if (name) {
    if (name.length <= 120) props.name = name;
    else refuse(refused, 'name');
  }
  if (tags.bridge !== undefined && tags.bridge !== 'no') props.bridge = true;
  // A width on any way (a carriageway's is checked against its lanes by the
  // renderer; a cycleway's or a footway's is its own).
  if (tags.width !== undefined) {
    const width = parseLengthM(tags.width);
    if (width !== undefined && width >= 0.5 && width <= 60) props.width = width;
    else refuse(refused, 'width');
  }

  if (!car) {
    if (tags.footway === 'crossing') {
      const crossing = crossingValue(tags.crossing);
      if (crossing) props.crossing = crossing;
      else if (tags.crossing !== undefined) refuse(refused, 'crossing');
      const markings = normaliseCrossingMarkings(tags['crossing:markings']);
      if (markings) props.crossing_markings = markings;
      else if (tags['crossing:markings'] !== undefined) refuse(refused, 'crossing:markings');
    }
    return props;
  }

  for (const [key, prop] of [
    ['turn:lanes', 'turn_lanes'],
    ['turn:lanes:forward', 'turn_lanes_forward'],
    ['turn:lanes:backward', 'turn_lanes_backward'],
  ] as const) {
    if (tags[key] === undefined) continue;
    const turns = normaliseTurnLanes(tags[key]);
    if (turns) props[prop] = turns;
    else refuse(refused, key);
  }

  for (const [key, prop] of [
    ['change:lanes', 'change_lanes'],
    ['change:lanes:forward', 'change_lanes_forward'],
    ['change:lanes:backward', 'change_lanes_backward'],
  ] as const) {
    if (tags[key] === undefined) continue;
    const change = normaliseChangeLanes(tags[key]);
    if (change) props[prop] = change;
    else refuse(refused, key);
  }

  for (const [suffix, prop] of [
    ['', 'bus_lanes'],
    [':forward', 'bus_lanes_forward'],
    [':backward', 'bus_lanes_backward'],
  ] as const) {
    const busKey = `bus:lanes${suffix}`;
    const psvKey = `psv:lanes${suffix}`;
    const bus = normaliseBusLanes(tags[busKey]);
    const psv = normaliseBusLanes(tags[psvKey]);
    if (tags[busKey] !== undefined && bus === null) refuse(refused, busKey);
    if (tags[psvKey] !== undefined && psv === null) refuse(refused, psvKey);
    const merged = mergeBus(bus, psv);
    // A pattern with no designated lane says nothing a painter would draw.
    if (merged?.includes('b')) props[prop] = merged;
  }

  const busway = sideOf(tags, 'busway', (v) => v === 'lane' || v === 'opposite_lane');
  if (busway) props.busway = busway;

  for (const [suffix, prop] of [
    ['', 'lanes_bus'],
    [':forward', 'lanes_bus_forward'],
    [':backward', 'lanes_bus_backward'],
  ] as const) {
    const bus = count(tags[`lanes:bus${suffix}`]);
    const psv = count(tags[`lanes:psv${suffix}`]);
    if (tags[`lanes:bus${suffix}`] !== undefined && bus === null) {
      refuse(refused, `lanes:bus${suffix}`);
    }
    if (tags[`lanes:psv${suffix}`] !== undefined && psv === null) {
      refuse(refused, `lanes:psv${suffix}`);
    }
    const n = Math.max(bus ?? 0, psv ?? 0);
    if (n > 0) props[prop] = n;
  }

  const cycle = sideOf(tags, 'cycleway', (v) => v === 'lane' || v === 'opposite_lane');
  if (cycle) props.cycle_lane = cycle;

  const parkingOld = sideOf(tags, 'parking:lane', (v) => PARKING_ON_CARRIAGEWAY.has(v));
  const parkingNew = sideOf(tags, 'parking', (v) => v === 'lane');
  const parking = parkingOld ?? parkingNew;
  if (parking) props.parking = parking;

  const sidewalkWidth =
    tags['sidewalk:both:width'] ??
    tags['sidewalk:width'] ??
    tags['sidewalk:right:width'] ??
    tags['sidewalk:left:width'];
  if (sidewalkWidth !== undefined) {
    const width = parseLengthM(sidewalkWidth);
    if (width !== undefined && width >= 0.5 && width <= 20) props.sidewalk_width = width;
    else refuse(refused, 'sidewalk:width');
  }
  return props;
}

/** Node street properties: a crossing's markings and reference, a signal's or sign's direction. */
export function streetNodeProperties(
  tags: Tags,
  refused?: Refusals,
): { crossing_markings?: string; crossing_ref?: string; direction?: 'forward' | 'backward' } {
  const out: {
    crossing_markings?: string;
    crossing_ref?: string;
    direction?: 'forward' | 'backward';
  } = {};
  if (tags.highway === 'crossing') {
    const markings = normaliseCrossingMarkings(tags['crossing:markings']);
    if (markings) out.crossing_markings = markings;
    else if (tags['crossing:markings'] !== undefined) refuse(refused, 'crossing:markings');
    const ref = crossingValue(tags.crossing_ref);
    if (ref) out.crossing_ref = ref;
  }
  const direction = (tags['traffic_signals:direction'] ?? tags.direction)?.trim().toLowerCase();
  if (direction === 'forward' || direction === 'backward') out.direction = direction;
  return out;
}
