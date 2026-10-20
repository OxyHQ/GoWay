/**
 * `GET /transit/nearby`'s engine: which licensed operators cover a point, their
 * timetables (read on first use and kept in bounded memory), their live
 * predictions (fetched on demand, cached for the feed's own interval) and the
 * answer assembled from them. Design and costs: `docs/TRANSIT_NEARBY.md`.
 *
 * ## What is served
 *
 * Only the sources the deployment configured (`LIVE_SOURCES`), that enrol in
 * departures in the catalogue (`LiveSourceDefinition.departures`) and whose
 * entry carries a read licence ({@link isServable}). A source `awaiting` a
 * permission or still missing its key is not configured, so it is not here.
 *
 * ## What is never kept or written
 *
 * The requested position lives in the call's arguments and nowhere else: no
 * cache is keyed by it, nothing logs it, and the only log lines name an
 * operator and a reason.
 */

import type {
  NearbyTransit,
  NearbyTransitQuery,
  TransitDeparture,
  TransitLine,
  TransitMode,
  TransitOperator,
  TransitStop,
} from '@goway/contracts';
import { nearbyTransitQuerySchema } from '@goway/contracts';
import { GTFS_REALTIME_ACCEPT } from '../adapters/gtfsRealtime';
import type { LiveHubLogger, LiveHubSource } from '../hub';
import { getBytes } from '../normalise';
import { decodeGtfsRealtime } from '../protobuf';
import type { LiveFetch, LiveSourceDefinition } from '../types';
import { readZipEntries } from '../zip';
import { applyRealtime, joinRealtime, type TripRealtime } from './realtime';
import { ScheduleUnsupportedError, serviceDays, TransitSchedule } from './schedule';

/** A timetable is re-read this often while it is used (operators republish about daily). */
export const SCHEDULE_REFRESH_MS = 24 * 3600_000;
/** A timetable nobody asked about for this long is let go. */
export const SCHEDULE_IDLE_MS = 2 * 3600_000;
/** The most stop-time rows held across every operator (~50 B each, so ~200 MB); the least recently used are let go past it. */
export const MAX_RESIDENT_ROWS = 4_000_000;
/** The largest archive downloaded. */
export const MAX_SCHEDULE_ZIP_BYTES = 120 * 1024 * 1024;
/** How long a request waits for a timetable that is not loaded yet before answering `preparing`. */
export const LOAD_WAIT_MS = 8_000;
/** How long a request waits for a prediction feed before answering with timetable times. */
export const REALTIME_WAIT_MS = 3_000;
/** Predictions older than this (by the feed's own header) are not applied. */
export const REALTIME_MAX_AGE_MS = 5 * 60_000;
/** A prediction feed is not asked more often than this, whatever its catalogue interval. */
export const MIN_REALTIME_INTERVAL_MS = 30_000;
/** How far ahead departures are looked up. */
export const DEPARTURE_WINDOW_MS = 6 * 3600_000;
/** A timetable departure this far in the past can still be a delayed one still to come. */
const LOOKBACK_MS = 15 * 60_000;
/** Candidates examined per station: the cap on a very busy hub's six hours. */
const CANDIDATE_CAP = 3000;
/** Lines listed per stop. */
const MAX_LINES = 24;

const FILES = [
  'agency.txt',
  'routes.txt',
  'trips.txt',
  'stops.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'frequencies.txt',
] as const;

/**
 * Whether a source may be re-served as stops and departures: the licence as
 * READ (a day and the words that allow public, commercial redistribution), an
 * https licence and credit to show, and a whole-archive static GTFS to read
 * the timetable from. This repeats, at the point of serving, what
 * `licence.test.ts` holds the catalogue to.
 */
