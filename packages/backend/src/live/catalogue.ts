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
const ODBL: LiveSourceDefinition['licence'] = {
  label: 'ODbL 1.0',
  href: 'https://opendatacommons.org/licenses/odbl/1-0/',
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

/**
 * A bike-share system read through GBFS: the one shape every such entry shares,
 * so a system is a handful of facts (where, whose terms, which URL) and not a
 * copy of the adapter wiring. `docs/MAP_LIVE.md` → Sources holds the evidence
 * for each.
 */
interface BikeshareSpec {
  id: string;
  name: string;
  operator: string;
  coverage: GeoBoundingBox;
  attribution: LiveSourceDefinition['attribution'];
  licence: LiveSourceDefinition['licence'];
  /** The `gbfs.json` auto-discovery document. */
  url: string;
  /** The feed's `station_status` cadence; 60 s unless its `ttl` is shorter. */
  pollIntervalSeconds?: number;
  headers?: Readonly<Record<string, string>>;
}

function bikeshare(spec: BikeshareSpec): LiveSourceDefinition {
  return {
    id: spec.id,
    kind: 'bikeshare',
    name: spec.name,
    attribution: spec.attribution,
    licence: spec.licence,
    coverage: spec.coverage,
    completeness: 'network',
    defaultUrl: spec.url,
    requiresKey: false,
    pollIntervalSeconds: spec.pollIntervalSeconds ?? 60,
    staleAfterSeconds: 30 * 60,
    dropAfterSeconds: 24 * 3600,
    create: (settings) =>
      createGbfsAdapter(
        {
          sourceId: spec.id,
          operator: spec.operator,
          coverage: spec.coverage,
          ...(spec.headers ? { headers: spec.headers } : {}),
        },
        settings,
      ),
  };
}

/**
 * The Lyft-operated systems share Citi Bike's Bikeshare Data License Agreement
 * word for word on the clauses that matter (diffed 2026-10-13): the names and
 * marks are the operators', so names and credits stay generic.
 */
function lyftBikeshare(
  spec: Pick<BikeshareSpec, 'id' | 'name' | 'operator' | 'coverage' | 'url'> & {
    agreement: string;
  },
): LiveSourceDefinition {
  return bikeshare({
    ...spec,
    attribution: { label: `${spec.operator} data`, href: spec.agreement },
    licence: { label: 'Bikeshare Data License Agreement', href: spec.agreement },
  });
}

/** JCDecaux's Cyclocity systems, under its Licence Ouverte: the source and the update date are the credit. */
function cyclocity(
  spec: Pick<BikeshareSpec, 'id' | 'name' | 'coverage'> & { contract: string; system: string },
): LiveSourceDefinition {
  return bikeshare({
    id: spec.id,
    name: spec.name,
    operator: spec.system,
    coverage: spec.coverage,
    attribution: {
      label: `Source: JCDecaux / ${spec.system}`,
      href: 'https://developer.jcdecaux.com',
    },
    licence: {
      label: 'Licence Ouverte (JCDecaux)',
      href: 'https://developer.jcdecaux.com/files/Open-Licence-fr.pdf',
    },
    // The v2.3 documents, which is what was measured (2026-10-13).
    url: `https://api.cyclocity.fr/contracts/${spec.contract}/gbfs/gbfs.json`,
    pollIntervalSeconds: 30,
  });
}

/** Urban Sharing's Norwegian systems, under NLOD 2.0; the operator asks for a `Client-Identifier`. */
function urbanSharing(
  spec: Pick<BikeshareSpec, 'id' | 'name' | 'coverage'> & { host: string; system: string },
): LiveSourceDefinition {
  return bikeshare({
    id: spec.id,
    name: spec.name,
    operator: spec.system,
    coverage: spec.coverage,
    attribution: {
      label: `Contains data under the Norwegian licence for Open Government data (NLOD) distributed by ${spec.system}`,
      href: 'https://data.norge.no/nlod/en/2.0',
    },
    licence: { label: 'NLOD 2.0', href: 'https://data.norge.no/nlod/en/2.0' },
    url: `https://gbfs.urbansharing.com/${spec.host}/gbfs.json`,
    pollIntervalSeconds: 30,
    headers: { 'client-identifier': 'goway-live' },
  });
}

const BIKESHARE_SOURCES: readonly LiveSourceDefinition[] = [
  bikeshare({
    id: 'nyc-bikeshare',
    // The licence forbids using the operator's marks: a generic name, by design.
    name: 'Bike share — New York',
    operator: 'NYC bike share',
    coverage: NEW_YORK_CITY,
    attribution: {
      label: 'NYC bike share data',
      href: 'https://citibikenyc.com/data-sharing-policy',
    },
    licence: {
      label: 'Bikeshare Data License Agreement',
      href: 'https://citibikenyc.com/data-sharing-policy',
    },
    url: 'https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json',
  }),
  lyftBikeshare({
    id: 'cabi-bikeshare',
    name: 'Bike share — Washington DC area',
    operator: 'Washington DC area bike share',
    coverage: { west: -77.45, south: 38.7, east: -76.8, north: 39.14 },
    url: 'https://gbfs.capitalbikeshare.com/gbfs/2.3/gbfs.json',
    agreement: 'https://capitalbikeshare.com/data-license-agreement',
  }),
  lyftBikeshare({
    id: 'divvy-bikeshare',
    name: 'Bike share — Chicago',
    operator: 'Chicago bike share',
    coverage: { west: -87.87, south: 41.63, east: -87.5, north: 42.08 },
    url: 'https://gbfs.divvybikes.com/gbfs/2.3/gbfs.json',
    agreement: 'https://divvybikes.com/data-license-agreement',
  }),
  lyftBikeshare({
    id: 'baywheels-bikeshare',
    name: 'Bike share — San Francisco Bay Area',
    operator: 'Bay Area bike share',
    coverage: { west: -122.54, south: 37.29, east: -121.84, north: 37.9 },
    url: 'https://gbfs.lyftbikes.com/gbfs/2.3/gbfs.json',
    agreement: 'https://baywheels-assets.s3.amazonaws.com/data-license-agreement.html',
  }),
  lyftBikeshare({
    id: 'bluebikes-bikeshare',
    name: 'Bike share — Boston area',
    operator: 'Boston area bike share',
    coverage: { west: -71.28, south: 42.23, east: -70.84, north: 42.55 },
    url: 'https://gbfs.bluebikes.com/gbfs/gbfs.json',
    agreement: 'https://www.bluebikes.com/data-license-agreement',
  }),
  cyclocity({
    id: 'valenbisi',
    name: 'Bike share — Valenbisi (Valencia)',
    system: 'Valenbisi',
    contract: 'valence',
    coverage: { west: -0.43, south: 39.44, east: -0.32, north: 39.5 },
  }),
  cyclocity({
    id: 'dublinbikes',
    name: 'Bike share — dublinbikes',
    system: 'dublinbikes',
    contract: 'dublin',
    coverage: { west: -6.32, south: 53.33, east: -6.23, north: 53.36 },
  }),
  cyclocity({
    id: 'villo',
    name: 'Bike share — Villo! (Brussels)',
    system: 'Villo!',
    contract: 'bruxelles',
    coverage: { west: 4.26, south: 50.79, east: 4.47, north: 50.9 },
  }),
  cyclocity({
    id: 'velov',
    name: "Bike share — Vélo'v (Lyon)",
    system: "Vélo'v",
    contract: 'lyon',
    coverage: { west: 4.77, south: 45.69, east: 4.98, north: 45.89 },
  }),
  cyclocity({
    id: 'naolib-velo',
    name: 'Bike share — Naolib vélo (Nantes)',
    system: 'Naolib vélo',
    contract: 'nantes',
    coverage: { west: -1.6, south: 47.18, east: -1.52, north: 47.25 },
  }),
  cyclocity({
    id: 'velotoulouse',
    name: 'Bike share — VélôToulouse',
    system: 'VélôToulouse',
    contract: 'toulouse',
    coverage: { west: 1.0, south: 43.54, east: 1.52, north: 43.67 },
  }),
  cyclocity({
    id: 'veloh',
    name: "Bike share — Vel'OH! (Luxembourg)",
    system: "Vel'OH!",
    contract: 'luxembourg',
    coverage: { west: 5.98, south: 49.56, east: 6.26, north: 49.66 },
  }),
  cyclocity({
    id: 'cyclocity-vilnius',
    name: 'Bike share — Cyclocity (Vilnius)',
    system: 'Cyclocity Vilnius',
    contract: 'vilnius',
    coverage: { west: 25.25, south: 54.67, east: 25.31, north: 54.72 },
  }),
  urbanSharing({
    id: 'oslo-bysykkel',
    name: 'Bike share — Oslo Bysykkel',
    system: 'Oslo Bysykkel',
    host: 'oslobysykkel.no',
    coverage: { west: 10.6, south: 59.88, east: 10.84, north: 59.97 },
  }),
  urbanSharing({
    id: 'bergen-bysykkel',
    name: 'Bike share — Bergen Bysykkel',
    system: 'Bergen Bysykkel',
    host: 'bergenbysykkel.no',
    coverage: { west: 5.26, south: 60.34, east: 5.38, north: 60.43 },
  }),
  urbanSharing({
    id: 'trondheim-bysykkel',
    name: 'Bike share — Trondheim Bysykkel',
    system: 'Trondheim Bysykkel',
    host: 'trondheimbysykkel.no',
    coverage: { west: 10.33, south: 63.38, east: 10.48, north: 63.46 },
  }),
  bikeshare({
    id: 'toronto-bikeshare',
    name: 'Bike share — Toronto',
    operator: 'Toronto bike share',
    coverage: { west: -79.62, south: 43.58, east: -79.1, north: 43.83 },
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – Toronto',
      href: 'https://open.toronto.ca/open-data-licence/',
    },
    licence: {
      label: 'Open Government Licence – Toronto',
      href: 'https://open.toronto.ca/open-data-licence/',
    },
    url: 'https://tor.publicbikesystem.net/ube/gbfs/v1/',
    pollIntervalSeconds: 30,
  }),
  bikeshare({
    id: 'vlille',
    name: "Bike share — V'Lille",
    operator: "V'Lille",
    coverage: { west: 2.97, south: 50.59, east: 3.21, north: 50.75 },
    attribution: {
      label: 'Source: ilévia / Métropole Européenne de Lille',
      href: 'https://www.data.gouv.fr/datasets/ilevia-vlille-disponibilite-en-temps-reel/',
    },
    licence: {
      label: 'Licence Ouverte 2.0',
      href: 'https://www.etalab.gouv.fr/wp-content/uploads/2018/11/open-licence.pdf',
    },
    url: 'https://media.ilevia.fr/opendata/gbfs.json',
  }),
];

