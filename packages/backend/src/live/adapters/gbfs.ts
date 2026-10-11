/**
 * Bike-share stations from a GBFS system (v2.x or v3.0).
 *
 *     {url}                      gbfs.json, the auto-discovery document
 *       → station_information    names, positions, capacity — changes rarely
 *       → station_status         availability — polled
 *       → vehicle_types          optional: which vehicles are electric
 *
 * The discovery document and the station information are cached for
 * {@link STATIC_FEED_TTL_MS} (or the feed's own `ttl`, whichever is longer);
 * only `station_status` is fetched on every poll.
 *
 * ## What a station becomes
 *
 * A status row is joined to its information row by `station_id`. A status
 * without information (a station added since the information was cached) is
 * skipped until the next refresh, and counted as rejected.
 *
 *  - `num_bikes_available` → bikes (GBFS counts every rentable vehicle there,
 *    electric included); `num_ebikes_available`, else the electric share of
 *    `vehicle_types_available` per `vehicle_types`, else `null`.
 *  - `is_installed && is_renting` → renting; `is_returning` → returning. GBFS
 *    v2 sends these as booleans or 0/1, both accepted.
 *  - `last_reported` (epoch seconds in v2, RFC 3339 in v3) → `observedAt`;
 *    a station that has not reported for hours is shown STALE by its
 *    source's bound, not hidden and not called current.
 */

import type { LiveBikeshareStation, LiveEntity } from '@goway/contracts';
import { accept, finite, getJson, instant, position, record, text, within } from '../normalise';
import type { LiveAdapter, LiveAdapterSettings, LiveFetchContext, LivePollResult } from '../types';
import { LiveUpstreamError } from '../types';

export const STATIC_FEED_TTL_MS = 60 * 60_000;

export interface GbfsOptions {
  sourceId: string;
  operator: string;
  coverage: { west: number; south: number; east: number; north: number } | null;
  /** The discovery language to prefer; the first one otherwise. */
  language?: string;
}

interface StationInfo {
  name: string;
  latitude: number;
  longitude: number;
  capacity: number | null;
}

