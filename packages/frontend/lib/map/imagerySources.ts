/**
 * Every imagery source GoWay may serve, with the credit drawn while it is on
 * screen and the notice its licence asks for (`docs/MAP_SATELLITE.md` → the
 * source table, where each licence is quoted with its URL).
 *
 * Adding a source here is a LICENCE decision first and a code change second:
 * only imagery whose licence lets GoWay host it, re-serve it and display it
 * publicly and commercially, with the credit drawn. Never Google, Apple, Bing,
 * Esri World Imagery, Mapbox, Maxar, Planet NICFI, a "non-commercial" source,
 * a scraped one or a reverse-engineered endpoint. The build refuses a set
 * naming a source that is not here (`scripts/imagery/catalogue.ts`), and the
 * client credits sources by these ids only, never by a string the manifest
 * carries.
 *
 * The notices are quoted from the licences or the files' own metadata and are
 * never translated; the credit page (`app/attribution.tsx`) shows them all.
 */

export interface ImagerySource {
  /** The map's compact credit, while this source is drawn. */
  credit: string;
  /** The source's own page (linked from GoWay's attribution page). */
  href: string;
  /** SPDX-style id of the licence the data is used under. */
  licence: 'CC-BY-4.0' | 'public-domain';
  /** The notice the licence asks for, verbatim; GoWay's modification note after it. */
  notice: string;
}

export const IMAGERY_SOURCES = {
  // Global 10 m, the yearly median of every Sentinel-2 L2A scene of 2021.
  // CC BY 4.0 per the files' own `license` tag and the AWS Open Data registry;
  // the Copernicus legal notice asks for "Contains modified Copernicus
  // Sentinel data [Year]" on modified data, which the copyright tag carries.
  'esa-worldcover-2021': {
    credit: '© ESA WorldCover 2021 · Copernicus Sentinel-2',
    href: 'https://registry.opendata.aws/esa-worldcover-vito-composites/',
    licence: 'CC-BY-4.0',
    notice:
      '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. Colour-stretched, re-projected and re-encoded by GoWay.',
  },
  // Global 500 m, August 2004, with topography and bathymetry: the whole
  // planet, oceans included, at the first zooms (z0–7). NASA material is not
  // copyrighted in the US; NASA asks to be acknowledged and not to be
  // presented as endorsing anything.
  'nasa-blue-marble': {
    credit: 'NASA Blue Marble',
    href: 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/',
    licence: 'public-domain',
    notice:
      'Blue Marble Next Generation (August 2004, topography and bathymetry), Reto Stöckli, NASA Earth Observatory. Re-projected and re-encoded by GoWay; NASA does not endorse GoWay.',
  },
  // Catalonia, 25 cm, flown every year. CC BY 4.0 (icgc.cat → Territorial
  // Orthophoto), whose only prescribed wording is the source sentence below.
  'icgc-ortofoto': {
    credit: '© ICGC',
    href: 'https://www.icgc.cat/en/Geoinformation-and-Maps/Data-and-products/Image/Territorial-Orthophoto',
    licence: 'CC-BY-4.0',
    notice:
      'Geoinformation from the Cartographic and Geological Institute of Catalonia (ICGC), Ortofoto territorial de Catalunya 25 cm, under CC BY 4.0. Re-projected, re-tiled and re-encoded (WebP) by GoWay.',
  },
} as const satisfies Record<string, ImagerySource>;

export type ImagerySourceId = keyof typeof IMAGERY_SOURCES;

export function isImagerySourceId(value: unknown): value is ImagerySourceId {
  return typeof value === 'string' && Object.hasOwn(IMAGERY_SOURCES, value);
}
