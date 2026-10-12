/**
 * An operator's STATIC GTFS, reduced to what puts a live vehicle on its
 * track: each route's colour and short name, each trip's route and shape, and
 * the shapes themselves as polylines with their running length.
 *
 * ## Snapping is a display aid, and the data is not changed
 *
 * A vehicle's reported position is re-served exactly as the operator
 * reported it (`LiveEntity.position`; the MTA's terms forbid modifying their
 * data, and GoWay would not anyway). What this adds is a separate statement:
 * "this report is {@link SNAP_TOLERANCE_METERS} or less from that operator's
 * own published shape, at this distance along it" (`track`) — which the map
 * uses to draw the vehicle ON the line and move it ALONG the line between
 * reports instead of across a curve. A report farther than the tolerance from
 * every candidate shape gets `trackStatus: 'off_track'`, and the map shows it
 * where it was reported, marked approximate, never animated along a path
 * nobody published.
 *
 * Which shape: the trip's own when the realtime trip id is in `trips.txt`
 * (Renfe, FGC, MTA); otherwise every shape of the vehicle's route, nearest
 * first, preferring the one whose distance-along kept increasing since the
 * last report (a route's two directional shapes overlap exactly).
 */

import type { LiveTransitVehicle } from '@goway/contracts';
import { readZipEntries, ZipError } from './zip';

/** How far from its operator's shape a report may be and still be drawn on it. */
export const SNAP_TOLERANCE_METERS = 75;

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export interface GtfsShape {
  id: string;
  lat: Float64Array;
  lon: Float64Array;
  /** Running length at each point, metres. */
  along: Float64Array;
  length: number;
  bbox: [number, number, number, number];
}

export interface GtfsRoute {
  shortName: string | null;
  /** `route_long_name`, for operators with no short name (LIRR's "Babylon Branch"). */
  longName: string | null;
  /** `#RRGGBB`, or `null` when the feed gives none. */
  color: string | null;
  textColor: string | null;
}

export interface StaticGtfs {
  routes: Map<string, GtfsRoute>;
  trips: Map<string, { routeId: string; shapeId: string | null }>;
  shapes: Map<string, GtfsShape>;
  /** Shape ids per route id and per route short name (`S1`, `R2N`). */
  shapesByRoute: Map<string, Set<string>>;
  /** Stop positions, for estimating a vehicle between stops (`stops.txt`, when present). */
  stops: Map<string, { latitude: number; longitude: number }>;
}

/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, trimmed values (Renfe pads). */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field.trim());
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }
  const header = (rows.shift() ?? []).map((name) => name.replace(/^﻿/, ''));
  return { header, rows };
}

function columns(header: string[], names: readonly string[]): number[] {
  return names.map((name) => header.indexOf(name));
}

const HEX = /^[0-9A-Fa-f]{6}$/;
const color = (value: string | undefined) =>
  value && HEX.test(value) ? `#${value.toUpperCase()}` : null;

