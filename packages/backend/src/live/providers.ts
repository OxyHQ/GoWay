/**
 * Real-time providers around the world, as DATA: one entry per feed, built
 * into a source by ONE adapter per standard — GTFS-Realtime vehicle
 * positions, GTFS-Realtime trip updates (estimated along the line), GBFS for
 * bike share, SIRI-VM — never per-city code.
 *
 * Seeded from the Mobility Database catalog (MobilityData, `feeds_v2.csv`)
 * and the providers' own portals. An entry is here ONLY when its licence was
 * read and allows public, commercial redistribution: `licenceCheck` records
 * the day, the page and the words (`licence.test.ts` refuses an entry
 * without them). A keyed feed names where the owner registers
 * (`keyRegistrationUrl`); it stays off until its key is configured.
 *
 * Every entry is demand-driven like the rest of the catalogue: polled by one
 * task (the lease holder) and only while somebody watches its coverage, at an
 * interval within the provider's published limits.
 */
import type { GeoBoundingBox, LiveKind, LiveTransitMode } from '@goway/contracts';
import { createArrivalEstimateAdapter } from './adapters/arrivalEstimates';
import { derivedCoverage } from './areas';
import { createGbfsAdapter } from './adapters/gbfs';
import { createGtfsRealtimeAdapter } from './adapters/gtfsRealtime';
import { createSiriVmAdapter } from './adapters/siriVm';
import type { StaticGtfsLocation } from './staticGtfs';
import type { LiveSourceDefinition } from './types';

export type LiveProviderFormat = 'gtfs-rt-vp' | 'gtfs-rt-tu' | 'gbfs' | 'siri-vm';

export type LiveProviderAuth =
  | { kind: 'none' }
  /** The key as a query parameter (`?key=…`). */
  | { kind: 'query'; parameter: string; registrationUrl: string }
  /** The key as a request header (`Authorization`, `x-api-key`…). */
  | { kind: 'header'; header: string; prefix?: string; registrationUrl: string };

export interface LiveProvider {
  /** The source id (`LIVE_SOURCES`), lower-case, `<place>-<operator>`. */
  id: string;
  /** For the coverage table: city or region, and country. */
  place: string;
  country: string;
  name: string;
  operator: string;
  kind: LiveKind;
  format: LiveProviderFormat;
  url: string;
  defaultMode: LiveTransitMode;
  coverage: GeoBoundingBox;
  completeness: 'network' | 'partial';
  attribution: { label: string; href: string };
  licence: { label: string; href: string };
  licenceCheck: { verifiedOn: string; source: string; quote: string };
  auth: LiveProviderAuth;
  /** Seconds between polls while watched — within the provider's limits. */
  pollIntervalSeconds: number;
  /** Required for `gtfs-rt-tu` (stops and shapes to estimate along); optional otherwise. */
  staticGtfs?: StaticGtfsLocation;
  /** Extra headers a provider asks callers to send (Entur's `ET-Client-Name`). */
  headers?: Record<string, string>;
  /**
   * The feed's route ids are what riders call the line (`BOLT`, `9B`). Otherwise
   * the line comes only from the static GTFS — a route id like `100001` or
   * `OST:Line:1_400` is never shown as one.
   */
  routeIdIsLine?: boolean;
  /** What is still open outside the code (`LiveSourceDefinition.awaiting`). */
  awaiting?: string;
}

/** The ones every mode shares. */
const STALE_SECONDS = 120;
const DROP_SECONDS = 600;

/** A provider entry as a catalogue source. */
export function providerSource(provider: LiveProvider): LiveSourceDefinition {
  const { auth } = provider;
  const keyed = auth.kind !== 'none';
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    attribution: provider.attribution,
    licence: provider.licence,
    licenceCheck: provider.licenceCheck,
    // Derived from its stops where they are published (`areas.ts`).
    coverage: derivedCoverage(provider.id, provider.coverage),
    completeness: provider.completeness,
    // A feed that names one mode carries only it; `other` may carry any.
    ...(provider.kind === 'transit' && provider.defaultMode !== 'other'
      ? { transitModes: [provider.defaultMode] }
      : {}),
    defaultUrl: provider.url,
    requiresKey: keyed,
    ...(keyed ? { keyRegistrationUrl: auth.registrationUrl } : {}),
    ...(provider.awaiting ? { awaiting: provider.awaiting } : {}),
    pollIntervalSeconds: provider.pollIntervalSeconds,
    staleAfterSeconds: provider.kind === 'bikeshare' ? 30 * 60 : STALE_SECONDS,
    dropAfterSeconds: provider.kind === 'bikeshare' ? 24 * 3600 : DROP_SECONDS,
    ...(provider.staticGtfs ? { staticGtfs: provider.staticGtfs } : {}),
    create: (settings) => {
      switch (provider.format) {
        case 'gtfs-rt-vp':
          return createGtfsRealtimeAdapter(
            {
              sourceId: provider.id,
              operator: provider.operator,
              coverage: derivedCoverage(provider.id, provider.coverage),
              defaultMode: provider.defaultMode,
              routeIdIsLine: provider.routeIdIsLine === true,
              ...(auth.kind === 'query' ? { keyQueryParameter: auth.parameter } : {}),
              ...(auth.kind === 'header'
                ? { keyHeaders: (key: string) => ({ [auth.header]: `${auth.prefix ?? ''}${key}` }) }
                : {}),
              ...(provider.headers ? { headers: provider.headers } : {}),
            },
            settings,
          );
        case 'gtfs-rt-tu':
          return createArrivalEstimateAdapter(
            {
              sourceId: provider.id,
              operator: provider.operator,
              defaultMode: provider.defaultMode,
              urls: [settings.url],
              ...(auth.kind === 'query' ? { keyQueryParameter: auth.parameter } : {}),
              ...(auth.kind === 'header'
                ? { keyHeaders: (key: string) => ({ [auth.header]: `${auth.prefix ?? ''}${key}` }) }
                : {}),
              ...(provider.headers ? { headers: provider.headers } : {}),
            },
            settings,
          );
        case 'gbfs':
          return createGbfsAdapter(
            {
              sourceId: provider.id,
              operator: provider.operator,
              coverage: derivedCoverage(provider.id, provider.coverage),
              ...(provider.headers ? { headers: provider.headers } : {}),
            },
            settings,
          );
        case 'siri-vm':
          return createSiriVmAdapter(
            {
              sourceId: provider.id,
              operator: provider.operator,
              coverage: derivedCoverage(provider.id, provider.coverage),
              defaultMode: provider.defaultMode,
              ...(provider.headers ? { headers: provider.headers } : {}),
            },
            settings,
          );
      }
    },
  };
}

/** The day each licence below was read (`licence.test.ts`). */
const VERIFIED_ON = '2026-10-12';

