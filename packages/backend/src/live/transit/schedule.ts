/**
 * An operator's TIMETABLE, reduced to what answers "what leaves the stops near
 * here next": stations, lines, services and every boardable stop time, in
 * typed arrays (`docs/TRANSIT_NEARBY.md`).
 *
 * ## What it holds, and what that costs
 *
 * One row per `stop_times.txt` line that states a time, ~50 bytes each all in
 * (measured with the six enrolled operators resident at once: 3.5 M rows,
 * 177 MB; Renfe's Cercanías alone, 1.85 M rows, ~90 MB; the MTA subway's
 * 565 k rows, ~24 MB). Nothing else scales with the timetable: the trips,
 * routes and stops are tables of a few thousand to a hundred thousand
 * entries. The raw text is dropped as soon as the build ends.
 *
 * ## What it refuses to guess
 *
 * - A `stop_times` row with neither an arrival nor a departure time (a
 *   non-timepoint stop) is dropped, never interpolated: the operator did not
 *   publish a time and GoWay will not invent one.
 * - A feed with `frequencies.txt` rows describes trips as templates ("every
 *   10 minutes"), which this index would serve as ONE departure a day. It is
 *   refused ({@link ScheduleUnsupportedError}) rather than half-served.
 * - A feed with no `agency_timezone` cannot say what "6:05" means and is
 *   refused.
 * - A trip's last stop is not a departure, a row with `pickup_type=1` (no
 *   boarding) is not either.
 *
 * ## Stations, not platforms
 *
 * Stops that name a `parent_station` are answered as that station (one entry,
 * its name and place, the departures of all its platforms) — a reader at a
 * subway station wants the station, not "Times Sq - 42 St, platform N".
 *
 * ## Service days
 *
 * A trip belongs to a service DAY, not a calendar day: its times may pass 24:00
 * ("25:10:00" is ten past one the next morning), and `00:00` of a service day
 * is noon minus twelve hours local time, which differs from midnight on the
 * two daylight-saving days. {@link serviceDays} computes the days a window can
 * touch.
 */

import { gtfsColor, modeOfRouteType, parseCsv } from '../staticGtfs';
import type { TransitMode } from '@goway/contracts';

/** A feed this index cannot serve correctly. */
export class ScheduleUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleUnsupportedError';
  }
}

/** The text files of one GTFS archive the index reads. */
export interface ScheduleFiles {
  agency: string;
  routes: string;
  trips: string;
  stops: string;
  stopTimes: string;
  calendar?: string | undefined;
  calendarDates?: string | undefined;
  /** `frequencies.txt`, only to refuse a feed that uses it. */
  frequencies?: string | undefined;
}

export interface ScheduleRoute {
  id: string;
  shortName: string | null;
  longName: string | null;
  color: string | null;
  textColor: string | null;
  mode: TransitMode;
}

/** One service day a window touches. */
export interface ServiceDay {
  /** Epoch ms of the day's `00:00:00` (noon minus twelve hours, local). */
  startMs: number;
  /** `YYYYMMDD` as a number. */
  key: number;
  /** 0 = Sunday. */
  weekday: number;
}

const DEG = Math.PI / 180;
const EARTH_RADIUS_M = 6_371_008.8;
/** Packing a departure second and a row into one sortable double: `second * 2^32 + row`. */
const ROW_RADIX = 4_294_967_296;

export function distanceMeters(
  latitude: number,
  longitude: number,
  otherLatitude: number,
  otherLongitude: number,
): number {
  const x = (otherLongitude - longitude) * DEG * Math.cos(((latitude + otherLatitude) / 2) * DEG);
  const y = (otherLatitude - latitude) * DEG;
  return Math.hypot(x, y) * EARTH_RADIUS_M;
}

// ---------------------------------------------------------------------------
// Time zones and service days
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    // Throws RangeError for an unknown zone: the caller turns it into a refusal.
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The wall-clock fields `epochMs` has in a zone. */
function localFields(epochMs: number, timeZone: string) {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type in out) out[part.type as keyof typeof out] = Number(part.value);
  }
  return out;
}