export function isServable(definition: LiveSourceDefinition): boolean {
  if (!definition.departures || definition.kind !== 'transit') return false;
  const check = definition.licenceCheck;
  if (!check.verifiedOn || !check.quote.trim() || !/^https:\/\//.test(check.source)) return false;
  if (!/^https:\/\//.test(definition.licence.href) || !definition.licence.label) return false;
  if (!/^https:\/\//.test(definition.attribution.href) || !definition.attribution.label)
    return false;
  return archivesOf(definition).length > 0;
}

/** The static archives to read the timetable from; none for a location this index cannot read. */
export function archivesOf(definition: LiveSourceDefinition): string[] {
  const location = definition.staticGtfs;
  if (!location) return [];
  if ('zip' in location) return location.only ? [] : [location.zip];
  if ('zips' in location) return [...location.zips];
  return [];
}

interface RealtimeState {
  urls: string[];
  /** By schedule, trip index → predictions. */
  joined: Map<number, TripRealtime>[];
  /** The schedules `joined` was built against. */
  builtFor: readonly TransitSchedule[] | null;
  fetchedAt: number;
  /** The feed's own timestamp (ms). */
  headerAt: number | null;
  lastTripUpdates: ReturnType<typeof decodeGtfsRealtime>['tripUpdates'];
  inFlight: Promise<void> | null;
  /** The last fetch failed (or none has succeeded yet). */
  failing: boolean;
}

interface OperatorState {
  source: LiveHubSource;
  schedules: readonly TransitSchedule[] | null;
  readAt: number | null;
  loading: Promise<void> | null;
  failures: number;
  nextAttemptAt: number;
  lastUsedAt: number;
  realtime: RealtimeState | null;
}

export interface TransitServiceOptions {
  sources: readonly LiveHubSource[];
  fetch: LiveFetch;
  now?: () => number;
  logger?: LiveHubLogger;
  /** How long a request waits for a timetable still loading (default {@link LOAD_WAIT_MS}). */
  loadWaitMs?: number;
  /** The row budget across operators (default {@link MAX_RESIDENT_ROWS}). */
  maxResidentRows?: number;
  /** Test seam: where a schedule comes from. Default: download and read the archives. */
  loadSchedules?: (
    source: LiveHubSource,
    archives: readonly string[],
    signal: AbortSignal,
  ) => Promise<TransitSchedule[]>;
}

const round = (value: number) => Math.round(value);

export class TransitService {
  private readonly states: OperatorState[];
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: TransitServiceOptions) {
    this.now = options.now ?? Date.now;
    this.states = options.sources
      .filter((source) => isServable(source.definition))
      .map((source) => ({
        source,
        schedules: null,
        readAt: null,
        loading: null,
        failures: 0,
        nextAttemptAt: 0,
        lastUsedAt: 0,
        realtime: null,
      }));
  }

  /** The ids of the operators this deployment serves. */
  operatorIds(): string[] {
    return this.states.map((state) => state.source.definition.id);
  }

  /** Release idle timetables on a timer. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 10 * 60_000);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Stop-time rows held now. */
  residentRows(): number {
    let rows = 0;
    for (const state of this.states)
      for (const schedule of state.schedules ?? []) rows += schedule.rowCount;
    return rows;
  }

  async nearby(rawQuery: NearbyTransitQuery): Promise<NearbyTransit> {
    const query = nearbyTransitQuerySchema.parse(rawQuery);
    const { latitude, longitude, radiusMeters, maxStops, maxDepartures } = query;
    const nowMs = this.now();
    this.sweep();

    const covering = this.states.filter((state) =>
      covers(state.source.definition, latitude, longitude, radiusMeters),
    );
    const prepared = await Promise.all(covering.map((state) => this.prepare(state, nowMs)));

    const operators: TransitOperator[] = [];
    const candidates: {
      state: OperatorState;
      schedule: TransitSchedule;
      scheduleIndex: number;
      group: number;
      distanceMeters: number;
    }[] = [];
    for (const [i, state] of covering.entries()) {
      const { definition } = state.source;
      const schedules = prepared[i] ?? null;
      operators.push({
        id: definition.id,
        name: definition.name,
        attribution: definition.attribution,
        licence: definition.licence,
        availability: schedules
          ? 'ready'
          : state.failures >= 3 && !state.loading
            ? 'unavailable'
            : 'preparing',
        realtime: realtimeStatus(state, nowMs),
        scheduleReadAt: state.readAt === null ? null : new Date(state.readAt).toISOString(),
        realtimeAt:
          state.realtime && realtimeStatus(state, nowMs) === 'live' && state.realtime.headerAt
            ? new Date(state.realtime.headerAt).toISOString()
            : null,
      });
      if (!schedules) continue;
      state.lastUsedAt = nowMs;
      for (const [scheduleIndex, schedule] of schedules.entries()) {
        for (const near of schedule.stationsNear(latitude, longitude, radiusMeters)) {
          candidates.push({ state, schedule, scheduleIndex, ...near });
        }
      }
    }
    candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);

    const days = new Map<string, ReturnType<typeof serviceDays>>();
    const stops: TransitStop[] = [];
    for (const candidate of candidates.slice(0, maxStops)) {
      const { state, schedule, scheduleIndex, group } = candidate;
      const { definition } = state.source;
      const station = schedule.station(group);
      let scheduleDays = days.get(schedule.timeZone);
      if (!scheduleDays) {
        scheduleDays = serviceDays(nowMs, schedule.timeZone);
        days.set(schedule.timeZone, scheduleDays);
      }
      const realtimeTrips = state.realtime?.joined[scheduleIndex];
      const useRealtime = realtimeStatus(state, nowMs) === 'live';

      const raw = schedule.scheduledDepartures(
        group,
        scheduleDays,
        nowMs - LOOKBACK_MS,
        nowMs + DEPARTURE_WINDOW_MS,
        CANDIDATE_CAP,
      );
      const timed: { timeMs: number; departure: TransitDeparture; route: number }[] = [];
      for (const entry of raw) {
        const verdict = useRealtime
          ? applyRealtime(schedule, entry, realtimeTrips?.get(entry.trip))
          : null;
        if (verdict === 'drop') continue;
        const timeMs = verdict ? verdict.timeMs : entry.timeMs;
        if (timeMs < nowMs) continue;
        const route = schedule.routeOfTrip(entry.trip);
        const base = {
          lineId: lineId(schedule, route),
          headsign: schedule.headsignOf(entry.trip),
          time: new Date(timeMs).toISOString(),
        };
        timed.push({
          timeMs,
          route,
          departure: verdict
            ? { ...base, basis: 'realtime', delaySeconds: verdict.delaySeconds }
            : { ...base, basis: 'scheduled' },
        });
      }
      timed.sort((a, b) => a.timeMs - b.timeMs);
      const due = timed.slice(0, maxDepartures);

      // Lines: every route calling here, the ones with a departure first so the
      // departures always have their line.
      const routeIndexes: number[] = [];
      const seen = new Set<number>();
      for (const item of due) {
        if (!seen.has(item.route)) {
          seen.add(item.route);
          routeIndexes.push(item.route);
        }
      }
      for (const route of schedule.routesAt(group)) {
        if (routeIndexes.length >= MAX_LINES) break;
        if (!seen.has(route)) {
          seen.add(route);
          routeIndexes.push(route);
        }
      }
      routeIndexes.sort((a, b) => a - b);
      const lines: TransitLine[] = routeIndexes.map((route) => {
        const r = schedule.routes[route] as (typeof schedule.routes)[number];
        return {
          id: lineId(schedule, route),
          shortName: r.shortName,
          longName: r.longName,
          mode: r.mode,
          color: r.color,
          textColor: r.textColor,
        };
      });
      stops.push({
        id: `${definition.id}:${station.id}`,
        operatorId: definition.id,
        name: station.name,
        position: { latitude: station.latitude, longitude: station.longitude },
        distanceMeters: round(candidate.distanceMeters),
        modes: modesOf(schedule, schedule.routesAt(group)),
        lines,
        departures: due.map((item) => item.departure),
      });
    }
    return { stops, operators, generatedAt: new Date(nowMs).toISOString() };
  }

  // -------------------------------------------------------------------------
  // Timetables
  // -------------------------------------------------------------------------

  /** The operator's timetables and fresh predictions, or `null` while the timetable is not ready. */
  private async prepare(
    state: OperatorState,
    nowMs: number,
  ): Promise<readonly TransitSchedule[] | null> {
    state.lastUsedAt = nowMs;
    const stale = state.schedules && nowMs - (state.readAt ?? 0) > SCHEDULE_REFRESH_MS;
    if ((!state.schedules || stale) && !state.loading && nowMs >= state.nextAttemptAt) {
      this.load(state);
    }
    if (!state.schedules && state.loading) {
      await within(state.loading, this.options.loadWaitMs ?? LOAD_WAIT_MS);
    }
    const schedules = state.schedules;
    if (!schedules) return null;
    await this.refreshRealtime(state, schedules, nowMs);
    return schedules;
  }

  private load(state: OperatorState): void {
    const { definition } = state.source;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 180_000);
    const archives = archivesOf(definition);
    const loader = this.options.loadSchedules ?? ((s, a, signal) => this.download(s, a, signal));
    state.loading = loader(state.source, archives, abort.signal)
      .then(
        (schedules) => {
          state.schedules = schedules;
          state.readAt = this.now();
          state.failures = 0;
          state.nextAttemptAt = 0;
          // A rebuilt timetable invalidates what was joined to the old one.
          if (state.realtime) state.realtime.builtFor = null;
          this.options.logger?.info(
            {
              source: definition.id,
              rows: schedules.reduce((sum, schedule) => sum + schedule.rowCount, 0),
            },
            'Transit timetable loaded',
          );
          this.enforceBudget(state);
        },
        (error: unknown) => {
          state.failures++;
          state.nextAttemptAt = this.now() + Math.min(3600_000, 60_000 * 2 ** state.failures);
          this.options.logger?.warn(
            {
              source: definition.id,
              failures: state.failures,
              reason: error instanceof ScheduleUnsupportedError ? error.message : describe(error),
            },
            'Transit timetable failed to load',
          );
        },
      )
      .finally(() => {
        clearTimeout(timer);
        state.loading = null;
      });
  }

  private async download(
    source: LiveHubSource,
    archives: readonly string[],
    signal: AbortSignal,
  ): Promise<TransitSchedule[]> {
    const decoder = new TextDecoder();
    const schedules: TransitSchedule[] = [];
    for (const url of archives) {
      const bytes = await getBytes(
        this.options.fetch,
        url,
        signal,
        { 'user-agent': source.settings.userAgent },
        MAX_SCHEDULE_ZIP_BYTES,
      );
      const entries = readZipEntries(bytes, FILES);
      const text = (name: (typeof FILES)[number]) => {
        const entry = entries.get(name);
        return entry ? decoder.decode(entry) : undefined;
      };
      const required = (name: (typeof FILES)[number]) => {
        const value = text(name);
        if (value === undefined) throw new ScheduleUnsupportedError(`${name} is missing`);
        return value;
      };
      schedules.push(
        await TransitSchedule.build(
          {
            agency: required('agency.txt'),
            routes: required('routes.txt'),
            trips: required('trips.txt'),
            stops: required('stops.txt'),
            stopTimes: required('stop_times.txt'),
            calendar: text('calendar.txt'),
            calendarDates: text('calendar_dates.txt'),
            frequencies: text('frequencies.txt'),
          },
          this.now(),
        ),
      );
    }
    return schedules;
  }

  /** Let the least recently used timetables go while more rows than the budget are held. */
  private enforceBudget(keep: OperatorState): void {
    while (this.residentRows() > (this.options.maxResidentRows ?? MAX_RESIDENT_ROWS)) {
      const victim = this.states
        .filter((state) => state !== keep && state.schedules)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!victim) return;
      this.release(victim);
    }
  }

  private release(state: OperatorState): void {
    state.schedules = null;
    state.readAt = null;
    state.realtime = null;
  }

  private sweep(): void {
    const nowMs = this.now();
    for (const state of this.states) {
      if (state.schedules && !state.loading && nowMs - state.lastUsedAt > SCHEDULE_IDLE_MS)
        this.release(state);
    }
  }

  // -------------------------------------------------------------------------
  // Predictions
  // -------------------------------------------------------------------------

  private async refreshRealtime(
    state: OperatorState,
    schedules: readonly TransitSchedule[],
    nowMs: number,
  ): Promise<void> {
    const { definition, settings } = state.source;
    const urls = definition.departures?.realtimeUrls?.(settings) ?? [];
    if (urls.length === 0) return;
    state.realtime ??= {
      urls: [...urls],
      joined: [],
      builtFor: null,
      fetchedAt: 0,
      headerAt: null,
      lastTripUpdates: [],
      inFlight: null,
      failing: true,
    };
    const realtime = state.realtime;
    const interval = Math.max(MIN_REALTIME_INTERVAL_MS, definition.pollIntervalSeconds * 1000);
    if (!realtime.inFlight && nowMs - realtime.fetchedAt >= interval) {
      realtime.fetchedAt = nowMs;
      realtime.inFlight = this.fetchRealtime(state, realtime)
        .catch((error: unknown) => {
          realtime.failing = true;
          this.options.logger?.warn(
            { source: definition.id, reason: describe(error) },
            'Transit predictions failed to load',
          );
        })
        .finally(() => {
          realtime.inFlight = null;
        });
    }
    if (realtime.inFlight && realtime.headerAt === null) {
      await within(realtime.inFlight, REALTIME_WAIT_MS);
    }
    if (realtime.builtFor !== schedules && realtime.lastTripUpdates.length > 0) {
      this.join(realtime, schedules);
    }
  }

  private async fetchRealtime(state: OperatorState, realtime: RealtimeState): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const tripUpdates: RealtimeState['lastTripUpdates'] = [];
      let header: number | undefined;
      for (const url of realtime.urls) {
        const bytes = await getBytes(this.options.fetch, url, abort.signal, {
          'user-agent': state.source.settings.userAgent,
          accept: GTFS_REALTIME_ACCEPT,
        });
        const feed = decodeGtfsRealtime(bytes);
        tripUpdates.push(...feed.tripUpdates);
        header = Math.max(header ?? 0, feed.headerTimestamp ?? 0) || header;
      }
      realtime.lastTripUpdates = tripUpdates;
      // A feed with no timestamp is dated by when it was read.
      realtime.headerAt = header ? header * 1000 : this.now();
      realtime.failing = false;
      realtime.builtFor = null;
      if (state.schedules) this.join(realtime, state.schedules);
    } finally {
      clearTimeout(timer);
    }
  }

  private join(realtime: RealtimeState, schedules: readonly TransitSchedule[]): void {
    realtime.joined = schedules.map((schedule) =>
      joinRealtime(
        schedule,
        realtime.lastTripUpdates,
        serviceDays(this.now(), schedule.timeZone),
        this.now(),
      ),
    );
    realtime.builtFor = schedules;
  }
}

