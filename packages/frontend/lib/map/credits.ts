/**
 * Where GoWay's map data comes from, what each source asks to be credited
 * with, and the notices their licences REQUIRE — the content of
 * `https://goway.to/attribution` (`app/attribution.tsx`).
 *
 * Data, not prose: the map's credit line (`MapAttribution`) and this page are
 * built from the same `provider.ts` constants, so a source cannot be drawn
 * without the page knowing it. The notices are quoted VERBATIM from the
 * licences and are never translated or reworded here; the screen's headings
 * are (`lib/messages/credits.ts`).
 */
import { ATTRIBUTION_LINKS, TERRAIN_SOURCE_LINK } from './provider';

/**
 * Copernicus DEM licence (the "COPERNICUS full, free and open license" for
 * GLO-30), Article 6. Mapterhorn's z0–12 tiles are GLO-30 wherever no finer
 * national model exists (where one does, it feeds z12 too: measured in
 * Barcelona, Madrid and Manhattan, `docs/MAP_TERRAIN_GLOBE.md`), resampled and
 * re-encoded — "adapted or modified" — so 6(b) applies; 6(c) applies to anyone
 * communicating it to the public, modified or not; 6(d) forbids implying
 * endorsement. Source: the licence PDF Mapterhorn links for `glo30`
 * (https://github.com/mapterhorn/mapterhorn/blob/main/source-catalog/glo30/LICENSE.pdf).
 */
export const COPERNICUS_NOTICES = {
  /** Article 6(b), for adapted or modified data. */
  source:
    'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
  /** Article 6(c), the liability sentence, verbatim. */
  liability:
    'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.',
  /** Article 6(d): no impression of endorsement. GoWay's own sentence. */
  endorsement:
    'GoWay is not endorsed by the European Union, ESA or any organisation in charge of the Copernicus programme.',
} as const;

/**
 * Official building data the 3D city tiles may merge (`docs/MAP_3D_SOURCES.md`).
 * Neither licence fixes a wording, so these are GoWay's sentences, written to
 * what each one asks: the Catastro to be "mentioned as author and owner of the
 * information" and never presented as cadastral cartography (its INSPIRE
 * licence v1.0, 2016, and feed rights); New York City to be named with the
 * dataset, its version and a note that it was modified (NYC Admin. Code
 * §23-502(d), which the city may require).
 */
export const BUILDING_DATA_NOTICES = {
  catastro:
    'Building parts and storeys: Dirección General del Catastro (Ministerio de Hacienda, Spain), author and owner of the information. Transformed by GoWay (re-projected, storeys converted to heights, conflated with OpenStreetMap); this is not cadastral cartography.',
  nyc: '3-D Building Model, City of New York, Office of Technology and Innovation (2014 capture, published 2016). Modified by GoWay: roof surfaces only, conflated with OpenStreetMap.',
} as const;

/**
 * The same links as the map's credit (`lib/map/cityOfficial.ts` →
 * `CITY_LOD2_SOURCES`, pinned equal by `credits.test.ts`). Copied, not
 * imported: that module belongs to the lazily loaded city-3D layer, and a
 * module this route and that chunk both imported would be hoisted into every
 * page's first-paint bundle.
 */
const BUILDING_DATA_LINKS: readonly CreditLink[] = [
  { label: 'Dirección General del Catastro', href: 'https://www.catastro.hacienda.gob.es/' },
  { label: 'NYC 3D Building Model (modified)', href: 'https://data.cityofnewyork.us/d/tnru-abg2' },
];

export interface CreditLink {
  label: string;
  href: string;
}

export interface CreditSection {
  /** Stable anchor (`/attribution#elevation`) and the i18n key suffix. */
  id: 'basemap' | 'elevation' | 'buildings';
  links: readonly CreditLink[];
  /** Licence notices, verbatim. */
  notices: readonly string[];
}

export const CREDIT_SECTIONS: readonly CreditSection[] = [
  { id: 'basemap', links: ATTRIBUTION_LINKS, notices: [] },
  {
    id: 'elevation',
    links: [TERRAIN_SOURCE_LINK],
    notices: [
      COPERNICUS_NOTICES.source,
      COPERNICUS_NOTICES.liability,
      COPERNICUS_NOTICES.endorsement,
    ],
  },
  {
    id: 'buildings',
    links: BUILDING_DATA_LINKS,
    notices: [BUILDING_DATA_NOTICES.catastro, BUILDING_DATA_NOTICES.nyc],
  },
];