/** How far ahead of UTC the zone's clock is at that instant, in ms. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const f = localFields(epochMs, timeZone);
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/** Local noon of a calendar day, as an epoch. */
function localNoonMs(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, 12);
  const first = guess - zoneOffsetMs(guess, timeZone);
  // Once more, at the instant found: the offset may differ across a DST change.
  return guess - zoneOffsetMs(first, timeZone);
}

/**
 * The service days an interval can touch: the local day before the one `nowMs`
 * falls in (a trip running past 24:00), that day, and the next (a window that
 * crosses midnight).
 */
export function serviceDays(nowMs: number, timeZone: string): ServiceDay[] {
  const today = localFields(nowMs, timeZone);
  const days: ServiceDay[] = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    days.push({
      startMs: localNoonMs(year, month, day, timeZone) - 12 * 3600_000,
      key: year * 10_000 + month * 100 + day,
      weekday: date.getUTCDay(),
    });
  }
  return days;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `H:MM:SS` (hours may pass 24) in seconds; `-1` for empty or malformed. */
export function gtfsSeconds(value: string | undefined): number {
  if (!value) return -1;
  const a = value.indexOf(':');
  const b = value.indexOf(':', a + 1);
  if (a < 1 || b < 0) return -1;
  const hours = Number(value.slice(0, a));
  const minutes = Number(value.slice(a + 1, b));
  const seconds = Number(value.slice(b + 1));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds))
    return -1;
  if (hours < 0 || hours > 99 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59)
    return -1;
  return hours * 3600 + minutes * 60 + seconds;
}

/** One CSV line split; the rare quoted line goes through the full parser. */
function splitLine(line: string): string[] {
  if (line.includes('"')) return parseCsv(`h\n${line}`).rows[0] ?? [];
  const fields = line.split(',');
  for (let i = 0; i < fields.length; i++) fields[i] = (fields[i] as string).trim();
  return fields;
}

/** A display string bounded to what the contract accepts; `null` for empty. */
function clip(value: string | undefined, max: number): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function column(header: string[], name: string): number {
  return header.indexOf(name);
}

/** Iterate a CSV's lines without materialising every row. */
function* lines(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    let stop = end;
    if (stop > start && text.charCodeAt(stop - 1) === 13) stop--;
    if (stop > start) yield text.slice(start, stop);
    start = end + 1;
  }
}

