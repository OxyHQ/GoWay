/**
 * ESTIMATED positions from arrival predictions — for networks that publish
 * where their vehicles are going to be, not where they are: New York's subway
 * (underground, no GPS; its `VehiclePosition`s carry a stop, never a
 * coordinate) and AMB's metropolitan buses (`TripUpdate`s only).
 *
 * Every entity this produces says so: `positionBasis: 'estimated'`, and the
 * map draws it in its own style with "Estimated from arrival predictions".
 * Nothing here is re-served as the operator's data: the predictions stay
 * theirs; the position is GoWay's arithmetic on them, on the operator's own
 * published line.
 *
 * ## The estimate
 *
 * Along the trip's shape (`shapes.txt`), each predicted stop has a distance
 * (`stops.txt`, projected). With the next stop A due at `tA` and the one
 * after, B, at `tB`, the vehicle is placed short of A by the distance it
 * covers at the A→B pace in the time left: `s = sA − (sB − sA)·(tA − now)/(tB − tA)`,
 * never more than one A→B spacing back. A vehicle the feed says is STOPPED
 * AT a stop is at that stop. A trip whose next stop is due more than
 * {@link MAX_LEAD_SECONDS} away, or has only one stop left and is not about
 * to reach it, is not shown at all — there is nothing honest to say.
 */

import type { LiveEntity, LiveTransitMode, LiveTransitVehicle } from '@goway/contracts';
import { decodeGtfsRealtime, type GtfsTripUpdate, type GtfsVehiclePosition } from '../protobuf';
import { accept, getBytes, instant } from '../normalise';
import { findTrip, type GtfsShape, pointOnShape, project, type StaticGtfs } from '../staticGtfs';
import type { LiveAdapter, LiveAdapterSettings, LiveFetchContext, LivePollResult } from '../types';
import { GTFS_REALTIME_ACCEPT } from './gtfsRealtime';

/** A next stop due further ahead than this is a trip that has not started. */
export const MAX_LEAD_SECONDS = 600;
/** A stop farther than this from the shape is not on it (a parent station, a typo). */
const STOP_ON_SHAPE_METERS = 150;
/** With one stop left, it is shown only this close to it. */
const LAST_STOP_SECONDS = 90;

export interface ArrivalEstimateOptions {
  sourceId: string;
  operator: string;
  defaultMode: LiveTransitMode;
  /** The feeds to read (New York's subway is split over eight). */
  urls: readonly string[];
  /** A shape for a trip the static GTFS does not list by id. */
  shapeIdOf?: (tripId: string) => string | null;
  /** Where a configured key goes, as in `gtfsRealtime.ts`. */
  keyQueryParameter?: string;
  keyHeaders?: (key: string) => Record<string, string>;
  headers?: Record<string, string>;
}

interface Estimate {
  along: number;
}

/** Where a trip's vehicle is, by its predictions; `null` when it cannot honestly be said. */
export function estimateAlong(
  stops: readonly { along: number; time: number }[],
  stoppedAt: number | null,
  nowSeconds: number,
  shapeLength: number,
): Estimate | null {
  if (stoppedAt !== null) return { along: stoppedAt };
  const upcoming = stops
    .filter((stop) => stop.time >= nowSeconds - 30)
    .sort((a, b) => a.time - b.time);
  const a = upcoming[0];
  if (!a) return null;
  const lead = a.time - nowSeconds;
  if (lead > MAX_LEAD_SECONDS) return null;
  if (lead <= 0) return { along: a.along };
  const b = upcoming.find((stop) => stop.time > a.time && stop.along > a.along);
  if (!b) return lead <= LAST_STOP_SECONDS ? { along: a.along } : null;
  // Not yet left its first stop: say nothing until it is about to.
  if (a.along < 50 && lead > LAST_STOP_SECONDS) return null;
  const spacing = b.along - a.along;
  const back = Math.min(spacing, (spacing * lead) / (b.time - a.time));
  return { along: Math.max(0, Math.min(shapeLength, a.along - back)) };
}

