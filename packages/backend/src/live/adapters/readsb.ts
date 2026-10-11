/**
 * Aircraft from a readsb-style aggregator API — adsb.lol's `/v2` (the same
 * JSON airplanes.live and adsb.fi serve).
 *
 *     GET {base}/v2/lat/{lat}/lon/{lon}/dist/{nm}   → { now, ac: [ … ] }
 *
 * ## Regional, and only where somebody is looking
 *
 * Aircraft are worldwide; nobody may ask an aggregator for the planet every
 * few seconds, and nobody needs to. The poll covers only the room tiles that
 * are being watched, grouped by their zoom-6 parent: a z6 tile's half-diagonal
 * is at most ~240 nautical miles (at the equator), inside the API's 250 nm
 * radius, so one circle covers four z7 rooms. At most `maxRegionsPerPoll`
 * circles per poll, most-watched first, the rest rotated through on later
 * polls so a quiet region is not starved.
 *
 * ## What a record becomes
 *
 *  - `hex` → `icao24` (and the id). A record without one is refused.
 *  - `lat`/`lon` → position. A record without a position is skipped (counted
 *    as rejected): an aircraft heard but not located cannot be drawn.
 *  - `now − seen_pos` → `observedAt`: when the POSITION was received, not
 *    when the aggregator answered.
 *  - `alt_geom` (ft) → geometric altitude, else `alt_baro` (ft) → barometric;
 *    `alt_baro: "ground"` → `onGround`, altitude 0.
 *  - `gs` (kt) → speed; `track` → heading; `geom_rate`/`baro_rate` (ft/min) →
 *    vertical rate. Absent or impossible values become `null`.
 *  - `flight` → callsign, `r` → registration, `t` → type: verbatim, trimmed.
 *
 * ## Aircraft whose owners asked not to be shown are not shown
 *
 * The FAA's LADD (Limiting Aircraft Data Displayed) and PIA (Privacy ICAO
 * Address) programmes exist so an owner can keep an aircraft off public
 * tracking displays. Aggregators mark them in `dbFlags` (bit 8 = LADD, bit 4 =
 * PIA); GoWay drops those records before they reach a map, and counts them as
 * neither accepted nor rejected — they are not junk, they are withheld.
 */

import type { GeoBoundingBox, LiveAircraft, LiveEntity } from '@goway/contracts';
import {
  accept,
  FEET_PER_MINUTE_TO_METERS_PER_SECOND,
  FEET_TO_METERS,
  finite,
  getJson,
  heading,
  instant,
  KNOTS_TO_METERS_PER_SECOND,
  position,
  record,
  text,
  within,
} from '../normalise';
import {
  type LiveAdapter,
  type LiveAdapterSettings,
  type LiveFetchContext,
  type LivePollResult,
  LiveUpstreamError,
} from '../types';

/** The API's largest radius. */
export const READSB_MAX_RADIUS_NM = 250;

const NM_IN_METERS = 1852;
const EARTH_RADIUS_M = 6_371_008.8;

export interface ReadsbRegion {
  /** The z6 tile key, for rotation and tests. */
  key: string;
  latitude: number;
  longitude: number;
  radiusNm: number;
  /** How many watched rooms it covers. */
  weight: number;
}

function latitudeOfRow(row: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
}

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The circles that cover the watched boxes: one per z6 tile that contains a
 * watched box's centre, weighted by how many boxes it covers.
 */