export function buildStaticGtfs(files: {
  routes: string;
  trips: string;
  shapes: string;
  stops?: string;
}): StaticGtfs {
  const routes = new Map<string, GtfsRoute>();
  {
    const { header, rows } = parseCsv(files.routes);
    const [id, short, long, rc, tc] = columns(header, [
      'route_id',
      'route_short_name',
      'route_long_name',
      'route_color',
      'route_text_color',
    ]);
    for (const row of rows) {
      const routeId = row[id];
      if (!routeId) continue;
      routes.set(routeId, {
        shortName: row[short] || null,
        longName: row[long] || null,
        color: color(row[rc]),
        textColor: color(row[tc]),
      });
    }
  }

  const points = new Map<string, [number, number, number][]>();
  {
    const { header, rows } = parseCsv(files.shapes);
    const [id, la, lo, seq] = columns(header, [
      'shape_id',
      'shape_pt_lat',
      'shape_pt_lon',
      'shape_pt_sequence',
    ]);
    for (const row of rows) {
      const shapeId = row[id];
      const lat = Number(row[la]);
      const lon = Number(row[lo]);
      const order = Number(row[seq]);
      if (!shapeId || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
        continue;
      let list = points.get(shapeId);
      if (!list) {
        list = [];
        points.set(shapeId, list);
      }
      list.push([order, lat, lon]);
    }
  }
  const shapes = new Map<string, GtfsShape>();
  for (const [shapeId, list] of points) {
    list.sort((a, b) => a[0] - b[0]);
    if (list.length < 2) continue;
    shapes.set(
      shapeId,
      makeShape(
        shapeId,
        list.map(([, lat, lon]) => [lat, lon]),
      ),
    );
  }

  const trips = new Map<string, { routeId: string; shapeId: string | null }>();
  const shapesByRoute = new Map<string, Set<string>>();
  {
    const { header, rows } = parseCsv(files.trips);
    const [rid, tid, sid, tsn] = columns(header, [
      'route_id',
      'trip_id',
      'shape_id',
      'trip_short_name',
    ]);
    for (const row of rows) {
      const routeId = row[rid];
      const tripId = row[tid];
      if (!routeId || !tripId) continue;
      const shapeId = sid >= 0 && row[sid] && shapes.has(row[sid]) ? row[sid] : null;
      trips.set(tripId, { routeId, shapeId });
      // Some realtime feeds name a trip by its public train number
      // (Metro-North): index that too, as `#<number>`.
      const shortName = tsn >= 0 ? row[tsn] : undefined;
      if (shortName && !trips.has(`#${shortName}`))
        trips.set(`#${shortName}`, { routeId, shapeId });
      if (!shapeId) continue;
      for (const key of [routeId, routes.get(routeId)?.shortName]) {
        if (!key) continue;
        let set = shapesByRoute.get(key);
        if (!set) {
          set = new Set();
          shapesByRoute.set(key, set);
        }
        set.add(shapeId);
      }
    }
  }
  const stops = new Map<string, { latitude: number; longitude: number }>();
  if (files.stops) {
    const { header, rows } = parseCsv(files.stops);
    const [id, la, lo] = columns(header, ['stop_id', 'stop_lat', 'stop_lon']);
    for (const row of rows) {
      const latitude = Number(row[la]);
      const longitude = Number(row[lo]);
      if (row[id] && Number.isFinite(latitude) && Number.isFinite(longitude)) {
        stops.set(row[id] as string, { latitude, longitude });
      }
    }
  }
  return { routes, trips, shapes, shapesByRoute, stops };
}

export function makeShape(id: string, latLon: readonly (readonly [number, number])[]): GtfsShape {
  const n = latLon.length;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const along = new Float64Array(n);
  let w = 180;
  let s = 90;
  let e = -180;
  let north = -90;
  for (let i = 0; i < n; i++) {
    const [la, lo] = latLon[i] as readonly [number, number];
    lat[i] = la;
    lon[i] = lo;
    if (i > 0)
      along[i] =
        (along[i - 1] as number) + metres(lat[i - 1] as number, lon[i - 1] as number, la, lo);
    w = Math.min(w, lo);
    e = Math.max(e, lo);
    s = Math.min(s, la);
    north = Math.max(north, la);
  }
  return { id, lat, lon, along, length: along[n - 1] as number, bbox: [w, s, e, north] };
}

function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * DEG * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = (lat2 - lat1) * DEG;
  return Math.hypot(x, y) * EARTH_RADIUS_M;
}

export interface Projection {
  /** Metres along the shape to the nearest point. */
  along: number;
  /** Metres from the report to that point. */
  offset: number;
}

