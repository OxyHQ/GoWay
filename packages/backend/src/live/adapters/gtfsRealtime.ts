/**
 * Public-transport vehicles from a GTFS-Realtime `VehiclePositions` feed.
 *
 * One generic adapter for every such feed; what differs per operator is
 * configuration in the catalogue — its name, its coverage, and how its route
 * ids and labels map to a mode and a line riders recognise (a `VehiclePosition`
 * names a `route_id`, but the `route_type` and the short name live in the
 * static GTFS, which this adapter deliberately does not download).
 *
 * ## Refused, not guessed
 *
 *  - no position, a `(0, 0)` position, or one far outside the operator's
 *    coverage;
 *  - no timestamp on the vehicle AND none on the feed header;
 *  - a deleted entity (`is_deleted`), which is a retraction, not a vehicle.
 *
 * Bearing and speed are optional in GTFS-Realtime and many feeds (Renfe's
 * among them) send neither; they stay `null` here. A client may derive motion
 * from two consecutive fixes, within the source's stale bound — the server
 * never invents it.
 */

import type {
  GeoBoundingBox,
  LiveEntity,
  LiveTransitMode,
  LiveTransitVehicle,
} from '@goway/contracts';
import { decodeGtfsRealtime, type GtfsVehiclePosition } from '../protobuf';
import { accept, getBytes, heading, instant, position, text, within } from '../normalise';
import type { MatchHint } from '../staticGtfs';
import type { LiveAdapter, LiveAdapterSettings, LiveFetchContext, LivePollResult } from '../types';

export interface GtfsRealtimeOptions {
  sourceId: string;
  operator: string;
  coverage: GeoBoundingBox | null;
  /** The mode of a vehicle; `defaultMode` when it returns `null`. */
  modeOf?: (vehicle: GtfsVehiclePosition) => LiveTransitMode | null;
  defaultMode: LiveTransitMode;
  /** The line riders know; the route id when absent. */
  lineOf?: (vehicle: GtfsVehiclePosition) => string | null;
  /** The vehicle's label; the descriptor's `label` when absent. */
  labelOf?: (vehicle: GtfsVehiclePosition) => string | null;
  /** Where a configured key goes: a query parameter (`key` for MTA Bus Time) or headers. */
  keyQueryParameter?: string;
  keyHeaders?: (key: string) => Record<string, string>;
  /** Headers an operator asks every caller to send (Entur's `ET-Client-Name`). */
  headers?: Readonly<Record<string, string>>;
}

export function normaliseGtfsVehicle(
  options: GtfsRealtimeOptions,
  vehicle: GtfsVehiclePosition,
  headerTimestamp: number | undefined,
  nowMs: number,
): LiveTransitVehicle | null {
  if (vehicle.isDeleted) return null;
  const providerId = text(vehicle.vehicleId, 80) ?? text(vehicle.entityId, 80);
  if (!providerId) return null;
  const where = position(vehicle.latitude, vehicle.longitude, options.coverage);
  if (!where) return null;
  const seconds = vehicle.timestamp ?? headerTimestamp;
  const observedAt = instant(seconds === undefined ? null : seconds * 1000, nowMs);
  if (!observedAt) return null;
  const line = options.lineOf?.(vehicle) ?? text(vehicle.routeId, 32);
  return accept({
    kind: 'transit',
    id: `${options.sourceId}:${providerId}`,
    sourceId: options.sourceId,
    position: { latitude: round(where.latitude, 6), longitude: round(where.longitude, 6) },
    headingDegrees: heading(vehicle.bearing),
    // GTFS-Realtime speed is m/s; 150 m/s is beyond any train in revenue service.
    speedMetersPerSecond: within(vehicle.speed, 0, 150),
    observedAt,
    mode: options.modeOf?.(vehicle) ?? options.defaultMode,
    operator: options.operator,
    line: line === null ? null : text(line, 32),
    headsign: null,
    vehicleLabel: text(options.labelOf?.(vehicle) ?? vehicle.vehicleLabel, 40),
    // Filled from the operator's static GTFS by the hub (`staticGtfs.ts`).
    lineColor: null,
    lineTextColor: null,
    track: null,
    trackStatus: 'unknown',
    positionBasis: 'reported',
  }) as LiveTransitVehicle | null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function normaliseGtfsFeed(
  options: GtfsRealtimeOptions,
  bytes: Uint8Array,
  nowMs: number,
): LivePollResult {
  const feed = decodeGtfsRealtime(bytes);
  const byId = new Map<string, LiveEntity>();
  const hints = new Map<string, MatchHint>();
  let rejected = 0;
  for (const vehicle of feed.vehicles) {
    const entity = normaliseGtfsVehicle(options, vehicle, feed.headerTimestamp, nowMs);
    if (!entity) {
      rejected++;
      continue;
    }
    const previous = byId.get(entity.id);
    if (!previous || previous.observedAt < entity.observedAt) {
      byId.set(entity.id, entity);
      const route =
        vehicle.routeId ?? (entity.kind === 'transit' ? (entity.line ?? undefined) : undefined);
      hints.set(entity.id, {
        ...(vehicle.tripId ? { tripId: vehicle.tripId } : {}),
        ...(route ? { route } : {}),
      });
    }
  }
  return { entities: [...byId.values()], rejected, hints };
}

export function createGtfsRealtimeAdapter(
  options: GtfsRealtimeOptions,
  settings: LiveAdapterSettings,
): LiveAdapter {
  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      const headers: Record<string, string> = {
        ...options.headers,
        'user-agent': settings.userAgent,
        accept: 'application/x-protobuf, application/octet-stream',
        ...(settings.key && options.keyHeaders ? options.keyHeaders(settings.key) : {}),
      };
      // The key is appended here rather than configured in the URL, so it never
      // appears in configuration that is logged or reviewed (`config/live.ts`).
      const url =
        settings.key && options.keyQueryParameter
          ? `${settings.url}${settings.url.includes('?') ? '&' : '?'}${options.keyQueryParameter}=${encodeURIComponent(settings.key)}`
          : settings.url;
      const bytes = await getBytes(context.fetch, url, context.signal, headers);
      return normaliseGtfsFeed(options, bytes, context.now());
    },
  };
}
