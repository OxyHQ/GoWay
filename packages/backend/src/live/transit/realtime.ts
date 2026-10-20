/**
 * An operator's own TRIP PREDICTIONS (GTFS-Realtime `TripUpdate`s) joined to
 * its timetable, so a departure can say "4 min late, from the vehicle" instead
 * of only "18:42, per the timetable".
 *
 * ## The join, and where it stops
 *
 * A prediction is applied to a timetable trip only when the feed's `trip_id`
 * IS a `trip_id` of the operator's `trips.txt` (AMB's is, 425 of 425 at the
 * time of writing). A feed whose realtime ids do not join the static ones
 * (the MTA subway's `126800_A..N04R` against `ASP26GEN-1038-Sunday-00_…`)
 * matches nothing here and its departures stay `scheduled`: GoWay does not
 * guess which timetable trip a differently-named trip is.
 *
 * ## Which day
 *
 * A `TripUpdate` carries absolute times and, in the subset GoWay reads, no
 * start date. The service day is the candidate (yesterday, today, tomorrow)
 * whose timetable puts the first predicted stop closest to its predicted
 * time, and the trip is ignored when that is still more than
 * {@link MAX_RECONCILE_SECONDS} apart or the trip does not run that day.
 *
 * ## Delay
 *
 * A stop with its own prediction takes it. A later stop with none takes the
 * delay of the last predicted stop before it (the standard propagation). A
 * stop BEFORE the first predicted one has been passed: its departure is not
 * served. A canceled trip, and a stop the operator marks skipped, are dropped.
 */

import type { GtfsTripUpdate } from '../protobuf';
import type { ScheduledDeparture, ServiceDay, TransitSchedule } from './schedule';

/** A prediction farther than this from any timetable day is not this trip. */
export const MAX_RECONCILE_SECONDS = 3 * 3600;

export interface TripRealtime {
  dayStartMs: number;
  canceled: boolean;
  /** By position in the trip, ascending. */
  updates: { position: number; timeMs: number; delaySeconds: number }[];
  skipped: Set<number>;
}

/** The predictions of one feed, joined to one timetable by trip index. */
export function joinRealtime(
  schedule: TransitSchedule,
  updates: readonly GtfsTripUpdate[],
  days: readonly ServiceDay[],
  nowMs: number,
): Map<number, TripRealtime> {
  const joined = new Map<number, TripRealtime>();
  for (const update of updates) {
    const trip = update.tripId ? schedule.tripIndexOf(update.tripId) : undefined;
    if (trip === undefined) continue;
    const { first, count } = schedule.tripSpan(trip);
    if (first < 0) continue;

    if (update.canceled) {
      // The subset of the feed GoWay reads carries no start date, so the day is
      // the one on which the trip runs closest to now — the instance a feed
      // reports on. A trip running on none of the candidate days is ignored.
      let day: ServiceDay | null = null;
      let nearest = Number.POSITIVE_INFINITY;
      for (const candidate of days) {
        if (!schedule.serviceRuns(schedule.serviceOfTrip(trip), candidate)) continue;
        const gap = Math.abs(candidate.startMs + schedule.secondsOfRow(first) * 1000 - nowMs);
        if (gap < nearest) {
          nearest = gap;
          day = candidate;
        }
      }
      if (day)
        joined.set(trip, {
          dayStartMs: day.startMs,
          canceled: true,
          updates: [],
          skipped: new Set(),
        });
      continue;
    }

    const found: { position: number; timeMs: number; skipped: boolean }[] = [];
    let from = 0;
    for (const stop of update.stops) {
      if (stop.noData || !stop.stopId) continue;
      const index = schedule.stopIndexOf(stop.stopId);
      if (index === undefined) continue;
      let position = -1;
      for (let at = from; at < count; at++) {
        if (schedule.stopOfRow(first + at) === index) {
          position = at;
          break;
        }
      }
      if (position < 0) continue;
      from = position + 1;
      const seconds = stop.departure ?? stop.arrival;
      if (seconds === undefined && !stop.skipped) continue;
      found.push({ position, timeMs: (seconds ?? 0) * 1000, skipped: stop.skipped === true });
    }
    const anchor = found.find((entry) => !entry.skipped);
    if (!anchor) continue;

    let day: ServiceDay | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of days) {
      const scheduledMs = candidate.startMs + schedule.secondsOfRow(first + anchor.position) * 1000;
      const gap = Math.abs(anchor.timeMs - scheduledMs);
      if (gap < best && schedule.serviceRuns(schedule.serviceOfTrip(trip), candidate)) {
        best = gap;
        day = candidate;
      }
    }
    if (!day || best > MAX_RECONCILE_SECONDS * 1000) continue;

    const trace: TripRealtime = {
      dayStartMs: day.startMs,
      canceled: false,
      updates: [],
      skipped: new Set(),
    };
    for (const entry of found) {
      if (entry.skipped) {
        trace.skipped.add(entry.position);
        continue;
      }
      const scheduledMs = day.startMs + schedule.secondsOfRow(first + entry.position) * 1000;
      trace.updates.push({
        position: entry.position,
        timeMs: entry.timeMs,
        delaySeconds: Math.round((entry.timeMs - scheduledMs) / 1000),
      });
    }
    joined.set(trip, trace);
  }
  return joined;
}

export type RealtimeVerdict =
  /** No prediction for this trip and day: the timetable stands. */
  | null
  /** The vehicle has passed, the stop is skipped, or the trip is canceled. */
  | 'drop'
  | { timeMs: number; delaySeconds: number };

/** What the predictions say about one timetable departure. */
export function applyRealtime(
  schedule: TransitSchedule,
  departure: ScheduledDeparture,
  trace: TripRealtime | undefined,
): RealtimeVerdict {
  if (!trace || trace.dayStartMs !== departure.dayStartMs) return null;
  if (trace.canceled) return 'drop';
  const position = schedule.positionInTrip(departure.row);
  if (trace.skipped.has(position)) return 'drop';
  let known: { timeMs: number; delaySeconds: number } | null = null;
  for (const update of trace.updates) {
    if (update.position > position) break;
    known = update;
  }
  if (!known) return 'drop';
  const delaySeconds = known.delaySeconds;
  return {
    timeMs: departure.timeMs + delaySeconds * 1000,
    delaySeconds,
  };
}