export function estimateFromFeeds(
  options: ArrivalEstimateOptions,
  gtfs: StaticGtfs,
  updates: readonly GtfsTripUpdate[],
  vehicles: readonly GtfsVehiclePosition[],
  feedSeconds: number,
  nowMs: number,
  stopAlongCache: Map<string, number | null>,
  routeShapeCache: Map<string, string | null> = new Map(),
): LivePollResult {
  const observedAt = instant(feedSeconds * 1000, nowMs);
  if (!observedAt) return { entities: [], rejected: updates.length };
  const stoppedStop = new Map<string, string>();
  for (const vehicle of vehicles) {
    // VehicleStopStatus 1 = STOPPED_AT.
    if (vehicle.tripId && vehicle.currentStatus === 1 && vehicle.stopId)
      stoppedStop.set(vehicle.tripId, vehicle.stopId);
  }
  const alongOf = (shape: GtfsShape, stopId: string): number | null => {
    const key = `${shape.id}|${stopId}`;
    const cached = stopAlongCache.get(key);
    if (cached !== undefined) return cached;
    const stop = gtfs.stops.get(stopId);
    let along: number | null = null;
    if (stop) {
      const projection = project(shape, stop.latitude, stop.longitude);
      along = projection.offset <= STOP_ON_SHAPE_METERS ? projection.along : null;
    }
    stopAlongCache.set(key, along);
    return along;
  };

  /**
   * The trip's shape: the one the static GTFS (or its id) names, else the
   * one of its route's shapes that its predicted stops lie along IN ORDER
   * (New York's realtime-only trip patterns). None when no shape fits.
   */
  const shapeFor = (
    update: GtfsTripUpdate,
    named: string | null,
    routeId: string | undefined,
  ): string | null => {
    if (named && gtfs.shapes.has(named)) return named;
    const route = routeId ?? update.routeId;
    const candidates = route ? gtfs.shapesByRoute.get(route) : undefined;
    if (!candidates) return null;
    const ordered = update.stops
      .filter(
        (stop) =>
          stop.stopId &&
          (stop.arrival ?? stop.departure) !== undefined &&
          gtfs.stops.has(stop.stopId),
      )
      .sort((a, b) => (a.arrival ?? a.departure ?? 0) - (b.arrival ?? b.departure ?? 0));
    if (ordered.length === 0) return null;
    const key = `${route}|${ordered.map((stop) => stop.stopId).join(',')}`;
    const cached = routeShapeCache.get(key);
    if (cached !== undefined) return cached;
    let best: { id: string; score: number; length: number } | null = null;
    for (const id of candidates) {
      const shape = gtfs.shapes.get(id);
      if (!shape) continue;
      let score = 0;
      let previous = -Infinity;
      for (const stop of ordered) {
        const along = alongOf(shape, stop.stopId as string);
        // On the line, and not behind the last stop: the right direction.
        if (along !== null && along >= previous - 50) {
          score++;
          previous = along;
        }
      }
      if (!best || score > best.score || (score === best.score && shape.length < best.length)) {
        best = { id, score, length: shape.length };
      }
    }
    // Most of its stops, in order — or it is not this route's line.
    const chosen =
      best && best.score >= Math.max(1, Math.ceil(ordered.length * 0.8)) ? best.id : null;
    routeShapeCache.set(key, chosen);
    return chosen;
  };

  const entities: LiveEntity[] = [];
  let rejected = 0;
  for (const update of updates) {
    if (!update.tripId) {
      rejected++;
      continue;
    }
    const trip = findTrip(gtfs, update.tripId);
    const shapeId = shapeFor(
      update,
      trip?.shapeId ?? options.shapeIdOf?.(update.tripId) ?? null,
      trip?.routeId,
    );
    const shape = shapeId ? gtfs.shapes.get(shapeId) : undefined;
    if (!shape || !shapeId) {
      rejected++;
      continue;
    }
    const stops: { along: number; time: number }[] = [];
    for (const stop of update.stops) {
      const time = stop.arrival ?? stop.departure;
      if (!stop.stopId || time === undefined) continue;
      const along = alongOf(shape, stop.stopId);
      if (along !== null) stops.push({ along, time });
    }
    const stopped = stoppedStop.get(update.tripId);
    const stoppedAlong = stopped ? alongOf(shape, stopped) : null;
    const estimate = estimateAlong(stops, stoppedAlong, nowMs / 1000, shape.length);
    if (!estimate) continue;
    const route = gtfs.routes.get(trip?.routeId ?? update.routeId ?? '') ?? null;
    const where = pointOnShape(shape, estimate.along);
    const entity = accept({
      kind: 'transit',
      id: `${options.sourceId}:${update.tripId}`.slice(0, 160),
      sourceId: options.sourceId,
      position: {
        latitude: Math.round(where.latitude * 1e6) / 1e6,
        longitude: Math.round(where.longitude * 1e6) / 1e6,
      },
      headingDegrees: null,
      speedMetersPerSecond: null,
      observedAt,
      mode: options.defaultMode,
      operator: options.operator,
      line: (route?.shortName ?? update.routeId ?? null)?.slice(0, 32) || null,
      headsign: null,
      vehicleLabel: null,
      lineColor: route?.color ?? null,
      lineTextColor: route?.textColor ?? null,
      track: { shapeId, alongMeters: Math.round(estimate.along * 10) / 10, offsetMeters: 0 },
      trackStatus: 'on_track',
      positionBasis: 'estimated',
    }) as LiveTransitVehicle | null;
    if (entity) entities.push(entity);
    else rejected++;
  }
  return { entities, rejected };
}

