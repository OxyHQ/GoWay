/**
 * Every real-time feed GoWay knows how to re-serve, with its terms.
 *
 * A source is listed here only after its licence was read and found to allow
 * what GoWay does with it: normalise it and re-serve it, publicly, to every
 * browser viewing the map, from a service that may be commercial. The
 * evidence for each — licence, the decisive sentence of its terms, rate
 * limits, conditions, and the feeds that were REJECTED and why — is
 * `docs/MAP_LIVE.md` → Sources. Adding a source means adding it there first.
 *
 * Being listed is not being on: a deployment turns each one on by id in
 * `LIVE_SOURCES` (`config/live.ts`), and several carry conditions production
 * must meet first (`docs/MAP_LIVE.md` → What production needs).
 *
 * `attribution` is the credit the licence asks for; the client shows it
 * whenever that source's data is drawn (`MapAttribution`). Where a licence
 * forbids using the operator's marks (Citi Bike's), the credit and the name
 * are generic.
 */

import type { GeoBoundingBox } from '@goway/contracts';
import { createArrivalEstimateAdapter } from './adapters/arrivalEstimates';
import { createDigitrafficAdapter } from './adapters/digitraffic';
import { createGbfsAdapter } from './adapters/gbfs';
import { createGeotrenAdapter } from './adapters/geotren';
import { createGtfsRealtimeAdapter } from './adapters/gtfsRealtime';
import { createReadsbAdapter } from './adapters/readsb';
import type { LiveSourceDefinition } from './types';

/** Spain, mainland and Balearics: Renfe's Cercanías/Rodalies networks. */
const SPAIN: GeoBoundingBox = { west: -9.6, south: 35.8, east: 4.6, north: 44.0 };
/** Catalonia: FGC's lines. */
const CATALONIA: GeoBoundingBox = { west: 0.1, south: 40.5, east: 3.4, north: 42.9 };
/** New York City and its bike-share service area (Jersey City, Hoboken). */
const NEW_YORK_CITY: GeoBoundingBox = { west: -74.3, south: 40.45, east: -73.65, north: 40.95 };
/** The MTA's railroads: Long Island to the Hudson Valley and Connecticut. */
const NEW_YORK_REGION: GeoBoundingBox = { west: -74.5, south: 40.4, east: -71.8, north: 41.9 };
/** The Àrea Metropolitana de Barcelona's bus network. */
const AMB_AREA: GeoBoundingBox = { west: 1.7, south: 41.2, east: 2.45, north: 41.65 };
/** The Comunidad de Madrid. */
const MADRID_REGION: GeoBoundingBox = { west: -4.6, south: 39.85, east: -3.05, north: 41.2 };

/** Spain's national access point licence: its credit is required on every use. */
const MITRAMS_CREDIT: LiveSourceDefinition['attribution'] = {
  label: 'Powered by MITRAMS',
  href: 'https://nap.transportes.gob.es',
};
const NAP_LICENCE: LiveSourceDefinition['licence'] = {
  label: 'NAP open data licence',
  href: 'https://nap.transportes.gob.es/licencia-datos',
};

/** The Baltic Sea and the Gulf of Finland, where Finland's AIS network hears ships. */
const BALTIC: GeoBoundingBox = { west: 9.0, south: 53.0, east: 31.0, north: 66.5 };

const CC_BY_4: LiveSourceDefinition['licence'] = {
  label: 'CC BY 4.0',
  href: 'https://creativecommons.org/licenses/by/4.0/',
};
const MTA_TERMS: LiveSourceDefinition['licence'] = {
  label: 'MTA data feed terms',
  href: 'https://www.mta.info/developers/terms-and-conditions',
};

/** Renfe's `vehicle.label` is `<line>-<train>[-PLATF.(n)]`: the line is the first part. */
function renfeLine(label: string | undefined): string | null {
  const line = label?.split('-')[0]?.trim();
  return line && /^[A-Z][A-Z0-9]{0,5}$/i.test(line) ? line : null;
}

/** Renfe's train number, without the line and the platform suffix. */
function renfeTrain(label: string | undefined): string | null {
  const train = label?.split('-')[1]?.trim();
  return train && /^\d{2,6}$/.test(train) ? train : null;
}

/** Bus Time's vehicle ids are `<agency>_<fleet number>`: riders read the number. */
function mtaBusNumber(vehicleId: string | undefined): string | null {
  const number = vehicleId?.split('_').pop()?.trim();
  return number && /^\d{1,6}$/.test(number) ? number : null;
}