const CC_BY_4 = { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' };
const CC_BY_SA_4 = {
  label: 'CC BY-SA 4.0',
  href: 'https://creativecommons.org/licenses/by-sa/4.0/',
};
const CC0 = { label: 'CC0 1.0', href: 'https://creativecommons.org/publicdomain/zero/1.0/' };
const LICENCE_OUVERTE = {
  label: 'Licence Ouverte 2.0',
  href: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
};
const CANADA_OGL_QUOTE =
  'a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes';
const TRAFIKLAB = {
  quote:
    'Data from the GTFS Regional API is available under the CC0 1.0 Universal (CC0 1.0) Public Domain Dedication license.',
  source: 'https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/',
};
const TFNSW = {
  attribution: { label: 'Transport for NSW', href: 'https://opendata.transport.nsw.gov.au/' },
  licenceCheck: {
    verifiedOn: VERIFIED_ON,
    source: 'https://opendata.transport.nsw.gov.au/datalicence',
    quote:
      'The Creative Commons Attribution license for the datasets allows for redistribution and reuse of a licensed work on the condition that Transport for NSW is attributed as the source.',
  },
  auth: {
    kind: 'header',
    header: 'Authorization',
    prefix: 'apikey ',
    registrationUrl: 'https://opendata.transport.nsw.gov.au/',
  },
} as const;
const VICTORIA = {
  attribution: {
    label: 'Department of Transport and Planning (Victoria)',
    href: 'https://opendata.transport.vic.gov.au/',
  },
  licenceCheck: {
    verifiedOn: VERIFIED_ON,
    source: 'https://opendata.transport.vic.gov.au/dataset/gtfs-realtime',
    quote: 'License: Creative Commons Attribution 4.0 (license_id CC-BY-4.0)',
  },
  auth: {
    kind: 'header',
    header: 'KeyID',
    registrationUrl: 'https://opendata.transport.vic.gov.au/',
  },
} as const;

const SYDNEY = { west: 150.5, south: -34.3, east: 151.45, north: -33.4 };
const SYDNEY_TRAINS = { west: 149.9, south: -35.0, east: 152.0, north: -32.5 };
const MELBOURNE = { west: 144.4, south: -38.5, east: 145.65, north: -37.4 };

/**
 * Filled from the licence research of 2026-10-12 (`docs/MAP_LIVE.md` →
 * Worldwide, with what was excluded and why). Static GTFS: the whole file
 * where its parsed size is small; only `routes.txt` (line, colour, mode),
 * read by range, where the shapes would cost hundreds of megabytes; none
 * where it is not public. A feed that carries several modes defaults to
 * `other`: a vehicle its static file does not place is drawn as unknown,
 * never guessed into a bus.
 */
export const LIVE_PROVIDERS: readonly LiveProvider[] = [
  // ── Europe ────────────────────────────────────────────────────────────────
  {
    id: 'helsinki-hsl',
    place: 'Helsinki',
    country: 'FI',
    name: 'Public transport — Helsinki (HSL)',
    operator: 'HSL',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl',
    defaultMode: 'other',
    coverage: { west: 24.0, south: 59.9, east: 25.6, north: 60.9 },
    completeness: 'network',
    attribution: { label: '© HSL', href: 'https://hsl.fi/en/opendata' },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://hsl.fi/en/opendata',
      quote:
        'All data sets and APIs (with the exception of the Journey Planner OSM data…) are licensed under Creative Commons BY 4.0 International Licence',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: { zip: 'https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip', only: 'routes' },
  },
  {
    id: 'netherlands-ovapi',
    place: 'Netherlands',
    country: 'NL',
    name: 'Public transport — Netherlands',
    operator: 'OVapi',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    defaultMode: 'other',
    coverage: { west: 3.2, south: 50.7, east: 7.3, north: 53.6 },
    completeness: 'network',
    attribution: { label: 'OVapi / NDOV', href: 'https://gtfs.ovapi.nl/README' },
    licence: { label: 'CC0 (NDOV) · OVapi terms', href: 'https://gtfs.ovapi.nl/README' },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://gtfs.ovapi.nl/README',
      quote:
        'You are free to use this data, but… nor are you allowed to say you represent or impersonate any of the transit agencies — source data: "De data worden als open data (CC-0 licentie) beschikbaar gesteld."',
    },
    auth: { kind: 'none' },
    // ~220 KB a snapshot; the README asks for gzip and an identifying user agent (both sent).
    pollIntervalSeconds: 30,
    // 259 MB: its routes.txt is read by range (~250 KB), never the archive.
    staticGtfs: { zip: 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip', only: 'routes' },
  },
  {
    id: 'norway-entur',
    place: 'Norway',
    country: 'NO',
    name: 'Public transport — Norway (Entur)',
    operator: 'Entur',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions',
    defaultMode: 'other',
    coverage: { west: 4.0, south: 57.8, east: 31.5, north: 71.3 },
    completeness: 'network',
    attribution: { label: 'Entur AS', href: 'https://developer.entur.no/' },
    licence: { label: 'NLOD 2.0', href: 'https://data.norge.no/nlod/en/2.0' },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://data.norge.no/nlod/en/2.0',
      quote:
        'may use the information for any purpose and in all contexts, by: copying the information and distributing the information to others',
    },
    auth: { kind: 'none' },
    // Entur asks every caller to name itself.
    headers: { 'ET-Client-Name': 'oxy-goway' },
    // ~1 MB a snapshot.
    pollIntervalSeconds: 30,
    // 534 MB: its routes.txt is read by range (~250 KB), never the archive.
    staticGtfs: {
      zip: 'https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_norway-aggregated-gtfs.zip',
      only: 'routes',
    },
  },
  ...(
    [
      ['oslo', 'Oslo', 'oslobysykkel.no', { west: 10.6, south: 59.85, east: 10.9, north: 60.0 }],
      [
        'bergen',
        'Bergen',
        'bergenbysykkel.no',
        { west: 5.2, south: 60.3, east: 5.45, north: 60.45 },
      ],
      [
        'trondheim',
        'Trondheim',
        'trondheimbysykkel.no',
        { west: 10.3, south: 63.38, east: 10.5, north: 63.46 },
      ],
    ] as const
  ).map(
    ([slug, place, system, coverage]): LiveProvider => ({
      id: `${slug}-bysykkel`,
      place,
      country: 'NO',
      name: `Bike share — ${place}`,
      operator: `${place} Bysykkel`,
      kind: 'bikeshare',
      format: 'gbfs',
      url: `https://gbfs.urbansharing.com/${system}/gbfs.json`,
      defaultMode: 'bus',
      coverage,
      completeness: 'network',
      attribution: {
        label: `${place} Bysykkel (Urban Sharing)`,
        href: `https://${system}/en/open-data`,
      },
      licence: { label: 'NLOD 2.0', href: 'https://data.norge.no/nlod/en/2.0' },
      licenceCheck: {
        verifiedOn: VERIFIED_ON,
        source: `https://${system}/en/open-data`,
        quote:
          'The data is published under the Norwegian Licence for Open Government Data (NLOD) 2.0',
      },
      auth: { kind: 'none' },
      // Urban Sharing asks every caller to name itself.
      headers: { 'Client-Identifier': 'oxy-goway' },
      pollIntervalSeconds: 60,
    }),
  ),
  {
    id: 'prague-pid',
    place: 'Prague and Central Bohemia',
    country: 'CZ',
    name: 'Public transport — Prague (PID)',
    operator: 'PID',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb',
    defaultMode: 'other',
    coverage: { west: 12.8, south: 49.3, east: 15.6, north: 50.9 },
    completeness: 'network',
    attribution: { label: 'PID / ROPID (Golemio)', href: 'https://pid.cz/o-systemu/opendata/' },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://pid.cz/o-systemu/opendata/',
      quote:
        'je lze dále šířit, avšak je nutné uvést autora a případné provedené změny (CC BY 4.0)',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://data.pid.cz/PID_GTFS.zip', only: 'routes' },
  },
  {
    id: 'bilbao-metro',
    place: 'Bilbao',
    country: 'ES',
    name: 'Metro — Bilbao',
    operator: 'Metro Bilbao',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://ctb-gtfs-rt.s3.eu-south-2.amazonaws.com/metro-bilbao-vehicle-positions.pb',
    defaultMode: 'subway',
    coverage: { west: -3.15, south: 43.2, east: -2.85, north: 43.45 },
    completeness: 'network',
    attribution: {
      label: 'CTB — Consorcio de Transportes de Bizkaia',
      href: 'https://data.ctb.eus/',
    },
    licence: {
      label: 'CC BY 4.0 · Ley 37/2007',
      href: 'https://data.ctb.eus/en/pages/legal-notice',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://data.ctb.eus/en/pages/legal-notice',
      quote:
        'These general conditions allow the reuse of the documents submitted to them for commercial and non-commercial purposes.',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: { zip: 'https://ctb-gtfs.s3.eu-south-2.amazonaws.com/metrobilbao.zip' },
  },
  {
    id: 'donostia-dbus',
    place: 'Donostia / San Sebastián',
    country: 'ES',
    name: 'Buses — Donostia (dBus)',
    operator: 'dBus',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://opendata.euskadi.eus/transport/moveuskadi/dbus/gtfsrt_dbus_vehicle_positions.pb',
    defaultMode: 'bus',
    coverage: { west: -2.1, south: 43.24, east: -1.85, north: 43.35 },
    completeness: 'network',
    attribution: { label: 'Gobierno Vasco — Moveuskadi', href: 'https://www.euskadi.eus/' },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://nap.transportes.gob.es/licencia-datos',
      quote:
        'permiten la reutilización de los documentos sometidos a ellas para fines comerciales y no comerciales',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    // Its static GTFS is behind a NAP login; its route ids are its line numbers.
    routeIdIsLine: true,
  },
  {
    id: 'bordeaux-tbm',
    place: 'Bordeaux',
    country: 'FR',
    name: 'Public transport — Bordeaux (TBM)',
    operator: 'TBM',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    // The key in the URL is the public one Bordeaux Métropole publishes for everyone.
    url: 'https://bdx.mecatran.com/utw/ws/gtfsfeed/vehicles/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt',
    defaultMode: 'other',
    coverage: { west: -0.9, south: 44.7, east: -0.35, north: 45.05 },
    completeness: 'network',
    attribution: {
      label: 'Bordeaux Métropole (TBM)',
      href: 'https://opendata.bordeaux-metropole.fr/',
    },
    licence: LICENCE_OUVERTE,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source:
        'https://transport.data.gouv.fr/datasets/offres-de-services-bus-tram-et-scolaire-au-format-gtfs-netex-gtfs-rt-siri-lite',
      quote:
        "de l'exploiter à titre commercial, par exemple en la combinant avec d'autres informations",
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: {
      zip: 'https://bdx.mecatran.com/utw/ws/gtfsfeed/static/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt',
      only: 'routes',
    },
  },
  {
    id: 'montpellier-tam',
    place: 'Montpellier',
    country: 'FR',
    name: 'Public transport — Montpellier (TaM)',
    operator: 'TaM',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfsproxy.e-tam.fr/COMMON/VehiclePosition.pb',
    defaultMode: 'other',
    coverage: { west: 3.65, south: 43.45, east: 4.1, north: 43.75 },
    completeness: 'network',
    attribution: {
      label: 'Montpellier Méditerranée Métropole',
      href: 'https://data.montpellier3m.fr/',
    },
    licence: { label: 'ODbL 1.0', href: 'https://opendatacommons.org/licenses/odbl/1-0/' },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source:
        'https://transport.data.gouv.fr/datasets/offre-de-transport-tam-en-temps-reel-gtfs-rt-urbain-et-suburbain',
      quote:
        'These rights explicitly include commercial use, and do not exclude any field of endeavour.',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: { zip: 'https://gtfsproxy.e-tam.fr/COMMON/GTFS.zip' },
  },
  {
    id: 'nice-lignes-azur',
    place: 'Nice',
    country: 'FR',
    name: "Public transport — Nice (Lignes d'Azur)",
    operator: "Lignes d'Azur",
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://ara-api.enroute.mobi/rla/gtfs/vehicle-positions',
    defaultMode: 'other',
    coverage: { west: 6.85, south: 43.6, east: 7.5, north: 44.4 },
    completeness: 'network',
    attribution: {
      label: "Métropole Nice Côte d'Azur",
      href: 'https://opendata.nicecotedazur.org/',
    },
    licence: LICENCE_OUVERTE,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source:
        'https://transport.data.gouv.fr/datasets/donnees-statiques-et-dynamiques-du-reseau-de-transport-lignes-dazur',
      quote: 'à des fins commerciales ou non, dans le monde entier et pour une durée illimitée',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: {
      zip: 'https://chouette.enroute.mobi/api/v1/datas/OpendataRLA/gtfs.zip',
      only: 'routes',
    },
  },
  {
    id: 'ireland-nta',
    place: 'Ireland',
    country: 'IE',
    name: 'Public transport — Ireland (NTA)',
    operator: 'NTA',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://api.nationaltransport.ie/gtfsr/v2/Vehicles',
    defaultMode: 'other',
    coverage: { west: -10.7, south: 51.3, east: -5.9, north: 55.5 },
    completeness: 'network',
    attribution: {
      label: 'National Transport Authority',
      href: 'https://developer.nationaltransport.ie/',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://developer.nationaltransport.ie/usagepolicy',
      quote:
        'licensed under Creative Commons Attribution 4.0 International — prohibited: "Using the GTFS Data primarily for profit without adding significant value or enhancements that benefit the public"',
    },
    auth: {
      kind: 'header',
      header: 'x-api-key',
      registrationUrl: 'https://developer.nationaltransport.ie/',
    },
    // The usage policy allows one call a minute per key.
    pollIntervalSeconds: 60,
    staticGtfs: {
      zip: 'https://www.transportforireland.ie/transitData/Data/GTFS_All.zip',
      only: 'trips',
    },
  },
  ...(
    [
      ['sl', 'Stockholm', 'SL', { west: 17.5, south: 58.7, east: 19.3, north: 60.3 }],
      ['skane', 'Skåne', 'Skånetrafiken', { west: 12.4, south: 55.3, east: 14.6, north: 56.5 }],
      ['ul', 'Uppsala', 'UL', { west: 16.7, south: 59.3, east: 18.9, north: 60.7 }],
      [
        'otraf',
        'Östergötland',
        'Östgötatrafiken',
        { west: 14.5, south: 57.7, east: 16.9, north: 58.95 },
      ],
    ] as const
  ).map(
    ([code, place, operator, coverage]): LiveProvider => ({
      id: `sweden-${code}`,
      place,
      country: 'SE',
      name: `Public transport — ${place} (${operator})`,
      operator,
      kind: 'transit',
      format: 'gtfs-rt-vp',
      url: `https://opendata.samtrafiken.se/gtfs-rt/${code}/VehiclePositions.pb`,
      // Its static GTFS needs a second key (Trafiklab's static product): until
      // then a vehicle's mode is unknown, and drawn as such.
      defaultMode: 'other',
      coverage,
      completeness: 'network',
      attribution: { label: `Trafiklab / ${operator}`, href: 'https://www.trafiklab.se/' },
      licence: CC0,
      licenceCheck: { verifiedOn: VERIFIED_ON, ...TRAFIKLAB },
      auth: { kind: 'query', parameter: 'key', registrationUrl: 'https://www.trafiklab.se/' },
      // One key's monthly quota is shared by every operator: poll gently.
      pollIntervalSeconds: 60,
    }),
  ),

  // ── North America ─────────────────────────────────────────────────────────
  {
    id: 'toronto-ttc',
    place: 'Toronto',
    country: 'CA',
    name: 'Buses and streetcars — Toronto (TTC)',
    operator: 'TTC',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfsrt.ttc.ca/vehicles/position?format=binary',
    defaultMode: 'other',
    coverage: { west: -79.7, south: 43.55, east: -79.05, north: 43.9 },
    // Surface vehicles only: the subway is not in the feed.
    completeness: 'partial',
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – Toronto',
      href: 'https://open.toronto.ca/open-data-licence/',
    },
    licence: { label: 'OGL – Toronto', href: 'https://open.toronto.ca/open-data-licence/' },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://open.toronto.ca/open-data-licence/',
      quote: `grants you ${CANADA_OGL_QUOTE}… Copy, modify, publish, translate, adapt, distribute`,
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: {
      zip: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip',
      only: 'routes',
    },
  },
  {
    id: 'calgary-transit',
    place: 'Calgary',
    country: 'CA',
    name: 'Buses — Calgary',
    operator: 'Calgary Transit',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://data.calgary.ca/download/am7c-qe3u/application%2Foctet-stream',
    defaultMode: 'bus',
    coverage: { west: -114.35, south: 50.8, east: -113.8, north: 51.25 },
    completeness: 'network',
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – City of Calgary',
      href: 'https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa',
    },
    licence: {
      label: 'OGL – City of Calgary',
      href: 'https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa',
      quote: CANADA_OGL_QUOTE,
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    // Its vehicles name only their trip.
    staticGtfs: {
      zip: 'https://data.calgary.ca/download/npk7-z3bj/application%2Fzip',
      only: 'trips',
    },
  },
  {
    id: 'edmonton-ets',
    place: 'Edmonton',
    country: 'CA',
    name: 'Buses — Edmonton (ETS)',
    operator: 'ETS',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb',
    defaultMode: 'bus',
    coverage: { west: -113.8, south: 53.25, east: -113.2, north: 53.75 },
    completeness: 'network',
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – City of Edmonton',
      href: 'https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28',
    },
    licence: {
      label: 'OGL – Edmonton 1.0',
      href: 'https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source:
        'https://data.edmonton.ca/stories/s/City-of-Edmonton-Open-Data-Terms-of-Use/msh8-if28',
      quote: CANADA_OGL_QUOTE,
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    staticGtfs: {
      zip: 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip',
      only: 'routes',
    },
  },
  {
    id: 'halifax-transit',
    place: 'Halifax',
    country: 'CA',
    name: 'Buses and ferries — Halifax',
    operator: 'Halifax Transit',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfs.halifax.ca/realtime/Vehicle/VehiclePositions.pb',
    defaultMode: 'other',
    coverage: { west: -63.95, south: 44.55, east: -63.3, north: 44.9 },
    completeness: 'network',
    attribution: {
      label: 'Contains information licenced under the Open Government Licence – Halifax',
      href: 'https://data-hrm.hub.arcgis.com/pages/open-data-licence',
    },
    licence: {
      label: 'OGL – Halifax',
      href: 'https://data-hrm.hub.arcgis.com/pages/open-data-licence',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://data-hrm.hub.arcgis.com/pages/open-data-licence',
      quote: CANADA_OGL_QUOTE,
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://gtfs.halifax.ca/static/google_transit.zip' },
  },
  {
    id: 'york-yrt',
    place: 'York Region',
    country: 'CA',
    name: 'Buses — York Region (YRT)',
    operator: 'YRT',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://rtu.york.ca/gtfsrealtime/VehiclePositions',
    defaultMode: 'bus',
    coverage: { west: -79.7, south: 43.7, east: -79.15, north: 44.35 },
    completeness: 'network',
    attribution: {
      label: "Contains public transit Information made available under YRT's Open Data Licence",
      href: 'https://www.yrt.ca/en/about-us/open-data-licence-agreement.aspx',
    },
    licence: {
      label: 'YRT Open Data Licence',
      href: 'https://www.yrt.ca/en/about-us/open-data-licence-agreement.aspx',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://www.yrt.ca/en/about-us/open-data-licence-agreement.aspx',
      quote:
        'Copy, publish, distribute and transmit the Information… Use the Information commercially, for example… by including it in Your own product or application',
    },
    auth: { kind: 'none' },
    awaiting: "YRT's developer form (https://forms.yrt.ca/YRT-GTFS-Data), filed once",
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://www.yrt.ca/google/google_transit.zip' },
  },
  {
    id: 'mississauga-miway',
    place: 'Mississauga',
    country: 'CA',
    name: 'Buses — Mississauga (MiWay)',
    operator: 'MiWay',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://www.miapp.ca/GTFS_RT/Vehicle/VehiclePositions.pb',
    defaultMode: 'bus',
    coverage: { west: -79.85, south: 43.45, east: -79.45, north: 43.8 },
    completeness: 'network',
    // The terms ask that whoever receives the data gets their URL.
    attribution: {
      label: 'City of Mississauga Open Data — Terms of Use',
      href: 'https://data.mississauga.ca/pages/terms-of-use',
    },
    licence: {
      label: 'City of Mississauga Terms of Use',
      href: 'https://data.mississauga.ca/pages/terms-of-use',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://data.mississauga.ca/pages/terms-of-use',
      quote:
        'can be used, shared, and reused by anyone for research, analysis, reporting, commercial purposes, and the development of applications and services — Terms of Use: "a world-wide, royalty-free, non-exclusive, revocable licence to use, modify, and distribute the Datasets… for any lawful purpose"',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://www.miapp.ca/GTFS/google_transit.zip' },
  },
  {
    id: 'durham-drt',
    place: 'Durham Region',
    country: 'CA',
    name: 'Buses — Durham Region (DRT)',
    operator: 'DRT',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',
    defaultMode: 'bus',
    coverage: { west: -79.25, south: 43.75, east: -78.6, north: 44.5 },
    completeness: 'network',
    attribution: {
      label:
        "Contains public sector information made available under The Regional Municipality of Durham's Open Data Licence",
      href: 'https://www.durhamregiontransit.com/about-us/open-data/',
    },
    licence: {
      label: 'Region of Durham Open Data Licence 1.0',
      href: 'https://www.durhamregiontransit.com/about-us/open-data/',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://www.durhamregiontransit.com/about-us/open-data/',
      quote:
        'Copy, publish, distribute and transmit the information. Adapt the information. Use the information commercially, for example, by combining it with other information, or by including it in your own product or application.',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip' },
  },
  {
    id: 'hamilton-hsr',
    place: 'Hamilton',
    country: 'CA',
    name: 'Buses — Hamilton (HSR)',
    operator: 'HSR',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://opendata.hamilton.ca/GTFS-RT/GTFS_VehiclePositions.pb',
    defaultMode: 'bus',
    coverage: { west: -80.25, south: 43.1, east: -79.6, north: 43.4 },
    completeness: 'network',
    attribution: {
      label:
        "Contains public sector Data made available under the City of Hamilton's Open Data Licence",
      href: 'https://www.hamilton.ca/city-council/data-maps/open-data/open-data-licence-terms-and-conditions',
    },
    licence: {
      label: 'City of Hamilton Open Data Licence',
      href: 'https://www.hamilton.ca/city-council/data-maps/open-data/open-data-licence-terms-and-conditions',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source:
        'https://www.hamilton.ca/city-council/data-maps/open-data/open-data-licence-terms-and-conditions',
      quote:
        'a worldwide, royalty-free, perpetual, non-exclusive licence to use the Data, including for commercial purposes',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://opendata.hamilton.ca/GTFS-Static/google_transit.zip' },
  },
  {
    id: 'boston-mbta',
    place: 'Boston',
    country: 'US',
    name: 'Public transport — Boston',
    operator: 'MBTA',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    defaultMode: 'other',
    coverage: { west: -72.0, south: 41.5, east: -70.5, north: 42.95 },
    completeness: 'network',
    // The licence forbids the agency's marks: credited by name, never its logo.
    attribution: { label: 'Data: MassDOT/MBTA', href: 'https://www.mbta.com/developers' },
    licence: {
      label: 'MassDOT Developers License Agreement',
      href: 'https://www.mass.gov/files/documents/2017/10/27/develop_license_agree_0.pdf',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://www.mass.gov/files/documents/2017/10/27/develop_license_agree_0.pdf',
      quote:
        'hereby grants You (Licensee) non-exclusive, limited, and revocable rights to use, reproduce, and redistribute the Data.',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: { zip: 'https://cdn.mbta.com/MBTA_GTFS.zip', only: 'routes' },
  },
  {
    id: 'seattle-king-county',
    place: 'Seattle / King County',
    country: 'US',
    name: 'Buses — King County',
    operator: 'King County Metro',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb',
    defaultMode: 'other',
    coverage: { west: -122.55, south: 47.1, east: -121.0, north: 47.85 },
    completeness: 'network',
    attribution: {
      label:
        'Transit scheduling, geographic, and real-time data provided by permission of King County',
      href: 'https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps',
    },
    licence: {
      label: 'King County Transit Data Terms of Use',
      href: 'https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps',
      quote:
        'King County grants you a limited, revocable license to use, reproduce, and redistribute the Data… display (publicly or otherwise) such Data, and make such Data available to end users.',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://metro.kingcounty.gov/GTFS/google_transit.zip', only: 'routes' },
  },
  {
    id: 'denver-rtd',
    place: 'Denver',
    country: 'US',
    name: 'Public transport — Denver (RTD)',
    operator: 'RTD',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb',
    defaultMode: 'other',
    coverage: { west: -105.6, south: 39.45, east: -104.55, north: 40.3 },
    completeness: 'network',
    attribution: {
      label: 'Unofficial; data from RTD, not endorsed by RTD',
      href: 'https://www.rtd-denver.com/open-records/open-spatial-information/gtfs-realtime-license-agreement',
    },
    licence: {
      label: 'RTD GTFS Realtime License Agreement',
      href: 'https://www.rtd-denver.com/open-records/open-spatial-information/gtfs-realtime-license-agreement',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source:
        'https://www.rtd-denver.com/open-records/open-spatial-information/gtfs-realtime-license-agreement',
      quote:
        'RTD hereby grants you non-exclusive, limited and revocable rights to use, reproduce, and redistribute the Data subject to the terms and conditions set forth in this Agreement.',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    // Its static GTFS sits behind a firewall that refuses scripts; its route ids are its line names.
    routeIdIsLine: true,
  },
  {
    id: 'austin-capmetro',
    place: 'Austin',
    country: 'US',
    name: 'Public transport — Austin (CapMetro)',
    operator: 'CapMetro',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream',
    defaultMode: 'other',
    coverage: { west: -98.0, south: 30.0, east: -97.4, north: 31.0 },
    completeness: 'network',
    attribution: { label: 'Data: CMTA', href: 'https://www.capmetro.org/metrolabs' },
    licence: {
      label: 'CMTA Open Data License Agreement',
      href: 'https://www.capmetro.org/metrolabs',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://www.capmetro.org/metrolabs',
      quote:
        'grants you (Licensee) non-exclusive, limited, and revocable rights to use, reproduce, and redistribute CMTA Data (Data) hosted on the Socrata… platform on data.texas.gov',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    staticGtfs: {
      zip: 'https://data.texas.gov/download/r4v4-vz24/application%2Fx-zip-compressed',
      only: 'routes',
    },
  },
  {
    id: 'vancouver-translink',
    place: 'Vancouver',
    country: 'CA',
    name: 'Buses — Vancouver (TransLink)',
    operator: 'TransLink',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfsapi.translink.ca/v3/gtfsposition',
    defaultMode: 'bus',
    coverage: { west: -123.5, south: 49.0, east: -122.2, north: 49.5 },
    completeness: 'network',
    attribution: {
      label:
        'Some of the data used in this product or service is provided by permission of TransLink',
      href: 'https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/terms-of-use',
    },
    licence: {
      label: 'TransLink Open API Terms of Use',
      href: 'https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/terms-of-use',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source:
        'https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/terms-of-use',
      quote:
        'TransLink grants you a limited, revocable and non-exclusive license to use, reproduce, and redistribute the Data… a maximum of 1,000 requests per day',
    },
    auth: {
      kind: 'query',
      parameter: 'apikey',
      registrationUrl: 'https://developer.translink.ca/',
    },
    // 1,000 requests a day: one every 90 s stays under it.
    pollIntervalSeconds: 90,
    staticGtfs: { zip: 'https://gtfs-static.translink.ca/gtfs/google_transit.zip', only: 'routes' },
  },
  {
    id: 'montreal-stm',
    place: 'Montréal',
    country: 'CA',
    name: 'Buses — Montréal (STM)',
    operator: 'STM',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://api.stm.info/pub/od/gtfs-rt/ic/v2/vehiclePositions',
    defaultMode: 'bus',
    coverage: { west: -74.05, south: 45.38, east: -73.45, north: 45.72 },
    completeness: 'network',
    attribution: {
      label: 'Données : Société de transport de Montréal (STM), CC BY 4.0',
      href: 'https://donnees.montreal.ca/dataset/stm-bus-temps-reel-gtfs-realtime',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://donnees.montreal.ca/dataset/stm-bus-temps-reel-gtfs-realtime',
      quote:
        "selon la clause d'attribution de la licence Creative Commons 4.0, la paternité des données doit être attribuée à la Société de transport de Montréal",
    },
    auth: {
      kind: 'header',
      header: 'apiKey',
      registrationUrl: 'https://portail.developpeurs.stm.info/',
    },
    pollIntervalSeconds: 30,
    staticGtfs: {
      zip: 'https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip',
      only: 'routes',
    },
  },
  {
    id: 'ottawa-oc-transpo',
    place: 'Ottawa',
    country: 'CA',
    name: 'Buses and O-Train — Ottawa (OC Transpo)',
    operator: 'OC Transpo',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-vp/beta/v1/VehiclePositions',
    defaultMode: 'other',
    coverage: { west: -76.4, south: 45.1, east: -75.3, north: 45.55 },
    completeness: 'network',
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – City of Ottawa',
      href: 'https://www.octranspo.com/en/plan-your-trip/travel-tools/developers/dev-terms',
    },
    licence: {
      label: 'OC Transpo developer terms · OGL – Ottawa 2.0',
      href: 'https://www.octranspo.com/en/plan-your-trip/travel-tools/developers/dev-terms',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://www.octranspo.com/en/plan-your-trip/travel-tools/developers/dev-terms',
      quote:
        'OC Transpo and the City of Ottawa allow registered developers to use the GTFS-RT data for both non-commercial and commercial purposes',
    },
    auth: {
      kind: 'header',
      header: 'Ocp-Apim-Subscription-Key',
      registrationUrl: 'https://www.octranspo.com/en/plan-your-trip/travel-tools/developers',
    },
    pollIntervalSeconds: 30,
  },
  {
    id: 'chicago-metra',
    place: 'Chicago',
    country: 'US',
    name: 'Commuter rail — Chicago (Metra)',
    operator: 'Metra',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfspublic.metrarr.com/gtfs/public/positions',
    defaultMode: 'rail',
    coverage: { west: -88.6, south: 41.3, east: -87.5, north: 42.6 },
    completeness: 'network',
    attribution: {
      label: 'Not sponsored, affiliated, or operated by Metra',
      href: 'https://metra.com/developers',
    },
    licence: {
      label: 'Metra GTFS Realtime API License Agreement',
      href: 'https://metra.com/gtfs-realtime-api-key-request-license-agreement',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://metra.com/gtfs-realtime-api-key-request-license-agreement',
      quote:
        'grants you (Licensee) non-exclusive, limited, and revocable rights to use, reproduce, and redistribute Metra Data',
    },
    auth: {
      kind: 'query',
      parameter: 'api_token',
      registrationUrl: 'https://metra.com/developers',
    },
    pollIntervalSeconds: 30,
    staticGtfs: { zip: 'https://schedules.metrarail.com/gtfs/schedule.zip' },
  },
  {
    id: 'portland-trimet',
    place: 'Portland',
    country: 'US',
    name: 'Public transport — Portland (TriMet)',
    operator: 'TriMet',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://developer.trimet.org/ws/V1/VehiclePositions',
    defaultMode: 'other',
    coverage: { west: -123.3, south: 45.2, east: -122.3, north: 45.7 },
    completeness: 'network',
    attribution: { label: 'Unofficial; data from TriMet', href: 'https://developer.trimet.org/' },
    licence: {
      label: 'TriMet Developer Terms of Use',
      href: 'https://developer.trimet.org/terms_of_use.shtml',
    },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://developer.trimet.org/terms_of_use.shtml',
      quote:
        'TriMet grants you a limited, revocable license to use, reproduce, redistribute and display the Data in accordance with these terms.',
    },
    auth: {
      kind: 'query',
      parameter: 'appID',
      registrationUrl: 'https://developer.trimet.org/appid/registration/',
    },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://developer.trimet.org/schedule/gtfs.zip', only: 'routes' },
  },
  {
    id: 'toronto-bikeshare',
    place: 'Toronto',
    country: 'CA',
    name: 'Bike share — Toronto',
    operator: 'Bike Share Toronto',
    kind: 'bikeshare',
    format: 'gbfs',
    // The discovery file the city's open-data portal names.
    url: 'https://tor.publicbikesystem.net/ube/gbfs/v1/gbfs.json',
    defaultMode: 'bus',
    coverage: { west: -79.65, south: 43.58, east: -79.1, north: 43.86 },
    completeness: 'network',
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – Toronto',
      href: 'https://open.toronto.ca/dataset/bike-share-toronto/',
    },
    licence: { label: 'OGL – Toronto', href: 'https://open.toronto.ca/open-data-licence/' },
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://open.toronto.ca/dataset/bike-share-toronto/',
      quote: `Licence : Open Government Licence - Toronto — "${CANADA_OGL_QUOTE}"`,
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 60,
  },

  // ── Latin America ─────────────────────────────────────────────────────────
  ...(
    [
      ['bus', 'Buses', 'onibus', 'SPPO'],
      ['brt', 'BRT', 'brt', 'BRT'],
    ] as const
  ).map(
    ([slug, label, feed, operator]): LiveProvider => ({
      id: `rio-${slug}`,
      place: 'Rio de Janeiro',
      country: 'BR',
      name: `${label} — Rio de Janeiro`,
      operator,
      kind: 'transit',
      format: 'gtfs-rt-vp',
      url: `https://dados.mobilidade.rio/gtfs/realtime/${feed}/vehicle-positions`,
      defaultMode: 'bus',
      coverage: { west: -43.85, south: -23.1, east: -43.1, north: -22.74 },
      completeness: 'network',
      attribution: {
        label: 'SMTR — Prefeitura da Cidade do Rio de Janeiro, CC BY 4.0',
        href: 'https://www.data.rio/datasets/gtfs-do-rio-de-janeiro/about',
      },
      licence: CC_BY_4,
      licenceCheck: {
        verifiedOn: VERIFIED_ON,
        source: 'https://www.data.rio/datasets/gtfs-do-rio-de-janeiro/about',
        quote:
          'licenseInfo = This work is licensed under a Creative Commons Attribution 4.0 International License (Transporte Terrestre: API Centralizada de Rastreamento e Localização da Frota)',
      },
      auth: { kind: 'none' },
      // 60 requests a minute across the API: two feeds every 15 s is 8.
      pollIntervalSeconds: 15,
      staticGtfs: { zip: 'https://dados.mobilidade.rio/gtfs/schedule', only: 'routes' },
    }),
  ),

  // ── Australia and New Zealand ────────────────────────────────────────────
  {
    id: 'brisbane-translink',
    place: 'Brisbane / South East Queensland',
    country: 'AU',
    name: 'Public transport — South East Queensland',
    operator: 'TransLink Queensland',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions',
    defaultMode: 'other',
    coverage: { west: 152.0, south: -28.3, east: 153.6, north: -26.2 },
    completeness: 'network',
    attribution: {
      label: 'TransLink (State of Queensland), CC BY 4.0',
      href: 'https://translink.com.au/about-translink/open-data',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://translink.com.au/about-translink/open-data',
      quote: 'Our data is licensed under a Creative Commons Attribution 4.0 International License',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: { zip: 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip', only: 'routes' },
  },
  {
    id: 'cairns-translink',
    place: 'Cairns',
    country: 'AU',
    name: 'Buses — Cairns',
    operator: 'TransLink Queensland',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfsrt.api.translink.com.au/api/realtime/CNS/VehiclePositions',
    defaultMode: 'bus',
    coverage: { west: 145.6, south: -17.1, east: 145.85, north: -16.6 },
    completeness: 'network',
    attribution: {
      label: 'TransLink (State of Queensland), CC BY 4.0',
      href: 'https://translink.com.au/about-translink/open-data',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://translink.com.au/about-translink/open-data',
      quote: 'Our data is licensed under a Creative Commons Attribution 4.0 International License',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 20,
    routeIdIsLine: true,
  },
  {
    id: 'adelaide-metro',
    place: 'Adelaide',
    country: 'AU',
    name: 'Public transport — Adelaide',
    operator: 'Adelaide Metro',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://gtfs.adelaidemetro.com.au/v1/realtime/vehicle_positions',
    defaultMode: 'other',
    coverage: { west: 138.35, south: -35.4, east: 138.85, north: -34.55 },
    completeness: 'network',
    attribution: {
      label: 'Adelaide Metro (Government of South Australia), CC BY 4.0',
      href: 'https://data.sa.gov.au/data/dataset/https-gtfs-adelaidemetro-com-au',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://data.sa.gov.au/data/dataset/https-gtfs-adelaidemetro-com-au',
      quote:
        'License: Creative Commons Attribution 4.0 — "a worldwide, royalty-free, non-sublicensable, non-exclusive, irrevocable license to exercise the Licensed Rights… to reproduce and Share the Licensed Material"',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    staticGtfs: {
      zip: 'https://gtfs.adelaidemetro.com.au/v1/static/latest/google_transit.zip',
      only: 'routes',
    },
  },
  {
    id: 'canberra-light-rail',
    place: 'Canberra',
    country: 'AU',
    name: 'Light rail — Canberra',
    operator: 'Canberra Metro',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://files.transport.act.gov.au/feeds/lightrail.pb',
    defaultMode: 'tram',
    coverage: { west: 148.95, south: -35.5, east: 149.25, north: -35.1 },
    completeness: 'network',
    attribution: {
      label: 'Transport Canberra (ACT Government), CC BY-SA 4.0',
      href: 'https://www.data.act.gov.au/',
    },
    licence: CC_BY_SA_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://www.data.act.gov.au/d/4f7h-bvpk',
      quote:
        'CC BY-SA 4.0: "a worldwide, royalty-free, non-sublicensable, non-exclusive, irrevocable license to exercise the Licensed Rights… to reproduce and Share the Licensed Material"',
    },
    auth: { kind: 'none' },
    pollIntervalSeconds: 15,
    routeIdIsLine: true,
  },
  ...(
    [
      [
        'buses',
        'Buses',
        'https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses',
        'bus',
        SYDNEY,
      ],
      [
        'trains',
        'Trains',
        'https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/sydneytrains',
        'rail',
        SYDNEY_TRAINS,
      ],
      [
        'metro',
        'Metro',
        'https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/metro',
        'subway',
        SYDNEY,
      ],
      [
        'ferries',
        'Ferries',
        'https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/ferries/sydneyferries',
        'ferry',
        SYDNEY,
      ],
      [
        'light-rail',
        'Light rail',
        'https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/lightrail/innerwest',
        'tram',
        SYDNEY,
      ],
    ] as const
  ).map(
    ([slug, label, url, mode, coverage]): LiveProvider => ({
      id: `sydney-${slug}`,
      place: 'Sydney',
      country: 'AU',
      name: `${label} — Sydney`,
      operator: 'Transport for NSW',
      kind: 'transit',
      format: 'gtfs-rt-vp',
      url,
      defaultMode: mode,
      coverage,
      completeness: 'network',
      licence: CC_BY_4,
      ...TFNSW,
      pollIntervalSeconds: 15,
    }),
  ),
  ...(
    [
      ['metro', 'Metro trains', 'rail', MELBOURNE],
      ['tram', 'Trams', 'tram', MELBOURNE],
      ['bus', 'Buses', 'bus', MELBOURNE],
      ['vline', 'V/Line', 'rail', { west: 140.9, south: -39.2, east: 150.0, north: -33.9 }],
    ] as const
  ).map(
    ([slug, label, mode, coverage]): LiveProvider => ({
      id: `victoria-${slug}`,
      place: slug === 'vline' ? 'Victoria' : 'Melbourne',
      country: 'AU',
      name: `${label} — ${slug === 'vline' ? 'Victoria' : 'Melbourne'}`,
      operator: slug === 'vline' ? 'V/Line' : 'Public Transport Victoria',
      kind: 'transit',
      format: 'gtfs-rt-vp',
      url: `https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/${slug}/vehicle-positions`,
      defaultMode: mode,
      coverage,
      completeness: 'network',
      licence: CC_BY_4,
      ...VICTORIA,
      // 24 calls a minute per mode.
      pollIntervalSeconds: 15,
    }),
  ),
  {
    id: 'auckland-at',
    place: 'Auckland',
    country: 'NZ',
    name: 'Public transport — Auckland',
    operator: 'Auckland Transport',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://api.at.govt.nz/realtime/legacy/vehiclelocations',
    defaultMode: 'other',
    coverage: { west: 174.2, south: -37.4, east: 175.3, north: -36.2 },
    completeness: 'network',
    attribution: {
      label: 'Auckland Transport, CC BY 4.0',
      href: 'https://at.govt.nz/about-us/at-data-sources',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://at.govt.nz/about-us/at-data-sources',
      quote: 'This work is licensed under a Creative Commons Attribution 4.0 International License',
    },
    auth: {
      kind: 'header',
      header: 'Ocp-Apim-Subscription-Key',
      registrationUrl: 'https://dev-portal.at.govt.nz/',
    },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://gtfs.at.govt.nz/gtfs.zip', only: 'routes' },
  },
  {
    id: 'wellington-metlink',
    place: 'Wellington',
    country: 'NZ',
    name: 'Public transport — Wellington (Metlink)',
    operator: 'Metlink',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://api.opendata.metlink.org.nz/v1/gtfs-rt/vehiclepositions',
    defaultMode: 'other',
    coverage: { west: 174.6, south: -41.4, east: 175.95, north: -40.6 },
    completeness: 'network',
    attribution: { label: 'GWRC / Metlink, CC BY 4.0', href: 'https://opendata.metlink.org.nz/' },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://opendata.metlink.org.nz/',
      quote:
        'the material made available on the Metlink Open Data API is licensed for re-use under a Creative Commons Attribution 4.0 International Licence',
    },
    auth: {
      kind: 'header',
      header: 'x-api-key',
      registrationUrl: 'https://opendata.metlink.org.nz/',
    },
    pollIntervalSeconds: 20,
    staticGtfs: { zip: 'https://static.opendata.metlink.org.nz/v1/gtfs/full.zip', only: 'routes' },
  },
  {
    id: 'christchurch-metro',
    place: 'Christchurch',
    country: 'NZ',
    name: 'Buses — Christchurch',
    operator: 'Metro (Environment Canterbury)',
    kind: 'transit',
    format: 'gtfs-rt-vp',
    url: 'https://apis.metroinfo.co.nz/rti/gtfsrt/v1/vehicle-positions.pb',
    defaultMode: 'bus',
    coverage: { west: 172.3, south: -43.75, east: 172.85, north: -43.35 },
    completeness: 'network',
    attribution: {
      label: 'Environment Canterbury, CC BY 4.0',
      href: 'https://www.metroinfo.co.nz/about/developer-resources/',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: VERIFIED_ON,
      source: 'https://www.metroinfo.co.nz/about/developer-resources/',
      quote:
        'All data unless specifically stated is licensed under a Creative Commons Attribution 4.0 International License.',
    },
    auth: {
      kind: 'header',
      header: 'Ocp-Apim-Subscription-Key',
      registrationUrl: 'https://apidevelopers.metroinfo.co.nz/signup',
    },
    pollIntervalSeconds: 20,
    routeIdIsLine: true,
  },

  // ── Japan (ODPT public feeds, CC BY 4.0) ──────────────────────────────────
  ...(
    [
      [
        'toei-bus',
        'Tokyo',
        'Toei Bus',
        '東京都交通局 / Toei',
        'b_bus_gtfs_rt-toei',
        'ToeiBus',
        'Toei/data/ToeiBus-GTFS',
        'bus',
        [139.15, 35.55, 139.95, 35.87],
        'routes',
      ],
      [
        'toei-train',
        'Tokyo',
        'Toei Subway, Sakura Tram, Nippori-Toneri Liner',
        '東京都交通局 / Toei',
        'r_train_gtfs_rt-odpt_train-toei',
        'toei_odpt_train_vehicle',
        'Toei/data/Toei-Train-GTFS',
        'subway',
        [139.6, 35.56, 139.96, 35.84],
        'trips',
      ],
      [
        'sendai-bus',
        'Sendai',
        'Sendai City Bus',
        '仙台市交通局',
        'odpt_sendai_municipal_bus_realtime_information',
        'odpt_SendaiMunicipal_bus_realtime_information_vehicle',
        'odpt/SendaiMunicipal/bus_realtime_information',
        'bus',
        [140.52, 38.15, 141.03, 38.45],
      ],
      [
        'aomori-bus',
        'Aomori',
        'Aomori City Bus',
        '青森市企業局交通部',
        'odpt_aomori_city_all_lines',
        'odpt_AomoriCity_AllLines_vehicle',
        'odpt/AomoriCity/AllLines',
        'bus',
        [140.62, 40.71, 140.89, 40.98],
      ],
      [
        'gunma-bus',
        'Gunma',
        'Gunma Bus',
        '群馬バス',
        'odpt_gunma_bus_all_lines',
        'odpt_GunmaBus_AllLines_vehicle',
        'odpt/GunmaBus/AllLines',
        'bus',
        [138.57, 35.05, 139.37, 36.65],
      ],
      [
        'gunmachuo-bus',
        'Gunma',
        'Gunma Chuo Bus',
        '群馬中央バス',
        'odpt_gunmachuo_bus_all_lines',
        'odpt_GunmachuoBus_AllLines_vehicle',
        'odpt/GunmachuoBus/AllLines',
        'bus',
        [138.98, 36.27, 139.26, 36.43],
      ],
      [
        'joshin-hire',
        'Gunma',
        'Joshin Hire',
        '上信ハイヤー',
        'odpt_joshin_hire_all_lines',
        'odpt_JoshinHire_AllLines_vehicle',
        'odpt/JoshinHire/AllLines',
        'bus',
        [138.95, 36.22, 139.15, 36.32],
      ],
      [
        'joshin-kanko-bus',
        'Gunma',
        'Joshin Kanko Bus',
        '上信観光バス',
        'odpt_joshin_kanko_bus_all_lines',
        'odpt_JoshinKankoBus_AllLines_vehicle',
        'odpt/JoshinKankoBus/AllLines',
        'bus',
        [138.94, 36.24, 139.1, 36.42],
      ],
      [
        'kanetsu-bus',
        'Gunma',
        'Kan-etsu Transportation',
        '関越交通',
        'odpt_kan_etsu_transportation_all_lines',
        'odpt_Kan_etsuTransportation_AllLines_vehicle',
        'odpt/Kan_etsuTransportation/AllLines',
        'bus',
        [138.7, 36.29, 139.45, 36.91],
      ],
      [
        'nagai-bus',
        'Gunma',
        'Nagai Transportation',
        '永井運輸',
        'odpt_nagai_transportation_all_lines',
        'odpt_NagaiTransportation_AllLines_vehicle',
        'odpt/NagaiTransportation/AllLines',
        'bus',
        [139.02, 36.24, 139.22, 36.49],
      ],
      [
        'nippon-chuo-bus',
        'Gunma',
        'Nippon Chuo Bus',
        '日本中央バス',
        'odpt_nippon_chuo_bus_maebashi_area',
        'odpt_NipponChuoBus_Maebashi_Area_vehicle',
        'odpt/NipponChuoBus/Maebashi_Area',
        'bus',
        [135.4, 34.6, 140.95, 38.3],
      ],
      [
        'takasaki-bus',
        'Takasaki',
        'Takasaki City Bus (Yoshii)',
        '高崎市',
        'odpt_takasaki_city_yosiibus',
        'odpt_TakasakiCity_yosiibus_vehicle',
        'odpt/TakasakiCity/yosiibus',
        'bus',
        [138.92, 36.19, 139.11, 36.32],
      ],
      [
        'keifuku-bus',
        'Fukui',
        'Keifuku Bus',
        '京福バス',
        'odpt_keifuku_bus_keifuku_rosen',
        'odpt_KeifukuBus_keifuku_rosen_vehicle',
        'odpt/KeifukuBus/keifuku_rosen',
        'bus',
        [135.98, 35.14, 136.91, 36.43],
      ],
      [
        'keisei-transit-bus',
        'Chiba',
        'Keisei Bus Chiba West',
        '京成バス千葉ウエスト',
        'odpt_keisei_transit_bus_all_lines',
        'odpt_KeiseiTransitBus_AllLines_vehicle',
        'odpt/KeiseiTransitBus/AllLines',
        'bus',
        [139.85, 35.61, 139.99, 35.76],
      ],
      [
        'kiyose-bus',
        'Kiyose',
        'Kiyose City Bus',
        '清瀬市',
        'odpt_kiyose_city_kiyo_bus',
        'odpt_KiyoseCity_KiyoBus_vehicle',
        'odpt/KiyoseCity/KiyoBus',
        'bus',
        [139.47, 35.73, 139.55, 35.81],
      ],
      [
        'suginami-slow-mobility',
        'Suginami',
        'Suginami Green Slow Mobility',
        '杉並区',
        'odpt_tokyo_suginami_city_green_slow_mobility',
        'odpt_TokyoSuginamiCity_GreenSlowMobility_vehicle',
        'odpt/TokyoSuginamiCity/GreenSlowMobility',
        'bus',
        [139.59, 35.67, 139.65, 35.73],
      ],
      [
        'kochi-seinan-bus',
        'Kochi',
        'Kochi Seinan Traffic',
        '高知西南交通',
        'odpt_kochi_seinan_traffic_localbus',
        'odpt_KochiSeinanTraffic_Localbus_vehicle',
        'odpt/KochiSeinanTraffic/Localbus',
        'bus',
        [132.6, 32.69, 133.14, 33.21],
      ],
      [
        'tosa-bus',
        'Tosa',
        'Tosa City Bus',
        '土佐市',
        'odpt_tosa_city_all_lines',
        'odpt_TosaCity_AllLines_vehicle',
        'odpt/TosaCity/AllLines',
        'bus',
        [133.31, 33.4, 133.5, 33.58],
      ],
      [
        'tosaden-bus',
        'Kochi',
        'Tosaden Traffic',
        'とさでん交通',
        'odpt_tosaden_traffic_regularbus',
        'odpt_TosadenTraffic_Regularbus_vehicle',
        'odpt/TosadenTraffic/Regularbus',
        'bus',
        [133.38, 33.46, 133.77, 33.65],
      ],
      [
        'tosaden-airport-bus',
        'Kochi',
        'Tosaden airport bus',
        'とさでん交通',
        'odpt_tosaden_traffic_airportbus',
        'odpt_TosadenTraffic_Airportbus_vehicle',
        'odpt/TosadenTraffic/Airportbus',
        'bus',
        [133.51, 33.52, 133.71, 33.6],
      ],
    ] as const
  ).map(
    ([
      slug,
      place,
      label,
      publisher,
      dataset,
      feed,
      files,
      mode,
      [west, south, east, north],
      ...depth
    ]): LiveProvider => ({
      id: `japan-${slug}`,
      place,
      country: 'JP',
      name: `${label} — ${place}`,
      operator: label,
      kind: 'transit',
      format: 'gtfs-rt-vp',
      url: `https://api-public.odpt.org/api/v4/gtfs/realtime/${feed}`,
      defaultMode: mode,
      coverage: { west, south, east, north },
      completeness: 'network',
      attribution: {
        label: `${publisher} / 公共交通オープンデータ協議会 (ODPT), CC BY 4.0`,
        href: `https://ckan.odpt.org/dataset/${dataset}`,
      },
      licence: CC_BY_4,
      licenceCheck: {
        verifiedOn: VERIFIED_ON,
        source: `https://ckan.odpt.org/dataset/${dataset}`,
        quote:
          'ライセンス Creative Commons Attribution 4.0 International (CC BY 4.0) — This content, etc. is licensed under CC BY 4.0',
      },
      auth: { kind: 'none' },
      pollIntervalSeconds: 20,
      staticGtfs: {
        zip: `https://api-public.odpt.org/api/v4/files/${files}.zip${files.startsWith('odpt/') ? '?date=current' : ''}`,
        ...(depth[0] ? { only: depth[0] } : {}),
      },
    }),
  ),
];
