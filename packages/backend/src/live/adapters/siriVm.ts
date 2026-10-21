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
 * The XML is read by a small one-pass tag reader rather than a DOM: SIRI-VM
 * is a flat, regular document, and the backend has no XML parser. Linear in
 * the document's size, depth-capped, and tolerant of a malformed one.
 */
import type { GeoBoundingBox, LiveTransitMode, LiveTransitVehicle } from '@goway/contracts';
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

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const num = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Nesting deeper than this is not a SIRI-VM document: refused, not followed. */
export const MAX_SIRI_DEPTH = 64;

/** The fields read from an activity, by element name (first occurrence wins). */
type Field = 'VehicleRef' | 'PublishedLineName' | 'LineRef' | 'Bearing' | 'RecordedAtTime';
const FIELDS = new Set<string>([
  'VehicleRef',
  'PublishedLineName',
  'LineRef',
  'Bearing',
  'RecordedAtTime',
]);

/** A tag's local name: `siri:VehicleRef attr="x"` → `VehicleRef`. */
function localName(raw: string): string {
  let end = 0;
  while (end < raw.length && !/[\s/>]/.test(raw[end] as string)) end++;
  const qualified = raw.slice(0, end);
  const colon = qualified.indexOf(':');
  return colon < 0 ? qualified : qualified.slice(colon + 1);
}

/**
 * Every `VehicleActivity` of a SIRI-VM XML document, in ONE pass: each tag
 * is found by `indexOf` and never revisited, so the time is linear in the
 * document whatever it holds (a regular expression with lazy groups took
 * 5.6 s on 576 KB of unclosed tags). Comments, CDATA and declarations are
 * skipped; nesting past {@link MAX_SIRI_DEPTH} throws.
 */
export function parseSiriVmXml(xml: string): SiriVehicle[] {
  const out: SiriVehicle[] = [];
  const stack: string[] = [];
  let activity: Partial<Record<Field | 'Latitude' | 'Longitude', string>> | null = null;
  let depthOfActivity = -1;
  let at = 0;
  const capture = (raw: string) => {
    if (!activity) return;
    const name = stack[stack.length - 1];
    if (!name) return;
    const value = decodeXml(raw.trim());
    if (value === '') return;
    if (FIELDS.has(name)) {
      activity[name as Field] ??= value;
    } else if ((name === 'Latitude' || name === 'Longitude') && stack.includes('VehicleLocation')) {
      activity[name] ??= value;
    }
  };
  while (at < xml.length) {
    const open = xml.indexOf('<', at);
    if (open < 0) break;
    if (open > at) capture(xml.slice(at, open));
    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open + 4);
      if (close < 0) break;
      at = close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open + 9);
      if (close < 0) break;
      capture(xml.slice(open + 9, close));
      at = close + 3;
      continue;
    }
    const close = xml.indexOf('>', open + 1);
    if (close < 0) break; // truncated: what was complete stands
    const raw = xml.slice(open + 1, close);
    at = close + 1;
    if (raw.startsWith('?') || raw.startsWith('!')) continue;
    if (raw.startsWith('/')) {
      const name = localName(raw.slice(1));
      // Close up to the matching open tag (a malformed document closing an
      // outer one early closes the inner ones with it).
      const index = stack.lastIndexOf(name);
      if (index < 0) continue;
      stack.length = index;
      if (activity && stack.length <= depthOfActivity) {
        out.push({
          vehicleRef: activity.VehicleRef ?? null,
          line: activity.PublishedLineName ?? activity.LineRef ?? null,
          latitude: num(activity.Latitude),
          longitude: num(activity.Longitude),
          bearing: num(activity.Bearing),
          recordedAt: activity.RecordedAtTime ?? null,
        });
        activity = null;
        depthOfActivity = -1;
      }
      continue;
    }
    const name = localName(raw);
    if (raw.endsWith('/')) continue; // self-closing: no text
    if (name === 'VehicleActivity' && !activity) {
      activity = {};
      depthOfActivity = stack.length;
    }
    stack.push(name);
    if (stack.length > MAX_SIRI_DEPTH) throw new Error('SIRI-VM document nested too deep');
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
  // Anything not an object where an object belongs (a null activity, a
  // string journey) is an activity without its fields — refused later for
  // what it lacks, never a thrown poll.
  const object = (node: unknown): Record<string, unknown> =>
    typeof node === 'object' && node !== null && !Array.isArray(node)
      ? (node as Record<string, unknown>)
      : {};
  for (const d of deliveries) {
    const activities = object(d).VehicleActivity ?? [];
    for (const a of Array.isArray(activities) ? activities : [activities]) {
      const activity = object(a);
      const journey = object(activity.MonitoredVehicleJourney);
      const location = object(journey.VehicleLocation);
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
