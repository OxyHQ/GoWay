/**
 * Every camera provider GoWay knows how to read, with its terms.
 *
 * A provider is listed here only after its licence was read and found to allow
 * what GoWay does with it: list the camera and serve its picture itself, to
 * every viewer, from a service that may be commercial. The evidence for each —
 * the decisive sentence, the page and the day — is `licenceCheck`;
 * `docs/CAMERAS.md` → Providers has the rest, including the feeds that were
 * REJECTED or are waiting on a permission, and why. `licence.test.ts` refuses
 * an entry without it.
 *
 * `attribution` is the credit the licence asks for; the client shows it
 * whenever that provider's camera is drawn.
 *
 * `staleAfterSeconds` and `dropAfterSeconds` are measured against the age of a
 * camera's newest frame, so each is a multiple of how often its picture
 * refreshes. `pollIntervalSeconds` is how often the CATALOGUE is read.
 */

import { createDigitrafficSource } from './sources/digitraffic';
import { createHongKongSource } from './sources/hongKong';
import { createIowaSource } from './sources/iowa';
import { createTorontoSource } from './sources/toronto';
import type { CameraProviderDefinition } from './types';

const CC_BY_4 = {
  label: 'CC BY 4.0',
  href: 'https://creativecommons.org/licenses/by/4.0/',
} as const;

export const CAMERA_PROVIDERS: readonly CameraProviderDefinition[] = [
  {
    id: 'digitraffic-weathercam',
    name: 'Road weather cameras — Fintraffic Digitraffic (Finland)',
    attribution: {
      label: 'Source: Fintraffic / digitraffic.fi',
      href: 'https://www.digitraffic.fi/en/',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: '2026-10-22',
      quote:
        "Fintraffic's open data is licensed under the Creative Commons 4.0 By license. It gives the right to distribute, remix, tweak, and build upon our data, even commercially, as long as you credit the source for the original creation.",
      source: 'https://www.digitraffic.fi/en/terms-of-service/',
    },
    defaultUrl: 'https://tie.digitraffic.fi/api/weathercam/v1/stations',
    requiresKey: false,
    coverage: { west: 19, south: 59.5, east: 32, north: 70.2 },
    redistribution: 'relay',
    pollIntervalSeconds: 3600,
    staleAfterSeconds: 1800,
    dropAfterSeconds: 7200,
    create: createDigitrafficSource,
  },
  {
    id: 'hk-transport-snapshots',
    name: 'Traffic snapshot cameras — Transport Department (Hong Kong)',
    attribution: {
      label: 'Source: Transport Department, HKSAR Government, via DATA.GOV.HK',
      href: 'https://data.gov.hk/en/',
    },
    licence: {
      label: 'DATA.GOV.HK Terms and Conditions',
      href: 'https://data.gov.hk/en/terms-and-conditions',
    },
    licenceCheck: {
      verifiedOn: '2026-10-22',
      quote:
        'You are allowed to browse, download, distribute, reproduce, hyperlink to, and print the Data for both commercial and non-commercial purposes on a free-of-charge basis.',
      source: 'https://data.gov.hk/en/terms-and-conditions',
    },
    defaultUrl:
      'https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml',
    requiresKey: false,
    coverage: { west: 113.8, south: 22.1, east: 114.5, north: 22.6 },
    redistribution: 'relay',
    pollIntervalSeconds: 3600,
    staleAfterSeconds: 600,
    dropAfterSeconds: 3600,
    create: createHongKongSource,
  },
  {
    id: 'toronto-traffic',
    name: 'Traffic cameras — City of Toronto',
    attribution: {
      label: 'Contains information licensed under the Open Government Licence – Toronto',
      href: 'https://open.toronto.ca/dataset/traffic-cameras/',
    },
    licence: {
      label: 'Open Government Licence – Toronto',
      href: 'https://www.toronto.ca/city-government/data-research-maps/open-data/open-data-licence/',
    },
    licenceCheck: {
      verifiedOn: '2026-10-22',
      quote:
        'grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes',
      source:
        'https://www.toronto.ca/city-government/data-research-maps/open-data/open-data-licence/',
    },
    defaultUrl:
      'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/Data/tmcearthcameras.json',
    requiresKey: false,
    coverage: { west: -79.7, south: 43.55, east: -79.1, north: 43.9 },
    redistribution: 'relay',
    pollIntervalSeconds: 3600,
    // Its pictures change about every 25 minutes (`sources/toronto.ts`).
    staleAfterSeconds: 3600,
    dropAfterSeconds: 10800,
    create: createTorontoSource,
  },
  {
    id: 'iowa-dot',
    name: 'Traffic cameras — Iowa Department of Transportation',
    attribution: {
      label: 'Source: Iowa Department of Transportation',
      href: 'https://iowadot.gov/',
    },
    licence: CC_BY_4,
    licenceCheck: {
      verifiedOn: '2026-10-22',
      quote: 'This work is licensed under a Creative Commons Attribution 4.0 International License',
      source: 'https://www.arcgis.com/home/item.html?id=c4063f200a7b4da5826e2ac86c677cf5',
    },
    defaultUrl:
      'https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query',
    requiresKey: false,
    coverage: { west: -96.7, south: 40.3, east: -90, north: 43.6 },
    redistribution: 'relay',
    pollIntervalSeconds: 3600,
    staleAfterSeconds: 600,
    dropAfterSeconds: 3600,
    create: createIowaSource,
  },
];

export function cameraProviderById(id: string): CameraProviderDefinition | undefined {
  return CAMERA_PROVIDERS.find((provider) => provider.id === id);
}