/**
 * A whole public-transport network read through GTFS-Realtime and its operator's
 * static GTFS. The mode comes from the static table (`route_type`), because
 * these operators run buses, trams and metro through one feed that does not
 * say which a vehicle is; the adapter's own mode is `other` until that table has
 * loaded, never a guess. `docs/MAP_LIVE.md` → Sources holds the evidence.
 */
interface NetworkSpec {
  id: string;
  name: string;
  operator: string;
  coverage: GeoBoundingBox;
  attribution: LiveSourceDefinition['attribution'];
  licence: LiveSourceDefinition['licence'];
  url: string;
  staticZip: string;
  pollIntervalSeconds: number;
  staleAfterSeconds: number;
  dropAfterSeconds?: number;
  /** Read only the static GTFS's `routes.txt` (a national archive's trips and shapes are gigabytes). */
  routesOnly?: boolean;
  headers?: Readonly<Record<string, string>>;
}

function transitNetwork(spec: NetworkSpec): LiveSourceDefinition {
  return {
    id: spec.id,
    kind: 'transit',
    name: spec.name,
    attribution: spec.attribution,
    licence: spec.licence,
    coverage: spec.coverage,
    completeness: 'network',
    defaultUrl: spec.url,
    requiresKey: false,
    pollIntervalSeconds: spec.pollIntervalSeconds,
    staleAfterSeconds: spec.staleAfterSeconds,
    dropAfterSeconds: spec.dropAfterSeconds ?? 300,
    staticGtfs: { zip: spec.staticZip, ...(spec.routesOnly ? { routesOnly: true } : {}) },
    routesFromStaticGtfs: true,
    create: (settings) =>
      createGtfsRealtimeAdapter(
        {
          sourceId: spec.id,
          operator: spec.operator,
          coverage: spec.coverage,
          defaultMode: 'other',
          ...(spec.headers ? { headers: spec.headers } : {}),
        },
        settings,
      ),
  };
}