export const LIVE_SOURCES: readonly LiveSourceDefinition[] = [
  {
    id: 'adsb-lol',
    kind: 'aircraft',
    name: 'Aircraft — adsb.lol',
    attribution: { label: '© adsb.lol contributors', href: 'https://adsb.lol' },
    licence: { label: 'ODbL 1.0', href: 'https://opendatacommons.org/licenses/odbl/1-0/' },
    coverage: null,
    completeness: 'partial',
    defaultUrl: 'https://api.adsb.lol',
    requiresKey: false,
    // Per poll at most `LIVE_MAX_REGIONS_PER_POLL` circles, one request each,
    // sequentially, stopping at the first 429. The aggregator's limit is
    // "dynamic"; measured from one IP on 2026-10-11, polling every 10 s drew a
    // 429 about once a minute, so this is kept at 15 s.
    pollIntervalSeconds: 15,
    partialPolls: true,
    staleAfterSeconds: 45,
    dropAfterSeconds: 120,
    create: (settings) => createReadsbAdapter('adsb-lol', settings),
  },
  {
    id: 'renfe-cercanias',
    kind: 'transit',
    name: 'Trains — Renfe Cercanías and Rodalies',
    attribution: { label: 'Origen de los datos: Renfe Operadora', href: 'https://data.renfe.com' },
    licence: CC_BY_4,
    coverage: SPAIN,
    completeness: 'network',
    defaultUrl: 'https://gtfsrt.renfe.com/vehicle_positions.pb',
    requiresKey: false,
    // Renfe republishes every 20 s.
    pollIntervalSeconds: 20,
    staleAfterSeconds: 120,
    dropAfterSeconds: 600,
    // The same open-data portal and licence (CC BY 4.0, `horarios-cercanias`):
    // line colours, and the shapes trains are drawn along. Realtime trip ids
    // are its `trips.txt` ids (215 of 215 matched, 2026-10-11).
    staticGtfs: { zip: 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip' },
    create: (settings) =>
      createGtfsRealtimeAdapter(
        {
          sourceId: 'renfe-cercanias',
          operator: 'Renfe',
          coverage: SPAIN,
          defaultMode: 'rail',
          lineOf: (vehicle) => renfeLine(vehicle.vehicleLabel),
          labelOf: (vehicle) => renfeTrain(vehicle.vehicleLabel),
        },
        settings,
      ),
  },
  {
    id: 'fgc-geotren',
    kind: 'transit',
    name: 'Trains — FGC (Catalonia)',
    attribution: {
      label: 'Ferrocarrils de la Generalitat de Catalunya',
      href: 'https://dadesobertes.fgc.cat',
    },
    licence: CC_BY_4,
    coverage: CATALONIA,
    completeness: 'network',
    defaultUrl: 'https://dadesobertes.fgc.cat',
    requiresKey: false,
    // Two calls per poll against a 5,000-a-day quota; FGC republishes about once a minute.
    pollIntervalSeconds: 60,
    staleAfterSeconds: 180,
    dropAfterSeconds: 600,
    // FGC's GTFS on the same portal (CC BY 4.0), as separate files.
    staticGtfs: {
      routes:
        'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/gtfs_zip/files/92c45d9df99624d7e05e9ade35ba0ce8',
      trips:
        'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/gtfs_zip/files/7831854a320cbf4ea5b6b327cd4581af',
      shapes:
        'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/gtfs_zip/files/fab955344340f299bfeaacaf424537c5',
    },
    create: (settings) =>
      createGeotrenAdapter(
        { sourceId: 'fgc-geotren', operator: 'FGC', coverage: CATALONIA },
        settings,
      ),
  },
  {
    id: 'mta-bus',
    kind: 'transit',
    name: 'Buses — MTA Bus Time (New York)',
    attribution: { label: 'Data: MTA', href: 'https://bustime.mta.info' },
    licence: MTA_TERMS,
    coverage: NEW_YORK_CITY,
    completeness: 'network',
    defaultUrl: 'https://gtfsrt.prod.obanyc.com/vehiclePositions',
    // Documented as required, answered without one when this was written: a
    // configured key is always sent, and production registers one.
    requiresKey: false,
    pollIntervalSeconds: 15,
    staleAfterSeconds: 120,
    dropAfterSeconds: 600,
    // The MTA's own static GTFS (same terms), one zip per borough plus MTA
    // Bus Company; shapes per trip, or per route for trips not listed.
    staticGtfs: {
      zips: ['m', 'b', 'bx', 'q', 'si', 'busco'].map(
        (part) => `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_${part}.zip`,
      ),
    },
    create: (settings) =>
      createGtfsRealtimeAdapter(
        {
          sourceId: 'mta-bus',
          operator: 'MTA',
          coverage: NEW_YORK_CITY,
          defaultMode: 'bus',
          labelOf: (vehicle) => mtaBusNumber(vehicle.vehicleId),
          keyQueryParameter: 'key',
        },
        settings,
      ),
  },
  {
    id: 'mta-lirr',
    kind: 'transit',
    name: 'Trains — Long Island Rail Road',
    attribution: { label: 'Data: MTA', href: 'https://www.mta.info/developers' },
    licence: MTA_TERMS,
    coverage: NEW_YORK_REGION,
    completeness: 'network',
    defaultUrl: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr',
    requiresKey: false,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 180,
    dropAfterSeconds: 600,
    staticGtfs: { zip: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip' },
    create: (settings) =>
      createGtfsRealtimeAdapter(
        { sourceId: 'mta-lirr', operator: 'LIRR', coverage: NEW_YORK_REGION, defaultMode: 'rail' },
        settings,
      ),
  },
  {
    id: 'mta-mnr',
    kind: 'transit',
    name: 'Trains — Metro-North Railroad',
    attribution: { label: 'Data: MTA', href: 'https://www.mta.info/developers' },
    licence: MTA_TERMS,
    coverage: NEW_YORK_REGION,
    completeness: 'network',
    defaultUrl: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr',
    requiresKey: false,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 180,
    dropAfterSeconds: 600,
    staticGtfs: { zip: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip' },
    create: (settings) =>
      createGtfsRealtimeAdapter(
        {
          sourceId: 'mta-mnr',
          operator: 'Metro-North',
          coverage: NEW_YORK_REGION,
          defaultMode: 'rail',
        },
        settings,
      ),
  },
  {
    // New York's subway runs underground and publishes no coordinates: its
    // trains are ESTIMATED along their line from the MTA's own arrival
    // predictions, and drawn as estimates (`adapters/arrivalEstimates.ts`).
    id: 'mta-subway',
    kind: 'transit',
    name: 'Subway — MTA (New York), estimated',
    attribution: { label: 'Data: MTA', href: 'https://www.mta.info/developers' },
    licence: MTA_TERMS,
    coverage: NEW_YORK_CITY,
    completeness: 'network',
    defaultUrl: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
    requiresKey: false,
    pollIntervalSeconds: 30,
    staleAfterSeconds: 120,
    dropAfterSeconds: 300,
    staticGtfs: { zip: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip' },
    create: (settings) =>
      createArrivalEstimateAdapter(
        {
          sourceId: 'mta-subway',
          operator: 'MTA',
          defaultMode: 'subway',
          // The eight feeds the subway is split over; the configured URL is the 1–7 one.
          urls: [
            settings.url,
            ...['ace', 'bdfm', 'g', 'jz', 'nqrw', 'l', 'si'].map(
              (feed) =>
                `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-${feed}`,
            ),
          ],
          // Realtime ids are `<origin time>_<route>..<direction><pattern>`; the
          // part after the first `_` is the static shape id (`1..S03R`).
          shapeIdOf: (tripId) => tripId.split('_').slice(1).join('_') || null,
        },
        settings,
      ),
  },
  {
    // AMB publishes arrival predictions for its metropolitan buses (Nitbus
    // included), no positions: estimated, like the subway. Not TMB's city
    // buses, which publish nothing keyless (`docs/MAP_LIVE.md`).
    id: 'amb-bus',
    kind: 'transit',
    name: 'Buses — AMB (Barcelona area), estimated',
    attribution: { label: 'Font: AMB', href: 'https://www.ambmobilitat.cat' },
    licence: {
      label: 'Reuse under Llei 37/2007',
      href: 'https://www.amb.cat/web/area-metropolitana/dades-obertes/condicions-d-us',
    },
    coverage: AMB_AREA,
    completeness: 'partial',
    defaultUrl: 'https://www.ambmobilitat.cat/transit/trips-updates/trips.bin',
    requiresKey: false,
    // The feed updates every 30 s.
    pollIntervalSeconds: 30,
    staleAfterSeconds: 120,
    dropAfterSeconds: 300,
    staticGtfs: { zip: 'https://www.ambmobilitat.cat/OpenData/google_transit.zip' },
    create: (settings) =>
      createArrivalEstimateAdapter(
        { sourceId: 'amb-bus', operator: 'AMB', defaultMode: 'bus', urls: [settings.url] },
        settings,
      ),
  },
  {
    // Real GPS positions of an interurban operator in the Comunidad de Madrid.
    // Its ids do not join to the regional GTFS, so its buses are shown where
    // reported, as approximate (no track).
    id: 'aisa-bus',
    kind: 'transit',
    name: 'Buses — AISA (Madrid region)',
    attribution: MITRAMS_CREDIT,
    licence: NAP_LICENCE,
    coverage: MADRID_REGION,
    completeness: 'partial',
    defaultUrl: 'http://gtfs-rt-crtm.aisa-grupo.net:8080/GTFS-RT/vehiculosPosicion',
    requiresKey: false,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 120,
    dropAfterSeconds: 600,
    create: (settings) =>
      createGtfsRealtimeAdapter(
        { sourceId: 'aisa-bus', operator: 'AISA', coverage: MADRID_REGION, defaultMode: 'bus' },
        settings,
      ),
  },
  {
    // EMT Fuenlabrada: real GPS positions and a keyless static GTFS with shapes.
    id: 'emt-fuenlabrada',
    kind: 'transit',
    name: 'Buses — EMT Fuenlabrada (Madrid region)',
    attribution: MITRAMS_CREDIT,
    licence: NAP_LICENCE,
    coverage: MADRID_REGION,
    completeness: 'partial',
    defaultUrl:
      'https://api.control.optibus.co/opendata/v1/gtfs-rt/vehicle-positions?uid=c-5cfcd2d1',
    requiresKey: false,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 120,
    dropAfterSeconds: 600,
    staticGtfs: { zip: 'https://api.control.optibus.co/opendata/v1/gtfs?uid=c-5cfcd2d1' },
    create: (settings) =>
      createGtfsRealtimeAdapter(
        {
          sourceId: 'emt-fuenlabrada',
          operator: 'EMT Fuenlabrada',
          coverage: MADRID_REGION,
          defaultMode: 'bus',
        },
        settings,
      ),
  },
  {
    id: 'nyc-bikeshare',
    kind: 'bikeshare',
    // The licence forbids using the operator's marks: a generic name, by design.
    name: 'Bike share — New York',
    attribution: {
      label: 'NYC bike share data',
      href: 'https://citibikenyc.com/data-sharing-policy',
    },
    licence: {
      label: 'Bikeshare Data License Agreement',
      href: 'https://citibikenyc.com/data-sharing-policy',
    },
    coverage: NEW_YORK_CITY,
    completeness: 'network',
    defaultUrl: 'https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json',
    requiresKey: false,
    // GBFS `ttl` is 60 s.
    pollIntervalSeconds: 60,
    staleAfterSeconds: 30 * 60,
    dropAfterSeconds: 24 * 3600,
    create: (settings) =>
      createGbfsAdapter(
        { sourceId: 'nyc-bikeshare', operator: 'NYC bike share', coverage: NEW_YORK_CITY },
        settings,
      ),
  },
  {
    id: 'digitraffic-ais',
    kind: 'vessel',
    name: 'Ships — Digitraffic AIS (Finland)',
    attribution: {
      label: 'Source: Fintraffic / digitraffic.fi, CC 4.0 BY',
      href: 'https://www.digitraffic.fi/en/',
    },
    licence: CC_BY_4,
    coverage: BALTIC,
    completeness: 'partial',
    defaultUrl: 'https://meri.digitraffic.fi',
    requiresKey: false,
    // Responses are cached for 60 s upstream; 30 s keeps moving ships smooth
    // without asking for the same snapshot four times.
    pollIntervalSeconds: 30,
    staleAfterSeconds: 6 * 60,
    dropAfterSeconds: 15 * 60,
    create: (settings) =>
      createDigitrafficAdapter(
        { sourceId: 'digitraffic-ais', coverage: BALTIC, windowSeconds: 15 * 60 },
        settings,
      ),
  },
];

export const LIVE_SOURCE_IDS: readonly string[] = LIVE_SOURCES.map((source) => source.id);

export function liveSourceDefinition(id: string): LiveSourceDefinition | undefined {
  return LIVE_SOURCES.find((source) => source.id === id);
}