export function createArrivalEstimateAdapter(
  options: ArrivalEstimateOptions,
  settings: LiveAdapterSettings,
): LiveAdapter {
  const stopAlongCache = new Map<string, number | null>();
  const routeShapeCache = new Map<string, string | null>();
  let cachedFor: StaticGtfs | null = null;
  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      const gtfs = context.staticGtfs;
      // No static GTFS yet: no line to estimate on. Nothing, rather than guesses.
      if (!gtfs) return { entities: [], rejected: 0 };
      if (cachedFor !== gtfs) {
        stopAlongCache.clear();
        routeShapeCache.clear();
        cachedFor = gtfs;
      }
      const updates: GtfsTripUpdate[] = [];
      const vehicles: GtfsVehiclePosition[] = [];
      let feedSeconds = 0;
      let failures = 0;
      let lastError: unknown = null;
      for (const plain of options.urls) {
        const url =
          settings.key && options.keyQueryParameter
            ? `${plain}${plain.includes('?') ? '&' : '?'}${options.keyQueryParameter}=${encodeURIComponent(settings.key)}`
            : plain;
        try {
          const feed = decodeGtfsRealtime(
            await getBytes(context.fetch, url, context.signal, {
              'user-agent': settings.userAgent,
              accept: GTFS_REALTIME_ACCEPT,
              ...(options.headers ?? {}),
              ...(settings.key && options.keyHeaders ? options.keyHeaders(settings.key) : {}),
            }),
          );
          updates.push(...feed.tripUpdates);
          vehicles.push(...feed.vehicles);
          feedSeconds = Math.max(feedSeconds, feed.headerTimestamp ?? 0);
        } catch (error) {
          failures++;
          lastError = error;
        }
      }
      if (failures === options.urls.length) throw lastError;
      return estimateFromFeeds(
        options,
        gtfs,
        updates,
        vehicles,
        feedSeconds || Math.floor(context.now() / 1000),
        context.now(),
        stopAlongCache,
        routeShapeCache,
      );
    },
  };
}
