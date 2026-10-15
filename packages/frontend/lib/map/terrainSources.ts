/**
 * Every elevation source GoWay may build its own terrain from, with the
 * credit drawn while it is on screen and the notice its licence asks for
 * (`docs/MAP_TERRAIN_GLOBE.md` → "The archive" → Sources, where each licence
 * is quoted with its URL, and the planet-wide table of what is next).
 *
 * Adding a source here is a LICENCE decision first: only a bare-earth model
 * (DTM) whose licence lets GoWay re-encode it, host it and serve it publicly
 * and commercially with the credit drawn. Never a "non-commercial" model
 * (FABDEM, FathomDEM, Lithuania's), a revocable one (Hong Kong's), a surface
 * model presented as ground, or a scraped viewer. The build refuses a set
 * naming a source that is not here (`scripts/terrain/catalogue.ts`), and the
 * client credits sources by these ids only.
 *
 * The notices are quoted from the licences or the producers' own pages and
 * are never translated; the credit page (`app/attribution.tsx`) shows them all.
 */

export interface TerrainSource {
  /** The map's compact credit, while this source is drawn. */
  credit: string;
  /** The source's own page (linked from GoWay's attribution page). */
  href: string;
  /** The licence the data is used under. */
  licence: 'CC-BY-4.0' | 'Etalab-2.0' | 'public-domain' | 'GSI-terms';
  /** The notice the licence asks for, verbatim; GoWay's modification note after it. */
  notice: string;
}

export const TERRAIN_SOURCES = {
  // Catalonia, LiDAR 2021–2023, buildings and vegetation removed. CC BY 4.0
  // (icgc.cat → Digital Terrain Model), whose prescribed source sentence is
  // the notice's first part.
  'icgc-met': {
    credit: '© ICGC',
    href: 'https://www.icgc.cat/en/Geoinformation-and-Maps/Data-and-products/Elevations/Digital-Terrain-Model',
    licence: 'CC-BY-4.0',
    notice:
      'Geoinformation from the Cartographic and Geological Institute of Catalonia (ICGC), Model d’elevacions del terreny de Catalunya 5 m (LiDAR 2021–2023), under CC BY 4.0. Heights converted to EGM2008, re-projected, resampled and re-encoded (Terrarium WebP) by GoWay.',
  },
  // France, RGE ALTI® 1 m. Licence Ouverte / Open Licence 2.0 (Etalab), which
  // asks for the source and the date of its last update.
  'ign-rgealti': {
    credit: '© IGN',
    href: 'https://geoservices.ign.fr/rgealti',
    licence: 'Etalab-2.0',
    notice:
      'IGN – RGE ALTI® 1 m (version 2.0), Licence Ouverte / Open Licence 2.0 (Etalab). Heights converted from NGF-IGN69 to EGM2008, re-projected, resampled and re-encoded (Terrarium WebP) by GoWay.',
  },
  // United States, 3DEP seamless 1 m (S1M), bare earth from LiDAR. Public
  // domain; USGS asks for the credit line below.
  'usgs-3dep': {
    credit: 'USGS 3DEP',
    href: 'https://www.usgs.gov/3d-elevation-program',
    licence: 'public-domain',
    notice:
      'Courtesy of the U.S. Geological Survey, 3D Elevation Program (seamless 1 m DEM). Heights converted from NAVD88 to EGM2008, re-projected, resampled and re-encoded (Terrarium WebP) by GoWay; USGS does not endorse GoWay.',
  },
  // Japan, GSI elevation tiles (DEM5A, laser survey; DEM10B where 5 m is not
  // published). GSI's terms for these tiles ask for the source, and for
  // derived work the sentence 「地理院タイル（標高タイル）を加工して作成」.
  'gsi-dem': {
    credit: '国土地理院',
    href: 'https://maps.gsi.go.jp/development/ichiran.html',
    licence: 'GSI-terms',
    notice:
      '出典：国土地理院（地理院タイル）。地理院タイル（標高タイル）を加工して作成。Heights converted to EGM2008, resampled and re-encoded (Terrarium WebP) by GoWay.',
  },
} as const satisfies Record<string, TerrainSource>;

export type TerrainSourceId = keyof typeof TERRAIN_SOURCES;

export function isTerrainSourceId(value: unknown): value is TerrainSourceId {
  return typeof value === 'string' && Object.hasOwn(TERRAIN_SOURCES, value);
}