function truthy(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

/** `last_reported`: epoch seconds (v2) or an RFC 3339 string (v3). */
function reportedMs(value: unknown): number | null {
  const seconds = finite(value);
  if (seconds !== null) return seconds * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Feed URLs from a discovery document, v2 (`data.<lang>.feeds`) or v3 (`data.feeds`). */
export function discoverFeeds(body: unknown, language = 'en'): Map<string, string> {
  const data = record(record(body)?.data);
  const feeds = new Map<string, string>();
  if (!data) return feeds;
  let list: unknown = data.feeds;
  if (!Array.isArray(list)) {
    const languages = Object.keys(data);
    const chosen = languages.includes(language) ? language : languages[0];
    list = chosen ? record(data[chosen])?.feeds : undefined;
  }
  if (!Array.isArray(list)) return feeds;
  for (const entry of list) {
    const feed = record(entry);
    const name = typeof feed?.name === 'string' ? feed.name : null;
    const url = typeof feed?.url === 'string' ? feed.url : null;
    if (name && url && /^https:\/\//.test(url)) feeds.set(name, url);
  }
  return feeds;
}

function stationsOf(body: unknown): unknown[] {
  const stations = record(record(body)?.data)?.stations;
  return Array.isArray(stations) ? stations : [];
}

/** v2: `name` is a string; v3: `name` is `[{ text, language }]`. */
function stationName(value: unknown): string | null {
  if (typeof value === 'string') return text(value, 120);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const name = text(record(entry)?.text, 120);
      if (name) return name;
    }
  }
  return null;
}

export function parseStationInformation(
  body: unknown,
  coverage: GbfsOptions['coverage'],
): Map<string, StationInfo> {
  const stations = new Map<string, StationInfo>();
  for (const raw of stationsOf(body)) {
    const station = record(raw);
    const id = text(station?.station_id, 80);
    const name = stationName(station?.name);
    const where = position(station?.lat, station?.lon, coverage);
    if (!station || !id || !name || !where) continue;
    stations.set(id, {
      name,
      latitude: where.latitude,
      longitude: where.longitude,
      capacity: within(station.capacity, 0, 10_000),
    });
  }
  return stations;
}

/** Which `vehicle_type_id`s are electric, from `vehicle_types`. */
export function parseElectricTypes(body: unknown): Set<string> {
  const types = record(record(body)?.data)?.vehicle_types;
  const electric = new Set<string>();
  if (!Array.isArray(types)) return electric;
  for (const raw of types) {
    const type = record(raw);
    const id = text(type?.vehicle_type_id, 80);
    const propulsion = typeof type?.propulsion_type === 'string' ? type.propulsion_type : '';
    if (id && propulsion !== '' && propulsion !== 'human') electric.add(id);
  }
  return electric;
}

export function normaliseGbfsStation(
  options: GbfsOptions,
  raw: unknown,
  info: StationInfo | undefined,
  electricTypes: ReadonlySet<string>,
  feedReportedMs: number | null,
  nowMs: number,
): LiveBikeshareStation | null {
  const status = record(raw);
  const id = text(status?.station_id, 80);
  if (!status || !id || !info) return null;
  const bikes = within(status.num_bikes_available, 0, 10_000);
  if (bikes === null || !Number.isInteger(bikes)) return null;
  const docks = within(status.num_docks_available, 0, 10_000);

  let ebikes = within(status.num_ebikes_available, 0, 10_000);
  if (ebikes === null && electricTypes.size > 0 && Array.isArray(status.vehicle_types_available)) {
    ebikes = 0;
    for (const entry of status.vehicle_types_available) {
      const type = record(entry);
      const typeId = text(type?.vehicle_type_id, 80);
      const count = within(type?.count, 0, 10_000);
      if (typeId && count !== null && electricTypes.has(typeId)) ebikes += count;
    }
  }
  if (ebikes !== null && ebikes > bikes) ebikes = null;

  const installed = truthy(status.is_installed) ?? true;
  const renting = (truthy(status.is_renting) ?? false) && installed;
  const returning = (truthy(status.is_returning) ?? false) && installed;
  const observedAt = instant(reportedMs(status.last_reported) ?? feedReportedMs, nowMs);
  if (!observedAt) return null;

  return accept({
    kind: 'bikeshare',
    id: `${options.sourceId}:${id}`,
    sourceId: options.sourceId,
    position: { latitude: info.latitude, longitude: info.longitude },
    headingDegrees: null,
    speedMetersPerSecond: null,
    observedAt,
    operator: options.operator,
    name: info.name,
    bikesAvailable: bikes,
    ebikesAvailable: ebikes === null ? null : Math.round(ebikes),
    docksAvailable: docks === null ? null : Math.round(docks),
    capacity: info.capacity === null ? null : Math.round(info.capacity),
    renting,
    returning,
  }) as LiveBikeshareStation | null;
}

export function createGbfsAdapter(
  options: GbfsOptions,
  settings: LiveAdapterSettings,
): LiveAdapter {
  let feeds: Map<string, string> | null = null;
  let stations: Map<string, StationInfo> | null = null;
  let electric: Set<string> = new Set();
  let staticFetchedAt = 0;

  const headers = { 'user-agent': settings.userAgent };

  async function refreshStatic(context: LiveFetchContext): Promise<void> {
    const discovery = await getJson(context.fetch, settings.url, context.signal, headers);
    const found = discoverFeeds(discovery, options.language);
    const informationUrl = found.get('station_information');
    if (!found.get('station_status') || !informationUrl) {
      throw new LiveUpstreamError('GBFS discovery lists no station_information/station_status');
    }
    const information = parseStationInformation(
      await getJson(context.fetch, informationUrl, context.signal, headers),
      options.coverage,
    );
    if (information.size === 0) throw new LiveUpstreamError('GBFS station_information is empty');
    let types = new Set<string>();
    const typesUrl = found.get('vehicle_types');
    if (typesUrl) {
      try {
        types = parseElectricTypes(await getJson(context.fetch, typesUrl, context.signal, headers));
      } catch {
        // Optional: without it the electric share is `null`, which is honest.
      }
    }
    feeds = found;
    stations = information;
    electric = types;
    staticFetchedAt = context.now();
  }

  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      if (!feeds || !stations || context.now() - staticFetchedAt > STATIC_FEED_TTL_MS) {
        await refreshStatic(context);
      }
      const statusUrl = feeds?.get('station_status');
      if (!statusUrl || !stations) throw new LiveUpstreamError('GBFS feeds not discovered');
      const body = await getJson(context.fetch, statusUrl, context.signal, headers);
      const feedReported = reportedMs(record(body)?.last_updated);
      const entities: LiveEntity[] = [];
      let rejected = 0;
      for (const raw of stationsOf(body)) {
        const id = text(record(raw)?.station_id, 80);
        const station = normaliseGbfsStation(
          options,
          raw,
          id ? stations.get(id) : undefined,
          electric,
          feedReported,
          context.now(),
        );
        if (station) entities.push(station);
        else rejected++;
      }
      return { entities, rejected };
    },
  };
}
