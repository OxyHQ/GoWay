/**
 * Ships from Fintraffic's Digitraffic marine AIS API (Baltic Sea / Finland).
 *
 *     GET {base}/api/ais/v1/locations?from=<epoch ms>   GeoJSON, one Feature per vessel
 *     GET {base}/api/ais/v1/vessels?from=<epoch ms>     static reports: name, destination
 *
 * Digitraffic asks every client to identify itself in a `Digitraffic-User`
 * header and to accept gzip; both are sent. Positions are fetched with `from`
 * set to the source's drop bound, so a poll carries only vessels heard
 * recently rather than every ship the system has ever seen. Static reports
 * (names) are fetched in full once and then incrementally every
 * {@link VESSEL_METADATA_REFRESH_MS}.
 *
 * ## AIS's "not available" values are values
 *
 * AIS encodes "unknown" in band: speed 102.3 kn, course 360°, heading 511.
 * Each is read as `null`, never as a ship doing 102 knots due north.
 */

import type { LiveEntity, LiveVessel } from '@goway/contracts';
import {
  accept,
  finite,
  getJson,
  instant,
  KNOTS_TO_METERS_PER_SECOND,
  position,
  record,
  text,
  within,
} from '../normalise';
import type { LiveAdapter, LiveAdapterSettings, LiveFetchContext, LivePollResult } from '../types';

export const VESSEL_METADATA_REFRESH_MS = 30 * 60_000;

/** ITU-R M.1371 navigational status, in words. 9–14 are reserved; 15 is "not defined". */
const NAVIGATIONAL_STATUS: Readonly<Record<number, string>> = {
  0: 'under way using engine',
  1: 'at anchor',
  2: 'not under command',
  3: 'restricted manoeuvrability',
  4: 'constrained by draught',
  5: 'moored',
  6: 'aground',
  7: 'engaged in fishing',
  8: 'under way sailing',
};

export interface VesselMetadata {
  name: string | null;
  destination: string | null;
}

export interface DigitrafficOptions {
  sourceId: string;
  coverage: { west: number; south: number; east: number; north: number } | null;
  /** How far back `from` reaches, in seconds — the source's drop bound. */
  windowSeconds: number;
}

/** AIS names are upper-case, padded with `@` or spaces; `null` when nothing is left. */
function aisText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return text(value.replace(/@+$/g, ''), max);
}

export function parseVesselMetadata(body: unknown, into: Map<string, VesselMetadata>): void {
  if (!Array.isArray(body)) return;
  for (const raw of body) {
    const vessel = record(raw);
    const mmsi = finite(vessel?.mmsi);
    if (!vessel || mmsi === null || !Number.isInteger(mmsi)) continue;
    into.set(String(mmsi).padStart(9, '0'), {
      name: aisText(vessel.name, 40),
      destination: aisText(vessel.destination, 40),
    });
  }
}

export function normaliseDigitrafficVessel(
  options: DigitrafficOptions,
  raw: unknown,
  metadata: ReadonlyMap<string, VesselMetadata>,
  nowMs: number,
): LiveVessel | null {
  const feature = record(raw);
  const properties = record(feature?.properties);
  const geometry = record(feature?.geometry);
  if (!feature || !properties || !geometry || geometry.type !== 'Point') return null;
  const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  const where = position(coordinates[1], coordinates[0], options.coverage);
  if (!where) return null;
  const mmsiNumber = finite(properties.mmsi);
  if (mmsiNumber === null || !Number.isInteger(mmsiNumber) || mmsiNumber <= 0) return null;
  const mmsi = String(mmsiNumber).padStart(9, '0');
  if (!/^\d{9}$/.test(mmsi)) return null;
  const observedAt = instant(finite(properties.timestampExternal), nowMs);
  if (!observedAt) return null;

  // In-band "not available": sog 102.3, cog 360, heading 511.
  const sog = within(properties.sog, 0, 102.2);
  const cog = within(properties.cog, 0, 359.99);
  const trueHeading = within(properties.heading, 0, 359);
  const status = finite(properties.navStat);
  const known = metadata.get(mmsi);

  return accept({
    kind: 'vessel',
    id: `${options.sourceId}:${mmsi}`,
    sourceId: options.sourceId,
    position: where,
    headingDegrees: cog ?? trueHeading,
    speedMetersPerSecond:
      sog === null ? null : Math.round(sog * KNOTS_TO_METERS_PER_SECOND * 10) / 10,
    observedAt,
    mmsi,
    name: known?.name ?? null,
    navigationalStatus: status === null ? null : (NAVIGATIONAL_STATUS[status] ?? null),
    destination: known?.destination ?? null,
  }) as LiveVessel | null;
}

export function createDigitrafficAdapter(
  options: DigitrafficOptions,
  settings: LiveAdapterSettings,
): LiveAdapter {
  const metadata = new Map<string, VesselMetadata>();
  let metadataFetchedAt = 0;
  const headers = {
    'user-agent': settings.userAgent,
    'digitraffic-user': settings.userAgent,
    'accept-encoding': 'gzip',
  };

  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      const now = context.now();
      if (now - metadataFetchedAt > VESSEL_METADATA_REFRESH_MS) {
        // Full the first time, incremental afterwards. A failure here costs
        // names, not positions.
        const from = metadataFetchedAt === 0 ? '' : `?from=${metadataFetchedAt - 60_000}`;
        try {
          parseVesselMetadata(
            await getJson(
              context.fetch,
              `${settings.url}/api/ais/v1/vessels${from}`,
              context.signal,
              headers,
            ),
            metadata,
          );
          metadataFetchedAt = now;
        } catch {
          // Retried on the next poll.
        }
      }
      const since = now - options.windowSeconds * 1000;
      const body = record(
        await getJson(
          context.fetch,
          `${settings.url}/api/ais/v1/locations?from=${since}`,
          context.signal,
          headers,
        ),
      );
      const features = Array.isArray(body?.features) ? body.features : null;
      if (!features) return { entities: [], rejected: 1 };
      const entities: LiveEntity[] = [];
      let rejected = 0;
      for (const raw of features) {
        const vessel = normaliseDigitrafficVessel(options, raw, metadata, now);
        if (vessel) entities.push(vessel);
        else rejected++;
      }
      return { entities, rejected };
    },
  };
}