/** The nearest point of a shape to a position (equirectangular, fine at street scale). */
export function project(shape: GtfsShape, latitude: number, longitude: number): Projection {
  const kx = Math.cos(latitude * DEG) * DEG * EARTH_RADIUS_M;
  const ky = DEG * EARTH_RADIUS_M;
  let best = { along: 0, offset: Number.POSITIVE_INFINITY };
  for (let i = 0; i + 1 < shape.lat.length; i++) {
    const ax = ((shape.lon[i] as number) - longitude) * kx;
    const ay = ((shape.lat[i] as number) - latitude) * ky;
    const bx = ((shape.lon[i + 1] as number) - longitude) * kx;
    const by = ((shape.lat[i + 1] as number) - latitude) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d = Math.hypot(px, py);
    if (d < best.offset) {
      const segment = (shape.along[i + 1] as number) - (shape.along[i] as number);
      best = { along: (shape.along[i] as number) + segment * t, offset: d };
    }
  }
  return best;
}

function nearBox(shape: GtfsShape, latitude: number, longitude: number, marginM: number): boolean {
  const dLat = marginM / (DEG * EARTH_RADIUS_M);
  const dLon = dLat / Math.max(0.05, Math.cos(latitude * DEG));
  const [w, s, e, n] = shape.bbox;
  return (
    longitude >= w - dLon && longitude <= e + dLon && latitude >= s - dLat && latitude <= n + dLat
  );
}

/**
 * A realtime trip id in the static GTFS: as is; without a trailing `_<n>`
 * (LIRR suffixes its realtime ids); or as a public train number (`#3514`,
 * Metro-North).
 */
export function findTrip(gtfs: StaticGtfs, tripId: string) {
  return (
    gtfs.trips.get(tripId) ??
    gtfs.trips.get(tripId.replace(/_\d+$/, '')) ??
    gtfs.trips.get(`#${tripId}`)
  );
}

export interface MatchHint {
  tripId?: string;
  /** A route id or short name to look shapes up by when the trip is unknown. */
  route?: string;
}

/** What a previous report matched, to tell a route's two directions apart. */
export interface PreviousMatch {
  shapeId: string;
  along: number;
}

export interface TrackMatch {
  route: GtfsRoute | null;
  track: { shapeId: string; alongMeters: number; offsetMeters: number } | null;
  trackStatus: LiveTransitVehicle['trackStatus'];
}

export function matchTrack(
  gtfs: StaticGtfs,
  hint: MatchHint,
  position: { latitude: number; longitude: number },
  previous: PreviousMatch | null,
): TrackMatch {
  const trip = hint.tripId ? findTrip(gtfs, hint.tripId) : undefined;
  const route = trip ? (gtfs.routes.get(trip.routeId) ?? null) : null;
  let candidates: string[] = [];
  if (trip?.shapeId) candidates = [trip.shapeId];
  else {
    const set =
      (hint.route ? gtfs.shapesByRoute.get(hint.route) : undefined) ??
      (trip ? gtfs.shapesByRoute.get(trip.routeId) : undefined);
    candidates = set ? [...set] : [];
  }
  const routeByHint =
    route ??
    (hint.route
      ? ([...gtfs.routes.values()].find((r) => r.shortName === hint.route) ??
        gtfs.routes.get(hint.route) ??
        null)
      : null);
  if (candidates.length === 0) return { route: routeByHint, track: null, trackStatus: 'unknown' };

  let best: { shapeId: string; projection: Projection; score: number } | null = null;
  for (const shapeId of candidates) {
    const shape = gtfs.shapes.get(shapeId);
    if (!shape || !nearBox(shape, position.latitude, position.longitude, SNAP_TOLERANCE_METERS))
      continue;
    const projection = project(shape, position.latitude, position.longitude);
    if (projection.offset > SNAP_TOLERANCE_METERS) continue;
    // Equal geometry, opposite directions: keep the one this vehicle has been
    // moving forward along; a step backwards costs it the tie.
    let score = projection.offset;
    if (previous && previous.shapeId === shapeId)
      score -= projection.along >= previous.along - 20 ? 5 : -5;
    if (!best || score < best.score) best = { shapeId, projection, score };
  }
  if (!best) return { route: routeByHint, track: null, trackStatus: 'off_track' };
  return {
    route: routeByHint,
    track: {
      shapeId: best.shapeId,
      alongMeters: Math.round(best.projection.along * 10) / 10,
      offsetMeters: Math.round(best.projection.offset * 10) / 10,
    },
    trackStatus: 'on_track',
  };
}