const TRANSIT_NETWORKS: readonly LiveSourceDefinition[] = [
  transitNetwork({
    id: 'entur-norway',
    name: 'Buses, trains, trams and ferries — Entur (Norway)',
    operator: 'Entur',
    coverage: { west: 4.0, south: 57.5, east: 31.5, north: 71.5 },
    attribution: {
      label:
        'Contains data under the Norwegian licence for Open Government data (NLOD) distributed by Entur AS',
      href: 'https://data.norge.no/nlod/en/2.0',
    },
    licence: { label: 'NLOD 2.0', href: 'https://data.norge.no/nlod/en/2.0' },
    url: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions',
    // 533 MB of which the 59 KB `routes.txt` is all that is read, by range.
    staticZip:
      'https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_norway-aggregated-gtfs.zip',
    routesOnly: true,
    // Entur asks every consumer to identify itself, and rate-limits those that do not.
    headers: { 'et-client-name': 'oxy-goway' },
    // The feed keeps last-known positions for hours (median age 2.8 h): only the
    // fresh ones are shown, and the rest are dropped rather than drawn stale.
    pollIntervalSeconds: 15,
    staleAfterSeconds: 60,
    dropAfterSeconds: 120,
  }),
  transitNetwork({
    id: 'ovapi-netherlands',
    name: 'Buses, trams, metro and ferries — OVapi (Netherlands)',
    operator: 'OVapi',
    coverage: { west: 3.2, south: 50.7, east: 7.3, north: 53.6 },
    attribution: { label: 'Data: OpenOV (CC0 1.0)', href: 'https://openov.nl' },
    licence: {
      label: 'CC0 1.0',
      href: 'https://creativecommons.org/publicdomain/zero/1.0/',
    },
    url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    staticZip: 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip',
    routesOnly: true,
    // Volunteer-run and asks not to be polled more than about once a minute; the
    // feed itself refreshes every ~12 s, one entry in the feed carries a bogus
    // timestamp, so anything older than `dropAfterSeconds` is dropped.
    pollIntervalSeconds: 30,
    staleAfterSeconds: 60,
    dropAfterSeconds: 120,
  }),
  transitNetwork({
    id: 'ttc-toronto',
    name: 'Buses and streetcars — TTC (Toronto)',
    operator: 'TTC',
    coverage: { west: -79.7, south: 43.55, east: -79.1, north: 43.95 },
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – Toronto',
      href: 'https://open.toronto.ca/open-data-licence/',
    },
    licence: {
      label: 'Open Government Licence – Toronto',
      href: 'https://open.toronto.ca/open-data-licence/',
    },
    url: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    // 83 MB, of which ~13 MB is read by range (routes, trips, shapes, stops).
    staticZip:
      'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/bd4809dd-e289-4de8-bbde-c5c00dafbf4f/resource/28514055-d011-4ed7-8bb0-97961dfe2b66/download/surfacegtfs.zip',
    pollIntervalSeconds: 20,
    staleAfterSeconds: 90,
  }),
  transitNetwork({
    id: 'hsl-helsinki',
    name: 'Buses, trams, metro and ferries — HSL (Helsinki)',
    operator: 'HSL',
    coverage: { west: 22.9, south: 59.8, east: 25.95, north: 60.95 },
    attribution: { label: '© HSL', href: 'https://www.hsl.fi/en/hsl/open-data' },
    licence: CC_BY_4,
    url: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl',
    staticZip: 'https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip',
    // HSL documents a 1 s update; the median vehicle age was 2 s.
    pollIntervalSeconds: 5,
    staleAfterSeconds: 30,
    dropAfterSeconds: 120,
  }),
  transitNetwork({
    id: 'tampere-nysse',
    name: 'Buses and trams — Nysse (Tampere)',
    operator: 'Nysse',
    coverage: { west: 23.3, south: 61.25, east: 24.35, north: 61.72 },
    attribution: {
      label:
        'Source: Tampere Public Transport Realtime API, Tampereen seudun joukkoliikenne, CC BY 4.0',
      href: 'https://data.tampere.fi/data/en_GB/dataset/tampereen-joukkoliikenteen-reaaliaikainen-rajapinta',
    },
    licence: CC_BY_4,
    url: 'https://data.itsfactory.fi/journeys/api/1/gtfs-rt/vehicle-positions',
    staticZip: 'http://data.itsfactory.fi/journeys/files/gtfs/latest/gtfs_tampere.zip',
    pollIntervalSeconds: 10,
    staleAfterSeconds: 45,
    dropAfterSeconds: 180,
  }),
  transitNetwork({
    id: 'montpellier-tam',
    name: 'Trams and buses — TaM (Montpellier)',
    operator: 'TaM',
    coverage: { west: 3.75, south: 43.55, east: 3.97, north: 43.67 },
    attribution: {
      label: 'Source: Montpellier Méditerranée Métropole (TaM), ODbL 1.0',
      href: 'https://transport.data.gouv.fr/datasets/offre-de-transport-tam-en-temps-reel-gtfs-rt-urbain-et-suburbain',
    },
    licence: ODBL,
    url: 'https://gtfsproxy.e-tam.fr/COMMON/VehiclePosition.pb',
    staticZip: 'https://gtfsproxy.e-tam.fr/COMMON/GTFS.zip',
    pollIntervalSeconds: 30,
    staleAfterSeconds: 90,
  }),
  transitNetwork({
    id: 'lehavre-lia',
    name: 'Trams and buses — LIA (Le Havre)',
    operator: 'LIA',
    coverage: { west: 0.05, south: 49.46, east: 0.28, north: 49.56 },
    attribution: {
      label: 'Source: Le Havre Seine Métropole (LIA), ODbL 1.0',
      href: 'https://opendata.transports-lia.fr',
    },
    licence: ODBL,
    url: 'https://opendata.transports-lia.fr/gtfs-rt/VehiclePosition.pb',
    staticZip: 'https://opendata.transports-lia.fr/gtfs/GTFS.zip',
    pollIntervalSeconds: 30,
    staleAfterSeconds: 90,
  }),
  transitNetwork({
    id: 'mbta-boston',
    name: 'Subway, trams, buses and trains — MBTA (Boston)',
    operator: 'MBTA',
    coverage: { west: -71.9, south: 41.78, east: -70.7, north: 42.62 },
    // The agreement forbids the MassDOT / MBTA marks: words only.
    attribution: { label: 'Data: MassDOT / MBTA', href: 'https://www.mbta.com/developers' },
    licence: {
      label: 'MassDOT Developers License Agreement',
      href: 'https://www.mbta.com/developers',
    },
    url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    staticZip: 'https://cdn.mbta.com/MBTA_GTFS.zip',
    pollIntervalSeconds: 15,
    staleAfterSeconds: 60,
  }),
  transitNetwork({
    id: 'kcm-seattle',
    name: 'Buses and trams — King County Metro (Seattle)',
    operator: 'King County Metro',
    coverage: { west: -122.5, south: 47.25, east: -121.95, north: 47.8 },
    // The terms ask for this legend, prominently, word for word.
    attribution: {
      label:
        'Transit scheduling, geographic, and real-time data provided by permission of King County',
      href: 'https://kingcounty.gov/depts/transportation/metro/travel-options/bus/app-center/developer-resources.aspx',
    },
    licence: {
      label: 'King County Transit Data Terms of Use',
      href: 'https://kingcounty.gov/depts/transportation/metro/travel-options/bus/app-center/developer-resources.aspx',
    },
    url: 'https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb',
    staticZip: 'https://metro.kingcounty.gov/GTFS/google_transit.zip',
    pollIntervalSeconds: 30,
    staleAfterSeconds: 120,
  }),
  transitNetwork({
    id: 'adelaide-metro',
    name: 'Buses, trams and trains — Adelaide Metro',
    operator: 'Adelaide Metro',
    coverage: { west: 138.4, south: -35.4, east: 138.95, north: -34.55 },
    attribution: {
      label: 'Adelaide Metro – Department for Infrastructure and Transport, South Australia',
      href: 'https://adelaidemetro.com.au/developer-info',
    },
    licence: {
      label: 'Creative Commons Attribution (Adelaide Metro)',
      href: 'https://adelaidemetro.com.au/developer-info',
    },
    url: 'https://gtfs.adelaidemetro.com.au/v1/realtime/vehicle_positions',
    staticZip: 'https://gtfs.adelaidemetro.com.au/v1/static/latest/google_transit.zip',
    // The page says positions update every 15 s.
    pollIntervalSeconds: 15,
    staleAfterSeconds: 60,
  }),
  transitNetwork({
    id: 'ets-edmonton',
    name: 'Buses and LRT — ETS (Edmonton)',
    operator: 'ETS',
    coverage: { west: -113.75, south: 53.3, east: -113.3, north: 53.67 },
    // The terms ask that onward users get the terms or their URL: the credit links them.
    attribution: {
      label: 'Contains information licensed under the City of Edmonton Open Data Terms of Use',
      href: 'https://www.edmonton.ca/sites/default/files/public-files/assets/Web-version2.1-OpenDataAgreement.pdf',
    },
    licence: {
      label: 'City of Edmonton Open Data Terms of Use',
      href: 'https://www.edmonton.ca/sites/default/files/public-files/assets/Web-version2.1-OpenDataAgreement.pdf',
    },
    url: 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb',
    staticZip: 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip',
    pollIntervalSeconds: 30,
    staleAfterSeconds: 120,
  }),
  transitNetwork({
    id: 'calgary-transit',
    name: 'Buses and CTrain — Calgary Transit',
    operator: 'Calgary Transit',
    coverage: { west: -114.3, south: 50.84, east: -113.88, north: 51.2 },
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – City of Calgary',
      href: 'https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa/',
    },
    licence: {
      label: 'Open Government Licence – City of Calgary',
      href: 'https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa/',
    },
    // Redirects to the protobuf; this feed names a trip and no route, so the line comes from the static GTFS.
    url: 'https://data.calgary.ca/download/am7c-qe3u/application%2Fx-zip-compressed',
    staticZip: 'https://data.calgary.ca/download/npk7-z3bj/application%2Fx-zip-compressed',
    pollIntervalSeconds: 30,
    staleAfterSeconds: 120,
  }),
];

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
  ...TRANSIT_NETWORKS,
  ...BIKESHARE_SOURCES,
];

export const LIVE_SOURCE_IDS: readonly string[] = LIVE_SOURCES.map((source) => source.id);

export function liveSourceDefinition(id: string): LiveSourceDefinition | undefined {
  return LIVE_SOURCES.find((source) => source.id === id);
}
