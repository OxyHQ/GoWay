/**
 * FGC trains from "Geotren", Ferrocarrils de la Generalitat de Catalunya's
 * train-positioning dataset on its Opendatasoft portal.
 *
 *     GET {base}/api/explore/v2.1/catalog/datasets/posicionament-dels-trens
 *           → metas.default.data_processed: when the positions were published
 *     GET {base}/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100
 *           → results: [{ id, lin, geo_point_2d: { lat, lon }, … }]
 *
 * The records carry no time of their own, so every train is dated by the
 * dataset's `data_processed` — the moment FGC published the set — which is
 * the honest bound on how old a position may be (FGC republishes about once a
 * minute). A records answer whose dataset date cannot be read is refused as a
 * whole rather than dated "now".
 *
 * FGC's GTFS-Realtime vehicle-positions file exists on the same portal and is
 * the better long-term source; it served empty bodies when this was written
 * (`docs/MAP_LIVE.md`). The portal allows 5,000 calls per day per IP: a poll is
 * two calls, so the catalogue polls every 60 s (2,880 a day).
 */

import type { LiveEntity, LiveTransitVehicle } from '@goway/contracts';
import { accept, getJson, instant, position, record, text } from '../normalise';
import {
  type LiveAdapter,
  type LiveAdapterSettings,
  type LiveFetchContext,
  type LivePollResult,
  LiveUpstreamError,
} from '../types';

const DATASET = '/api/explore/v2.1/catalog/datasets/posicionament-dels-trens';

export interface GeotrenOptions {
  sourceId: string;
  operator: string;
  coverage: { west: number; south: number; east: number; north: number } | null;
}

/** When the dataset was last published, from its metadata; `null` when unreadable. */
export function geotrenPublishedMs(body: unknown): number | null {
  const stamp = record(record(record(body)?.metas)?.default)?.data_processed;
  if (typeof stamp !== 'string') return null;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normaliseGeotrenTrain(
  options: GeotrenOptions,
  raw: unknown,
  observedAt: string,
): LiveTransitVehicle | null {
  const train = record(raw);
  const id = text(train?.id, 80);
  const point = record(train?.geo_point_2d);
  const where = position(point?.lat, point?.lon, options.coverage);
  if (!train || !id || !where) return null;
  return accept({
    kind: 'transit',
    id: `${options.sourceId}:${id}`,
    sourceId: options.sourceId,
    position: where,
    headingDegrees: null,
    speedMetersPerSecond: null,
    observedAt,
    mode: 'rail',
    operator: options.operator,
    line: text(train.lin, 32),
    // `desti` is a station CODE (`PC`), not a name a rider reads; left out
    // rather than shown as a cryptic headsign.
    headsign: null,
    vehicleLabel: text(train.ut, 40),
  }) as LiveTransitVehicle | null;
}

export function createGeotrenAdapter(
  options: GeotrenOptions,
  settings: LiveAdapterSettings,
): LiveAdapter {
  const headers = { 'user-agent': settings.userAgent };
  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      const published = geotrenPublishedMs(
        await getJson(context.fetch, `${settings.url}${DATASET}`, context.signal, headers),
      );
      const observedAt = instant(published, context.now());
      if (!observedAt)
        throw new LiveUpstreamError('Geotren dataset has no readable publication time');
      const body = record(
        await getJson(
          context.fetch,
          `${settings.url}${DATASET}/records?limit=100`,
          context.signal,
          headers,
        ),
      );
      const results = Array.isArray(body?.results) ? body.results : null;
      if (!results) return { entities: [], rejected: 1 };
      const entities: LiveEntity[] = [];
      let rejected = 0;
      for (const raw of results) {
        const train = normaliseGeotrenTrain(options, raw, observedAt);
        if (train) entities.push(train);
        else rejected++;
      }
      return { entities, rejected };
    },
  };
}