/** Where an operator's static GTFS is: one zip, or the three files separately (FGC's portal). */
export type StaticGtfsLocation =
  | { zip: string }
  | { routes: string; trips: string; shapes: string }
  /** Several zips merged (MTA buses publish one per borough). */
  | { zips: readonly string[] };

const FILES = ['routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt'] as const;
const NO_SHAPES = 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n';

/** Fetch and build an operator's static GTFS. Throws on a missing file. */
export async function loadStaticGtfs(
  location: StaticGtfsLocation,
  read: (url: string) => Promise<Uint8Array>,
): Promise<StaticGtfs> {
  const decoder = new TextDecoder();
  const parts: { routes: string; trips: string; shapes: string; stops?: string }[] = [];
  const zips = 'zip' in location ? [location.zip] : 'zips' in location ? location.zips : [];
  for (const url of zips) {
    const entries = readZipEntries(await read(url), FILES);
    const text = (name: (typeof FILES)[number]) => {
      const bytes = entries.get(name);
      if (!bytes) throw new ZipError(`${name} missing from ${url}`);
      return decoder.decode(bytes);
    };
    const stops = entries.get('stops.txt');
    // Shapes are optional in GTFS (Renfe's long-distance file has none): its
    // routes still name the lines; its vehicles are drawn where reported.
    const shapes = entries.get('shapes.txt');
    parts.push({
      routes: text('routes.txt'),
      trips: text('trips.txt'),
      shapes: shapes ? decoder.decode(shapes) : NO_SHAPES,
      ...(stops ? { stops: decoder.decode(stops) } : {}),
    });
  }
  if ('routes' in location) {
    parts.push({
      routes: decoder.decode(await read(location.routes)),
      trips: decoder.decode(await read(location.trips)),
      shapes: decoder.decode(await read(location.shapes)),
    });
  }
  const built = parts.map(buildStaticGtfs);
  if (built.length === 1) return built[0] as StaticGtfs;
  const merged: StaticGtfs = {
    routes: new Map(),
    trips: new Map(),
    shapes: new Map(),
    shapesByRoute: new Map(),
    stops: new Map(),
  };
  for (const gtfs of built) {
    for (const [k, v] of gtfs.routes) merged.routes.set(k, v);
    for (const [k, v] of gtfs.trips) merged.trips.set(k, v);
    for (const [k, v] of gtfs.shapes) merged.shapes.set(k, v);
    for (const [k, v] of gtfs.stops) merged.stops.set(k, v);
    for (const [k, v] of gtfs.shapesByRoute) {
      const set = merged.shapesByRoute.get(k) ?? new Set<string>();
      for (const id of v) set.add(id);
      merged.shapesByRoute.set(k, set);
    }
  }
  return merged;
}

/** The point `along` metres along a shape (clamped). */
export function pointOnShape(
  shape: GtfsShape,
  along: number,
): { latitude: number; longitude: number } {
  const s = Math.max(0, Math.min(shape.length, along));
  let lo = 0;
  let hi = shape.along.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((shape.along[mid] as number) <= s) lo = mid;
    else hi = mid - 1;
  }
  const a0 = shape.along[lo] as number;
  const a1 = shape.along[lo + 1] as number;
  const t = a1 > a0 ? (s - a0) / (a1 - a0) : 0;
  return {
    latitude:
      (shape.lat[lo] as number) + ((shape.lat[lo + 1] as number) - (shape.lat[lo] as number)) * t,
    longitude:
      (shape.lon[lo] as number) + ((shape.lon[lo + 1] as number) - (shape.lon[lo] as number)) * t,
  };
}