/** Wait for a promise, but not longer than `ms`; the timer never outlives the wait. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
}

function realtimeStatus(state: OperatorState, nowMs: number): TransitOperator['realtime'] {
  const configured = state.source.definition.departures?.realtimeUrls;
  if (!configured) return 'none';
  const realtime = state.realtime;
  if (!realtime || realtime.failing || realtime.headerAt === null) return 'unavailable';
  return nowMs - realtime.headerAt <= REALTIME_MAX_AGE_MS ? 'live' : 'unavailable';
}

/** Whether a point (with its search radius) is inside a source's coverage. */
function covers(
  definition: LiveSourceDefinition,
  latitude: number,
  longitude: number,
  radiusMeters: number,
): boolean {
  const box = definition.coverage;
  if (!box) return true;
  const dLat = radiusMeters / 111_000;
  const dLon = dLat / Math.max(0.05, Math.cos((latitude * Math.PI) / 180));
  const withinLongitude =
    box.west <= box.east
      ? longitude >= box.west - dLon && longitude <= box.east + dLon
      : longitude >= box.west - dLon || longitude <= box.east + dLon;
  return withinLongitude && latitude >= box.south - dLat && latitude <= box.north + dLat;
}

const lineId = (schedule: TransitSchedule, route: number) =>
  (schedule.routes[route] as (typeof schedule.routes)[number]).id;

/** The modes of some routes, those with the most lines first. */
function modesOf(schedule: TransitSchedule, routes: Uint32Array): TransitMode[] {
  const counts = new Map<TransitMode, number>();
  for (const route of routes) {
    const mode = (schedule.routes[route] as (typeof schedule.routes)[number]).mode;
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
  }
  const modes = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([mode]) => mode);
  return modes.length > 0 ? modes : ['other'];
}
