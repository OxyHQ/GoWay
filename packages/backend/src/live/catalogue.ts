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

import { derivedCoverage } from './areas';
import type { GeoBoundingBox } from '@goway/contracts';
import { createArrivalEstimateAdapter } from './adapters/arrivalEstimates';
import { createCombinedAdapter } from './adapters/combined';
import { LIVE_PROVIDERS, providerSource } from './providers';
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

/**
 * Each source's coverage, derived from its operator's stops (`areas.ts`);
 * the hand-drawn boxes above stand until `live:areas` has derived one.
 */
const RENFE_CERCANIAS_COVERAGE = derivedCoverage('renfe-cercanias', SPAIN);
const FGC_GEOTREN_COVERAGE = derivedCoverage('fgc-geotren', CATALONIA);
const MTA_BUS_COVERAGE = derivedCoverage('mta-bus', NEW_YORK_CITY);
const MTA_LIRR_COVERAGE = derivedCoverage('mta-lirr', NEW_YORK_REGION);
const MTA_MNR_COVERAGE = derivedCoverage('mta-mnr', NEW_YORK_REGION);
const MTA_SUBWAY_COVERAGE = derivedCoverage('mta-subway', NEW_YORK_CITY);
const AMB_BUS_COVERAGE = derivedCoverage('amb-bus', AMB_AREA);
const EMT_FUENLABRADA_COVERAGE = derivedCoverage('emt-fuenlabrada', MADRID_REGION);
const NYC_BIKESHARE_COVERAGE = derivedCoverage('nyc-bikeshare', NEW_YORK_CITY);

const CC_BY_4: LiveSourceDefinition['licence'] = {
  label: 'CC BY 4.0',
  href: 'https://creativecommons.org/licenses/by/4.0/',
};
const MTA_TERMS: LiveSourceDefinition['licence'] = {
  label: 'MTA data feed terms',
  href: 'https://www.mta.info/developers/terms-and-conditions',
};