export function planRegions(demand: readonly GeoBoundingBox[]): ReadsbRegion[] {
  const n = 64;
  const regions = new Map<string, ReadsbRegion>();
  for (const box of demand) {
    const lat = (box.south + box.north) / 2;
    let lon = box.west <= box.east ? (box.west + box.east) / 2 : (box.west + box.east + 360) / 2;
    if (lon > 180) lon -= 360;
    const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
    const radians = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
    const y = Math.min(
      n - 1,
      Math.max(
        0,
        Math.floor(((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * n),
      ),
    );
    const key = `6/${x}/${y}`;
    const existing = regions.get(key);
    if (existing) {
      existing.weight++;
      continue;
    }
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const north = latitudeOfRow(y, n);
    const south = latitudeOfRow(y + 1, n);
    // The mercator midpoint, so the circle is centred on the tile as drawn.
    const centre = { lat: latitudeOfRow(y + 0.5, n), lon: (west + east) / 2 };
    const reach = Math.max(
      haversineMeters(centre, { lat: north, lon: west }),
      haversineMeters(centre, { lat: south, lon: west }),
    );
    regions.set(key, {
      key,
      latitude: centre.lat,
      longitude: centre.lon,
      radiusNm: Math.min(READSB_MAX_RADIUS_NM, Math.ceil(reach / NM_IN_METERS)),
      weight: 1,
    });
  }
  return [...regions.values()].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
}

/** LADD (8) and PIA (4) in readsb's `dbFlags`. */
const WITHHELD_FLAGS = 8 | 4;

/** An aircraft its owner asked public displays not to show. */
export function isWithheld(ac: Record<string, unknown>): boolean {
  const flags = finite(ac.dbFlags);
  return flags !== null && Number.isInteger(flags) && (flags & WITHHELD_FLAGS) !== 0;
}

/** Normalise one `ac[]` record; `null` refuses it. */
export function normaliseReadsbAircraft(
  sourceId: string,
  raw: unknown,
  responseNowMs: number,
  nowMs: number,
): LiveAircraft | null {
  const ac = record(raw);
  if (!ac) return null;
  if (isWithheld(ac)) return null;
  const hex = typeof ac.hex === 'string' ? ac.hex.trim().toLowerCase() : '';
  if (!/^~?[0-9a-f]{6}$/.test(hex)) return null;
  const where = position(ac.lat, ac.lon);
  if (!where) return null;
  // `seen_pos` is the age of the position; a record without it has no
  // position age we can state, so it is refused rather than dated "now".
  const age = within(ac.seen_pos, 0, 3600);
  if (age === null) return null;
  const observedAt = instant(responseNowMs - age * 1000, nowMs);
  if (!observedAt) return null;

  const onGround = ac.alt_baro === 'ground';
  const geometric = finite(ac.alt_geom);
  const barometric = finite(ac.alt_baro);
  let altitudeMeters: number | null = null;
  let altitudeReference: LiveAircraft['altitudeReference'] = null;
  if (onGround) {
    altitudeMeters = 0;
  } else if (geometric !== null && within(geometric * FEET_TO_METERS, -500, 30_000) !== null) {
    altitudeMeters = Math.round(geometric * FEET_TO_METERS);
    altitudeReference = 'geometric';
  } else if (barometric !== null && within(barometric * FEET_TO_METERS, -500, 30_000) !== null) {
    altitudeMeters = Math.round(barometric * FEET_TO_METERS);
    altitudeReference = 'barometric';
  }

  const groundSpeed = within(ac.gs, 0, 2000);
  const rate = finite(ac.geom_rate) ?? finite(ac.baro_rate);
  const verticalRate =
    rate === null ? null : within(rate * FEET_PER_MINUTE_TO_METERS_PER_SECOND, -200, 200);

  return accept({
    kind: 'aircraft',
    id: `${sourceId}:${hex}`,
    sourceId,
    position: where,
    headingDegrees: heading(ac.track),
    speedMetersPerSecond:
      groundSpeed === null ? null : Math.round(groundSpeed * KNOTS_TO_METERS_PER_SECOND * 10) / 10,
    observedAt,
    icao24: hex,
    callsign: text(ac.flight, 16),
    registration: text(ac.r, 16),
    typeCode: text(ac.t, 8),
    altitudeMeters,
    altitudeReference,
    verticalRateMetersPerSecond: verticalRate === null ? null : Math.round(verticalRate * 10) / 10,
    onGround,
  }) as LiveAircraft | null;
}

/** Normalise a whole `/v2` answer. */
export function normaliseReadsbResponse(
  sourceId: string,
  body: unknown,
  nowMs: number,
): LivePollResult {
  const document = record(body);
  const list = document && Array.isArray(document.ac) ? document.ac : null;
  if (!document || !list) return { entities: [], rejected: 1 };
  // The aggregator's own clock, which `seen_pos` is relative to.
  const responseNow = finite(document.now) ?? nowMs;
  const entities: LiveEntity[] = [];
  let rejected = 0;
  for (const raw of list) {
    const ac = record(raw);
    if (ac && isWithheld(ac)) continue;
    const aircraft = normaliseReadsbAircraft(sourceId, raw, responseNow, nowMs);
    if (aircraft) entities.push(aircraft);
    else rejected++;
  }
  return { entities, rejected };
}

export function createReadsbAdapter(sourceId: string, settings: LiveAdapterSettings): LiveAdapter {
  // Round-robin offset into the regions that did not fit in one poll.
  let rotation = 0;
  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      const regions = planRegions(context.demand);
      if (regions.length === 0) return { entities: [], rejected: 0 };
      const budget = Math.max(1, settings.maxRegionsPerPoll);
      let chosen = regions;
      if (regions.length > budget) {
        // The heaviest half of the budget always; the rest rotates.
        const fixed = Math.ceil(budget / 2);
        const rest = regions.slice(fixed);
        const rotated = Array.from(
          { length: budget - fixed },
          (_, index) => rest[(rotation + index) % rest.length],
        ).filter((region): region is ReadsbRegion => region !== undefined);
        rotation = (rotation + budget - fixed) % Math.max(1, rest.length);
        chosen = [...regions.slice(0, fixed), ...rotated];
      }

      const byId = new Map<string, LiveEntity>();
      let rejected = 0;
      let failures = 0;
      let lastError: unknown = null;
      // Sequential, not parallel: an aggregator's rate limit is per client.
      let attempted = 0;
      for (const region of chosen) {
        const url = `${settings.url}/v2/lat/${region.latitude.toFixed(4)}/lon/${region.longitude.toFixed(4)}/dist/${region.radiusNm}`;
        attempted++;
        try {
          const body = await getJson(context.fetch, url, context.signal, {
            'user-agent': settings.userAgent,
          });
          const result = normaliseReadsbResponse(sourceId, body, context.now());
          rejected += result.rejected;
          for (const entity of result.entities) {
            const previous = byId.get(entity.id);
            // Overlapping circles hear the same aircraft: keep the newer fix.
            if (!previous || previous.observedAt < entity.observedAt) byId.set(entity.id, entity);
          }
        } catch (error) {
          failures++;
          lastError = error;
          // Told to slow down: ask for nothing more this poll. The hub backs
          // off on the throw below (or on the next poll's, when some regions
          // had already answered and their aircraft are worth keeping).
          if (error instanceof LiveUpstreamError && error.status === 429) break;
        }
      }
      // Nothing answered: that is the source failing, not an empty sky.
      if (failures === attempted) throw lastError;
      const limited =
        lastError instanceof LiveUpstreamError && lastError.status === 429 ? lastError : null;
      return {
        entities: [...byId.values()],
        rejected,
        ...(limited ? { backoffSeconds: limited.retryAfterSeconds ?? 60 } : {}),
      };
    },
  };
}