function countLines(text: string): number {
  let count = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

interface ServiceRule {
  start: number;
  end: number;
  weekdays: readonly boolean[];
}

/** What everything but the stop times is read into. */
interface Core {
  timeZone: string;
  routes: ScheduleRoute[];
  exceptions: Map<string, boolean>;
  services: ServiceRule[];
  tripIds: Map<string, number>;
  tripRoute: Uint32Array;
  tripService: Uint32Array;
  tripHeadsign: Uint32Array;
  headsigns: string[];
  stopIndex: Map<string, number>;
  stopGroup: Int32Array;
  groupId: string[];
  groupName: string[];
  groupLat: Float64Array;
  groupLon: Float64Array;
}

function readCore(files: ScheduleFiles): Core {
  // Refuse what this index would serve wrongly.
  if (files.frequencies) {
    const frequencyRows = parseCsv(files.frequencies).rows.length;
    if (frequencyRows > 0)
      throw new ScheduleUnsupportedError('frequencies.txt: frequency-based trips are not served');
  }
  const agency = parseCsv(files.agency);
  const zoneColumn = column(agency.header, 'agency_timezone');
  const timeZone = zoneColumn >= 0 ? agency.rows[0]?.[zoneColumn] : undefined;
  if (!timeZone) throw new ScheduleUnsupportedError('agency.txt names no agency_timezone');
  try {
    formatterFor(timeZone);
  } catch {
    throw new ScheduleUnsupportedError('agency.txt names an unknown time zone');
  }

  // Routes.
  const routeIndex = new Map<string, number>();
  const routes: ScheduleRoute[] = [];
  {
    const { header, rows } = parseCsv(files.routes);
    const [id, short, long, rc, tc, rt] = [
      'route_id',
      'route_short_name',
      'route_long_name',
      'route_color',
      'route_text_color',
      'route_type',
    ].map((name) => column(header, name)) as [number, number, number, number, number, number];
    for (const row of rows) {
      const routeId = row[id];
      // Ids ride in the public contract (bounded); a longer one is not a real id.
      if (!routeId || routeId.length > 120 || routeIndex.has(routeId)) continue;
      routeIndex.set(routeId, routes.length);
      routes.push({
        id: routeId,
        shortName: clip(short >= 0 ? row[short] : undefined, 40),
        longName: clip(long >= 0 ? row[long] : undefined, 160),
        color: rc >= 0 ? gtfsColor(row[rc]) : null,
        textColor: tc >= 0 ? gtfsColor(row[tc]) : null,
        mode: (rt >= 0 ? modeOfRouteType(row[rt]) : null) ?? 'other',
      });
    }
  }

  // Services.
  const serviceIds = new Map<string, number>();
  const serviceRules: ServiceRule[] = [];
  const serviceOf = (id: string): number => {
    let index = serviceIds.get(id);
    if (index === undefined) {
      index = serviceRules.length;
      serviceIds.set(id, index);
      serviceRules.push({ start: 1, end: 0, weekdays: [] });
    }
    return index;
  };
  if (files.calendar) {
    const { header, rows } = parseCsv(files.calendar);
    const id = column(header, 'service_id');
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(
      (name) => column(header, name),
    );
    const start = column(header, 'start_date');
    const end = column(header, 'end_date');
    for (const row of rows) {
      const serviceId = row[id];
      if (!serviceId) continue;
      serviceRules[serviceOf(serviceId)] = {
        start: Number(row[start]),
        end: Number(row[end]),
        weekdays: days.map((at) => row[at] === '1'),
      };
    }
  }
  const exceptions = new Map<string, boolean>();
  if (files.calendarDates) {
    const { header, rows } = parseCsv(files.calendarDates);
    const id = column(header, 'service_id');
    const date = column(header, 'date');
    const type = column(header, 'exception_type');
    for (const row of rows) {
      const serviceId = row[id];
      if (!serviceId || (row[type] !== '1' && row[type] !== '2')) continue;
      exceptions.set(`${serviceOf(serviceId)}:${row[date]}`, row[type] === '1');
    }
  }

  // Trips.
  const tripIds = new Map<string, number>();
  const tripRoute: number[] = [];
  const tripService: number[] = [];
  const tripHeadsign: number[] = [];
  const headsigns: string[] = [''];
  const headsignIndex = new Map<string, number>();
  {
    const { header, rows } = parseCsv(files.trips);
    const rid = column(header, 'route_id');
    const sid = column(header, 'service_id');
    const tid = column(header, 'trip_id');
    const hs = column(header, 'trip_headsign');
    for (const row of rows) {
      const route = routeIndex.get(row[rid] ?? '');
      const tripId = row[tid];
      const serviceId = row[sid];
      if (route === undefined || !tripId || !serviceId || tripIds.has(tripId)) continue;
      tripIds.set(tripId, tripRoute.length);
      tripRoute.push(route);
      tripService.push(serviceOf(serviceId));
      const headsign = clip(hs >= 0 ? row[hs] : undefined, 160);
      if (headsign) {
        let at = headsignIndex.get(headsign);
        if (at === undefined) {
          at = headsigns.length;
          headsigns.push(headsign);
          headsignIndex.set(headsign, at);
        }
        tripHeadsign.push(at);
      } else tripHeadsign.push(0);
    }
  }

  // Stops and their stations.
  const stopIndex = new Map<string, number>();
  const stopGroupList: number[] = [];
  const groupId: string[] = [];
  const groupName: string[] = [];
  const groupLat: number[] = [];
  const groupLon: number[] = [];
  {
    const { header, rows } = parseCsv(files.stops);
    const id = column(header, 'stop_id');
    const name = column(header, 'stop_name');
    const lat = column(header, 'stop_lat');
    const lon = column(header, 'stop_lon');
    const type = column(header, 'location_type');
    const parent = column(header, 'parent_station');
    interface RawStop {
      id: string;
      name: string;
      lat: number;
      lon: number;
      parent: string;
      type: number;
    }
    const raw = new Map<string, RawStop>();
    for (const row of rows) {
      const stopId = row[id];
      if (!stopId || stopId.length > 120) continue;
      const latitude = lat >= 0 && row[lat] ? Number(row[lat]) : Number.NaN;
      const longitude = lon >= 0 && row[lon] ? Number(row[lon]) : Number.NaN;
      raw.set(stopId, {
        id: stopId,
        name: clip(name >= 0 ? row[name] : undefined, 160) ?? '',
        lat: latitude,
        lon: longitude,
        parent: (parent >= 0 && row[parent]) || '',
        type: type >= 0 && row[type] ? Number(row[type]) : 0,
      });
    }
    const groupOfKey = new Map<string, number>();
    const validPoint = (s: RawStop) =>
      Number.isFinite(s.lat) &&
      Number.isFinite(s.lon) &&
      Math.abs(s.lat) <= 90 &&
      Math.abs(s.lon) <= 180 &&
      !(s.lat === 0 && s.lon === 0);
    for (const stop of raw.values()) {
      // Entrances, generic nodes and boarding areas are not places to board.
      if (stop.type !== 0 && stop.type !== 1) continue;
      const station = stop.parent ? raw.get(stop.parent) : undefined;
      const head = station && station.type === 1 ? station : stop;
      if (!validPoint(head) || !head.name) {
        stopIndex.set(stop.id, stopGroupList.length);
        stopGroupList.push(-1);
        continue;
      }
      let group = groupOfKey.get(head.id);
      if (group === undefined) {
        group = groupId.length;
        groupOfKey.set(head.id, group);
        groupId.push(head.id);
        groupName.push(head.name);
        groupLat.push(head.lat);
        groupLon.push(head.lon);
      }
      stopIndex.set(stop.id, stopGroupList.length);
      stopGroupList.push(group);
    }
  }
  return {
    timeZone,
    routes,
    exceptions,
    services: serviceRules,
    tripIds,
    tripRoute: Uint32Array.from(tripRoute),
    tripService: Uint32Array.from(tripService),
    tripHeadsign: Uint32Array.from(tripHeadsign),
    headsigns,
    stopIndex,
    stopGroup: Int32Array.from(stopGroupList),
    groupId,
    groupName,
    groupLat: Float64Array.from(groupLat),
    groupLon: Float64Array.from(groupLon),
  };
}

/** The stop times, ordered by trip and sequence. */
interface Rows {
  count: number;
  trip: Uint32Array;
  stop: Int32Array;
  departure: Int32Array;
  flags: Uint8Array;
}

/** Rows parsed between two yields to the event loop. */
const ROWS_PER_SLICE = 50_000;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function readRows(text: string, core: Core, pause: () => Promise<void>): Promise<Rows> {
  const capacity = countLines(text);
  let rTrip = new Uint32Array(capacity);
  const rSeq = new Int32Array(capacity);
  let rStop = new Int32Array(capacity);
  let rDep = new Int32Array(capacity);
  let rFlags = new Uint8Array(capacity);
  let n = 0;
  const iterator = lines(text);
  const head = iterator.next();
  const header = head.done ? [] : splitLine(head.value);
  const tid = column(header, 'trip_id');
  const arrival = column(header, 'arrival_time');
  const departure = column(header, 'departure_time');
  const sid = column(header, 'stop_id');
  const seq = column(header, 'stop_sequence');
  const pickup = column(header, 'pickup_type');
  if (tid < 0 || sid < 0 || seq < 0 || (arrival < 0 && departure < 0))
    throw new ScheduleUnsupportedError('stop_times.txt lacks required columns');
  let sinceYield = 0;
  for (const line of iterator) {
    if (++sinceYield >= ROWS_PER_SLICE) {
      sinceYield = 0;
      await pause();
    }
    const fields = splitLine(line);
    const trip = core.tripIds.get(fields[tid] ?? '');
    const stop = core.stopIndex.get(fields[sid] ?? '');
    if (trip === undefined || stop === undefined) continue;
    const dep = gtfsSeconds(departure >= 0 ? fields[departure] : undefined);
    const arr = gtfsSeconds(arrival >= 0 ? fields[arrival] : undefined);
    const time = dep >= 0 ? dep : arr;
    if (time < 0) continue;
    const sequence = Number(fields[seq]);
    if (!Number.isFinite(sequence)) continue;
    rTrip[n] = trip;
    rSeq[n] = sequence;
    rStop[n] = stop;
    rDep[n] = time;
    rFlags[n] = pickup >= 0 && fields[pickup] === '1' ? 1 : 0;
    n++;
  }
  // Order rows by (trip, sequence); most feeds already are.
  let sorted = true;
  for (let i = 1; i < n; i++) {
    const t0 = rTrip[i - 1] as number;
    const t1 = rTrip[i] as number;
    if (t1 < t0 || (t1 === t0 && (rSeq[i] as number) < (rSeq[i - 1] as number))) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort(
      (a, b) =>
        (rTrip[a] as number) - (rTrip[b] as number) || (rSeq[a] as number) - (rSeq[b] as number),
    );
    const permute = <T extends Uint32Array | Int32Array | Uint8Array>(source: T): T => {
      const out = new (source.constructor as new (length: number) => T)(n);
      for (let i = 0; i < n; i++) out[i] = source[order[i] as number] as number;
      return out;
    };
    rTrip = permute(rTrip);
    rStop = permute(rStop);
    rDep = permute(rDep);
    rFlags = permute(rFlags);
  }
  return {
    count: n,
    trip: rTrip.slice(0, n),
    stop: rStop.slice(0, n),
    departure: rDep.slice(0, n),
    flags: rFlags.slice(0, n),
  };
}

/** One timetable. Immutable once built; safe to query concurrently. */
export class TransitSchedule {
  readonly timeZone: string;
  readonly readAtMs: number;
  /** Rows held: what the memory budget counts. */
  readonly rowCount: number;

  readonly routes: readonly ScheduleRoute[];
  private readonly tripIds: Map<string, number>;
  private readonly tripRoute: Uint32Array;
  private readonly tripService: Uint32Array;
  private readonly tripHeadsign: Uint32Array;
  private readonly tripFirstRow: Int32Array;
  private readonly tripRows: Uint32Array;
  private readonly headsigns: readonly string[];

  private readonly stopIndex: Map<string, number>;
  private readonly stopGroup: Int32Array;

  private readonly groupId: readonly string[];
  private readonly groupName: readonly string[];
  private readonly groupLat: Float64Array;
  private readonly groupLon: Float64Array;
  /** Groups some boardable row calls at. */
  private readonly servedGroups: Int32Array;
  private readonly groupRoutes: readonly Uint32Array[];

  private readonly rowTrip: Uint32Array;
  private readonly rowStop: Int32Array;
  private readonly rowDeparture: Int32Array;
  private readonly rowFlags: Uint8Array;
  /** Per group, the offset of its segment in {@link boardable}. */
  private readonly groupOffset: Uint32Array;
  /** `second * 2^32 + row`, sorted within each group's segment. */
  private readonly boardable: Float64Array;

  private readonly services: readonly ServiceRule[];
  /** Calendar exceptions as `service:date → added (true) | removed (false)`. */
  private readonly exceptions: Map<string, boolean>;

  /** Read a timetable; yields to the event loop while it parses, so a big network does not stall the API. */
  static async build(
    files: ScheduleFiles,
    readAtMs: number,
    pause: () => Promise<void> = yieldToEventLoop,
  ): Promise<TransitSchedule> {
    const core = readCore(files);
    await pause();
    const rows = await readRows(files.stopTimes, core, pause);
    await pause();
    return new TransitSchedule(core, rows, readAtMs);
  }

  private constructor(core: Core, rows: Rows, readAtMs: number) {
    this.readAtMs = readAtMs;
    this.timeZone = core.timeZone;
    this.routes = core.routes;
    this.exceptions = core.exceptions;
    this.services = core.services;
    this.tripIds = core.tripIds;
    this.tripRoute = core.tripRoute;
    this.tripService = core.tripService;
    this.tripHeadsign = core.tripHeadsign;
    this.headsigns = core.headsigns;
    this.stopIndex = core.stopIndex;
    this.stopGroup = core.stopGroup;
    this.groupId = core.groupId;
    this.groupName = core.groupName;
    this.groupLat = core.groupLat;
    this.groupLon = core.groupLon;
    const n = rows.count;
    const tripRoute = core.tripRoute;
    const groupId = core.groupId;
    this.rowCount = n;
    this.rowTrip = rows.trip;
    this.rowStop = rows.stop;
    this.rowDeparture = rows.departure;
    this.rowFlags = rows.flags;

    // Where each trip's rows are.
    const tripCount = tripRoute.length;
    const first = new Int32Array(tripCount).fill(-1);
    const rowsOfTrip = new Uint32Array(tripCount);
    for (let i = 0; i < n; i++) {
      const trip = this.rowTrip[i] as number;
      if (first[trip] === -1) first[trip] = i;
      rowsOfTrip[trip] = (rowsOfTrip[trip] as number) + 1;
    }
    this.tripFirstRow = first;
    this.tripRows = rowsOfTrip;

    // The boardable rows of each station, by departure time.
    const groups = groupId.length;
    const counts = new Uint32Array(groups + 1);
    const isBoardable = (row: number): boolean => {
      if ((this.rowFlags[row] as number) & 1) return false;
      const trip = this.rowTrip[row] as number;
      return row < (this.tripFirstRow[trip] as number) + (this.tripRows[trip] as number) - 1;
    };
    for (let row = 0; row < n; row++) {
      const group = this.stopGroup[this.rowStop[row] as number] as number;
      if (group >= 0 && isBoardable(row)) counts[group + 1] = (counts[group + 1] as number) + 1;
    }
    for (let g = 0; g < groups; g++)
      counts[g + 1] = (counts[g + 1] as number) + (counts[g] as number);
    this.groupOffset = counts;
    const boardable = new Float64Array(counts[groups] as number);
    const cursor = counts.slice(0, groups);
    const routeSets = new Map<number, Set<number>>();
    for (let row = 0; row < n; row++) {
      const group = this.stopGroup[this.rowStop[row] as number] as number;
      if (group < 0 || !isBoardable(row)) continue;
      boardable[cursor[group] as number] = (this.rowDeparture[row] as number) * ROW_RADIX + row;
      cursor[group] = (cursor[group] as number) + 1;
      let set = routeSets.get(group);
      if (!set) {
        set = new Set();
        routeSets.set(group, set);
      }
      set.add(this.tripRoute[this.rowTrip[row] as number] as number);
    }
    const served: number[] = [];
    const groupRoutes: Uint32Array[] = new Array(groups);
    for (let g = 0; g < groups; g++) {
      const set = routeSets.get(g);
      if (!set) {
        groupRoutes[g] = new Uint32Array(0);
        continue;
      }
      served.push(g);
      groupRoutes[g] = Uint32Array.from([...set].sort((a, b) => a - b));
      boardable.subarray(counts[g] as number, counts[g + 1] as number).sort();
    }
    this.boardable = boardable;
    this.servedGroups = Int32Array.from(served);
    this.groupRoutes = groupRoutes;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Stations with at least one departure in their timetable, within a radius of a point, nearest first. */
  stationsNear(
    latitude: number,
    longitude: number,
    radiusMeters: number,
  ): { group: number; distanceMeters: number }[] {
    const dLat = radiusMeters / (DEG * EARTH_RADIUS_M);
    const dLon = dLat / Math.max(0.05, Math.cos(latitude * DEG));
    const found: { group: number; distanceMeters: number }[] = [];
    for (const group of this.servedGroups) {
      const lat = this.groupLat[group] as number;
      const lon = this.groupLon[group] as number;
      if (Math.abs(lat - latitude) > dLat || Math.abs(lon - longitude) > dLon) continue;
      const distance = distanceMeters(latitude, longitude, lat, lon);
      if (distance <= radiusMeters) found.push({ group, distanceMeters: distance });
    }
    return found.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }

  station(group: number) {
    return {
      id: this.groupId[group] as string,
      name: this.groupName[group] as string,
      latitude: this.groupLat[group] as number,
      longitude: this.groupLon[group] as number,
    };
  }

  /** The route indexes calling at a station. */
  routesAt(group: number): Uint32Array {
    return this.groupRoutes[group] as Uint32Array;
  }

  tripIndexOf(tripId: string): number | undefined {
    return this.tripIds.get(tripId);
  }

  stopIndexOf(stopId: string): number | undefined {
    return this.stopIndex.get(stopId);
  }

  /** Whether the service runs on a day. */
  serviceRuns(service: number, day: ServiceDay): boolean {
    const exception = this.exceptions.get(`${service}:${day.key}`);
    if (exception !== undefined) return exception;
    const rule = this.services[service];
    if (!rule) return false;
    return day.key >= rule.start && day.key <= rule.end && rule.weekdays[day.weekday] === true;
  }

  /** The line a trip runs, as an index into {@link routes}. */
  routeOfTrip(trip: number): number {
    return this.tripRoute[trip] as number;
  }

  /**
   * Where a trip is going: its `trip_headsign`, else the station it ends at.
   * `null` when neither is known.
   */
  headsignOf(trip: number): string | null {
    const headsign = this.tripHeadsign[trip] as number;
    if (headsign > 0) return this.headsigns[headsign] as string;
    const rows = this.tripRows[trip] as number;
    if (rows < 2) return null;
    const last = (this.tripFirstRow[trip] as number) + rows - 1;
    const group = this.stopGroup[this.rowStop[last] as number] as number;
    return group >= 0 ? (this.groupName[group] as string) : null;
  }

  /**
   * Timetable departures from a station whose scheduled time falls in
   * `[fromMs, toMs]`, across the given service days, unsorted. `row` addresses
   * the stop time, for the realtime join.
   */
  scheduledDepartures(
    group: number,
    days: readonly ServiceDay[],
    fromMs: number,
    toMs: number,
    cap: number,
  ): ScheduledDeparture[] {
    const out: ScheduledDeparture[] = [];
    const start = this.groupOffset[group] as number;
    const end = this.groupOffset[group + 1] as number;
    if (start === end) return out;
    const segment = this.boardable.subarray(start, end);
    for (const day of days) {
      const low = Math.ceil((fromMs - day.startMs) / 1000);
      const high = Math.floor((toMs - day.startMs) / 1000);
      if (high < 0) continue;
      // First entry at or after `low`.
      const key = Math.max(0, low) * ROW_RADIX;
      let lo = 0;
      let hi = segment.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((segment[mid] as number) < key) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < segment.length; i++) {
        const packed = segment[i] as number;
        const second = Math.floor(packed / ROW_RADIX);
        if (second > high) break;
        const row = packed - second * ROW_RADIX;
        const trip = this.rowTrip[row] as number;
        if (!this.serviceRuns(this.tripService[trip] as number, day)) continue;
        out.push({ row, trip, dayStartMs: day.startMs, timeMs: day.startMs + second * 1000 });
        if (out.length >= cap) return out;
      }
    }
    return out;
  }

  /** Position of a stop time within its trip (0 = first). */
  positionInTrip(row: number): number {
    return row - (this.tripFirstRow[this.rowTrip[row] as number] as number);
  }

  /** The rows of a trip: its first row and how many. */
  tripSpan(trip: number): { first: number; count: number } {
    return { first: this.tripFirstRow[trip] as number, count: this.tripRows[trip] as number };
  }

  stopOfRow(row: number): number {
    return this.rowStop[row] as number;
  }

  secondsOfRow(row: number): number {
    return this.rowDeparture[row] as number;
  }

  /** The service a trip runs on. */
  serviceOfTrip(trip: number): number {
    return this.tripService[trip] as number;
  }
}

export interface ScheduledDeparture {
  row: number;
  trip: number;
  dayStartMs: number;
  timeMs: number;
}
