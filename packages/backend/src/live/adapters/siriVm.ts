/**
 * SIRI Vehicle Monitoring (SIRI-VM, CEN/TS 15531), the European standard
 * some networks publish vehicle positions in instead of GTFS-Realtime.
 *
 * Reads a `ServiceDelivery` → `VehicleMonitoringDelivery` → `VehicleActivity`
 * document, XML or its JSON rendering, and keeps per vehicle: its
 * `VehicleRef`, the line (`PublishedLineName`, else `LineRef`), `Bearing`,
 * `VehicleLocation`, and the time it was recorded (`RecordedAtTime`). A
 * vehicle without a position or a time is refused, as every adapter refuses.
 *
 * The XML is read by a small, bounded tag reader rather than a DOM: SIRI-VM
 * is a flat, regular document, and the backend has no XML parser.
 */
import type { GeoBoundingBox, LiveTransitMode, LiveTransitVehicle } from '@goway/contracts';
import { tag } from '../../hub/xml';
import { accept, getBytes, heading, instant, position, text } from '../normalise';
import type { LiveAdapter, LiveAdapterSettings, LiveFetchContext, LivePollResult } from '../types';

export interface SiriVmOptions {
  sourceId: string;
  operator: string;
  coverage: GeoBoundingBox | null;
  defaultMode: LiveTransitMode;
  /** Extra request headers (Entur asks for `ET-Client-Name`). */
  headers?: Record<string, string>;
}

export interface SiriVehicle {
  vehicleRef: string | null;
  line: string | null;
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  recordedAt: string | null;
}

const num = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Every `VehicleActivity` of a SIRI-VM XML document. */
export function parseSiriVmXml(xml: string): SiriVehicle[] {
  const out: SiriVehicle[] = [];
  const activity = /<(?:\w+:)?VehicleActivity(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?VehicleActivity>/g;
  for (const match of xml.matchAll(activity)) {
    const body = match[1] ?? '';
    const location =
      /<(?:\w+:)?VehicleLocation(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?VehicleLocation>/.exec(
        body,
      )?.[1] ?? '';
    out.push({
      vehicleRef: tag(body, 'VehicleRef'),
      line: tag(body, 'PublishedLineName') ?? tag(body, 'LineRef'),
      latitude: num(tag(location, 'Latitude')),
      longitude: num(tag(location, 'Longitude')),
      bearing: num(tag(body, 'Bearing')),
      recordedAt: tag(body, 'RecordedAtTime'),
    });
  }
  return out;
}

/** A SIRI value in its JSON rendering: a string, or `{ value }`, or an array of either. */
function value(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return value(node[0]);
  if (typeof node === 'object' && 'value' in node) return value((node as { value: unknown }).value);
  return null;
}

/** Every `VehicleActivity` of a SIRI-VM JSON document (`Siri.ServiceDelivery…`). */
export function parseSiriVmJson(document: unknown): SiriVehicle[] {
  const root = (document as { Siri?: unknown })?.Siri ?? document;
  const delivery = (root as { ServiceDelivery?: { VehicleMonitoringDelivery?: unknown } })
    ?.ServiceDelivery?.VehicleMonitoringDelivery;
  const deliveries = Array.isArray(delivery) ? delivery : delivery ? [delivery] : [];
  const out: SiriVehicle[] = [];
  for (const d of deliveries) {
    const activities = (d as { VehicleActivity?: unknown[] })?.VehicleActivity ?? [];
    for (const a of Array.isArray(activities) ? activities : []) {
      const activity = a as Record<string, unknown>;
      const journey = (activity.MonitoredVehicleJourney ?? {}) as Record<string, unknown>;
      const location = (journey.VehicleLocation ?? {}) as Record<string, unknown>;
      out.push({
        vehicleRef: value(journey.VehicleRef),
        line: value(journey.PublishedLineName) ?? value(journey.LineRef),
        latitude: num(value(location.Latitude)),
        longitude: num(value(location.Longitude)),
        bearing: num(value(journey.Bearing)),
        recordedAt: value(activity.RecordedAtTime),
      });
    }
  }
  return out;
}

export function normaliseSiriVm(
  options: SiriVmOptions,
  vehicles: readonly SiriVehicle[],
  nowMs: number,
): LivePollResult {
  const entities: LiveTransitVehicle[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const vehicle of vehicles) {
    const id = text(vehicle.vehicleRef ?? undefined, 80);
    const where = position(
      vehicle.latitude ?? undefined,
      vehicle.longitude ?? undefined,
      options.coverage,
    );
    const recorded = vehicle.recordedAt ? Date.parse(vehicle.recordedAt) : Number.NaN;
    const observedAt = Number.isFinite(recorded) ? instant(recorded, nowMs) : null;
    if (!id || !where || !observedAt || seen.has(id)) {
      rejected++;
      continue;
    }
    const entity = accept({
      kind: 'transit',
      id: `${options.sourceId}:${id}`,
      sourceId: options.sourceId,
      position: {
        latitude: Math.round(where.latitude * 1e6) / 1e6,
        longitude: Math.round(where.longitude * 1e6) / 1e6,
      },
      headingDegrees: heading(vehicle.bearing ?? undefined),
      speedMetersPerSecond: null,
      observedAt,
      mode: options.defaultMode,
      operator: options.operator,
      line: text(vehicle.line ?? undefined, 32),
      headsign: null,
      vehicleLabel: null,
      lineColor: null,
      lineTextColor: null,
      track: null,
      trackStatus: 'unknown',
      positionBasis: 'reported',
    }) as LiveTransitVehicle | null;
    if (!entity) {
      rejected++;
      continue;
    }
    seen.add(id);
    entities.push(entity);
  }
  return { entities, rejected };
}

export function createSiriVmAdapter(
  options: SiriVmOptions,
  settings: LiveAdapterSettings,
): LiveAdapter {
  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      const bytes = await getBytes(context.fetch, settings.url, context.signal, {
        'user-agent': settings.userAgent,
        accept: 'application/xml, application/json',
        ...(options.headers ?? {}),
      });
      const body = new TextDecoder().decode(bytes).trimStart();
      const vehicles = body.startsWith('{')
        ? parseSiriVmJson(JSON.parse(body))
        : parseSiriVmXml(body);
      return normaliseSiriVm(options, vehicles, context.now());
    },
  };
}