/** Renfe's `vehicle.label` is `<line>-<train>[-PLATF.(n)]`: the line is the first part. */
/** Renfe's high-speed, long-distance and Media Distancia trains (CC BY 4.0, data.renfe.com). */
const RENFE_LD_REALTIME = 'https://gtfsrt.renfe.com/vehicle_positions_LD.pb';
const RENFE_LD_STATIC = 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip';

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
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://www.adsb.lol/docs/open-data/api/',
      quote: 'The license for the API as well as all data ADSB.lol makes public is ODbL',
    },
    defaultUrl: 'https://api.adsb.lol',
    requiresKey: false,
    // The operator asks production users to get in touch first (docs/MAP_LIVE.md → adsb.lol).
    awaiting: "adsb.lol's answer to GoWay's production-use email",
    // Per poll at most `LIVE_POLICY.maxRegionsPerPoll` circles, one request each,
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
    // Its routes name replacement and connecting buses beside the trains.
    transitModes: ['bus', 'rail'],
    name: 'Trains — Renfe (Rodalies, Cercanías, regional and long distance)',
    attribution: { label: 'Origen de los datos: Renfe Operadora', href: 'https://data.renfe.com' },
    licence: CC_BY_4,
    coverage: RENFE_CERCANIAS_COVERAGE,
    completeness: 'network',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://data.renfe.com/dataset/ubicacion-vehiculos',
      quote:
        'license_id CC-BY-4.0 on both datasets (ubicacion-vehiculos, posicion-vehiculos-av-ld-md); its conditions "permiten la reutilización … para fines comerciales y no comerciales"',
    },
    defaultUrl: 'https://gtfsrt.renfe.com/vehicle_positions.pb',
    requiresKey: false,
    // Renfe republishes every 20 s (the long-distance feed every ~15 s).
    pollIntervalSeconds: 20,
    staleAfterSeconds: 120,
    dropAfterSeconds: 600,
    // The same open-data portal and licence (CC BY 4.0): the Cercanías file
    // (`horarios-cercanias`: all Rodalies lines, regional ones included —
    // R11–R17, RT1–2, RG1, RL3–4 — with shapes) and the high-speed,
    // long-distance and Media Distancia file (route names, no shapes).
    // Realtime trip ids are their `trips.txt` ids.
    departures: {},
    staticGtfs: {
      zips: [
        'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
        RENFE_LD_STATIC,
      ],
    },
    create: (settings) =>
      createCombinedAdapter(
        [
          createGtfsRealtimeAdapter(
            {
              sourceId: 'renfe-cercanias',
              operator: 'Renfe',
              coverage: RENFE_CERCANIAS_COVERAGE,
              defaultMode: 'rail',
              lineOf: (vehicle) => renfeLine(vehicle.vehicleLabel),
              labelOf: (vehicle) => renfeTrain(vehicle.vehicleLabel),
            },
            settings,
          ),
          // AVE, Alvia, Avant, Euromed, Media Distancia and regional trains
          // (`posicion-vehiculos-av-ld-md`, CC BY 4.0). Its line comes from the
          // static file's route name; its label is the train number.
          createGtfsRealtimeAdapter(
            {
              sourceId: 'renfe-cercanias',
              operator: 'Renfe',
              coverage: RENFE_CERCANIAS_COVERAGE,
              defaultMode: 'rail',
              routeIdIsLine: false,
              labelOf: (vehicle) => vehicle.vehicleLabel ?? vehicle.vehicleId ?? null,
              idPrefix: 'ld-',
            },
            { ...settings, url: RENFE_LD_REALTIME },
          ),
        ],
        // A Rodalies regional train is in both feeds: one train, drawn once
        // (the commuter feed's, which carries its line and its track).
        (entity) =>
          entity.kind === 'transit' && entity.vehicleLabel
            ? `train:${entity.vehicleLabel}`
            : entity.id,
      ),
  },
  {
    id: 'fgc-geotren',
    kind: 'transit',
    // Its routes: the railways, the Vallès metro lines, the rack railways and
    // funiculars, and connecting buses.
    transitModes: ['bus', 'cable', 'rail', 'subway'],
    name: 'Trains — FGC (Catalonia)',
    attribution: {
      label: 'Ferrocarrils de la Generalitat de Catalunya',
      href: 'https://dadesobertes.fgc.cat',
    },
    licence: CC_BY_4,
    coverage: FGC_GEOTREN_COVERAGE,
    completeness: 'network',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://dadesobertes.fgc.cat/explore/dataset/posicionament-dels-trens/information/',
      quote: 'Dataset licence: CC BY 4.0 (posicionament-dels-trens)',
    },
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
    transitModes: ['bus'],
    name: 'Buses — MTA Bus Time (New York)',
    attribution: { label: 'Data: MTA', href: 'https://bustime.mta.info' },
    licence: MTA_TERMS,
    coverage: MTA_BUS_COVERAGE,
    completeness: 'network',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://www.mta.info/developers/terms-and-conditions',
      quote:
        'MTA hereby authorizes you to download and host the data on a non-MTA server … and to make the data available to others',
    },
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
          coverage: MTA_BUS_COVERAGE,
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
    transitModes: ['rail'],
    name: 'Trains — Long Island Rail Road',
    attribution: { label: 'Data: MTA', href: 'https://www.mta.info/developers' },
    licence: MTA_TERMS,
    coverage: MTA_LIRR_COVERAGE,
    completeness: 'network',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://www.mta.info/developers/terms-and-conditions',
      quote:
        'MTA hereby authorizes you to download and host the data on a non-MTA server … and to make the data available to others',
    },
    defaultUrl: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr',
    requiresKey: false,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 180,
    dropAfterSeconds: 600,
    departures: {},
    staticGtfs: { zip: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip' },
    create: (settings) =>
      createGtfsRealtimeAdapter(
        {
          sourceId: 'mta-lirr',
          operator: 'LIRR',
          coverage: MTA_LIRR_COVERAGE,
          defaultMode: 'rail',
        },
        settings,
      ),
  },
  {
    id: 'mta-mnr',
    kind: 'transit',
    transitModes: ['rail'],
    name: 'Trains — Metro-North Railroad',
    attribution: { label: 'Data: MTA', href: 'https://www.mta.info/developers' },
    licence: MTA_TERMS,
    coverage: MTA_MNR_COVERAGE,
    completeness: 'network',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://www.mta.info/developers/terms-and-conditions',
      quote:
        'MTA hereby authorizes you to download and host the data on a non-MTA server … and to make the data available to others',
    },
    defaultUrl: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr',
    requiresKey: false,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 180,
    dropAfterSeconds: 600,
    departures: {},
    staticGtfs: { zip: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip' },
    create: (settings) =>
      createGtfsRealtimeAdapter(
        {
          sourceId: 'mta-mnr',
          operator: 'Metro-North',
          coverage: MTA_MNR_COVERAGE,
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
    // The Staten Island Railway is in the subway's feed, as rail.
    transitModes: ['rail', 'subway'],
    name: 'Subway — MTA (New York), estimated',
    attribution: { label: 'Data: MTA', href: 'https://www.mta.info/developers' },
    licence: MTA_TERMS,
    coverage: MTA_SUBWAY_COVERAGE,
    completeness: 'network',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://www.mta.info/developers/terms-and-conditions',
      quote:
        'MTA hereby authorizes you to download and host the data on a non-MTA server … and to make the data available to others',
    },
    defaultUrl: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
    requiresKey: false,
    pollIntervalSeconds: 30,
    staleAfterSeconds: 120,
    dropAfterSeconds: 300,
    departures: {},
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
    transitModes: ['bus'],
    name: 'Buses — AMB (Barcelona area), estimated',
    attribution: { label: 'Font: AMB', href: 'https://www.ambmobilitat.cat' },
    licence: {
      label: 'Reuse under Llei 37/2007',
      href: 'https://www.amb.cat/web/area-metropolitana/dades-obertes/condicions-d-us',
    },
    coverage: AMB_BUS_COVERAGE,
    completeness: 'partial',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source:
        'https://www.amb.cat/web/area-metropolitana/dades-obertes/cataleg/detall/-/dataset/gtfs-real-time-bus-service/6332347/11692',
      quote:
        "Licence: Autorització segons Llei 37/2007 — Autorització lliure i gratuïta de reutilització de la informació pública segons la Llei 37/2007 … Que se'n citi la font … Que s'esmenti la data de l'última actualització",
    },
    defaultUrl: 'https://www.ambmobilitat.cat/transit/trips-updates/trips.bin',
    requiresKey: false,
    // The feed updates every 30 s.
    pollIntervalSeconds: 30,
    staleAfterSeconds: 120,
    dropAfterSeconds: 300,
    departures: { realtimeUrls: (settings) => [settings.url] },
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
    transitModes: ['bus'],
    name: 'Buses — AISA (Madrid region)',
    attribution: MITRAMS_CREDIT,
    licence: NAP_LICENCE,
    coverage: MADRID_REGION,
    completeness: 'partial',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://nap.transportes.gob.es/licencia-datos',
      quote:
        'Las presentes condiciones generales definidas en esta licencia permiten la reutilización de los documentos sometidos a ellas para fines comerciales y no comerciales',
    },
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
    transitModes: ['bus'],
    name: 'Buses — EMT Fuenlabrada (Madrid region)',
    attribution: MITRAMS_CREDIT,
    licence: NAP_LICENCE,
    coverage: EMT_FUENLABRADA_COVERAGE,
    completeness: 'partial',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://nap.transportes.gob.es/licencia-datos',
      quote:
        'Las presentes condiciones generales definidas en esta licencia permiten la reutilización de los documentos sometidos a ellas para fines comerciales y no comerciales',
    },
    defaultUrl:
      'https://api.control.optibus.co/opendata/v1/gtfs-rt/vehicle-positions?uid=c-5cfcd2d1',
    requiresKey: false,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 120,
    dropAfterSeconds: 600,
    departures: {},
    staticGtfs: { zip: 'https://api.control.optibus.co/opendata/v1/gtfs?uid=c-5cfcd2d1' },
    create: (settings) =>
      createGtfsRealtimeAdapter(
        {
          sourceId: 'emt-fuenlabrada',
          operator: 'EMT Fuenlabrada',
          coverage: EMT_FUENLABRADA_COVERAGE,
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
    coverage: NYC_BIKESHARE_COVERAGE,
    completeness: 'network',
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://citibikenyc.com/data-sharing-policy',
      quote:
        'Bikeshare hereby grants to you a non-exclusive, royalty-free … license to … distribute in your product or service and use the Data for any lawful purpose',
    },
    defaultUrl: 'https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json',
    requiresKey: false,
    // Whether a public map is a "stand-alone dataset" distribution is Lyft's question.
    awaiting: "Lyft's answer on the Bikeshare Data License's stand-alone clause",
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
    licenceCheck: {
      verifiedOn: '2026-10-11',
      source: 'https://www.digitraffic.fi/en/terms-of-service/',
      quote:
        'It gives the right to distribute, remix, tweak, and build upon our data, even commercially, as long as you credit the source for the original creation.',
    },
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
  // Every provider around the world, by standard (`providers.ts`).
  ...LIVE_PROVIDERS.map(providerSource),
];

export const LIVE_SOURCE_IDS: readonly string[] = LIVE_SOURCES.map((source) => source.id);

export function liveSourceDefinition(id: string): LiveSourceDefinition | undefined {
  return LIVE_SOURCES.find((source) => source.id === id);
}
