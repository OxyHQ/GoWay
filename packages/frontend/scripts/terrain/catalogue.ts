/**
 * The terrain SETS GoWay builds (`docs/MAP_TERRAIN_GLOBE.md` → "The
 * archive"): which bare-earth model, read how, in which datum, over where.
 *
 * A set is one source at one vintage; its id names both, so a new survey is a
 * new set listed first, never an overwrite. ORDER IS PRIORITY: where two sets
 * publish the same tile, the Worker answers with the first. Its sources must
 * be in `lib/map/terrainSources.ts`, where the licence decision is recorded.
 *
 * Every set is built the same way (`build-terrain-set.ts`): the source warped
 * to a z14 analysis grid with heights in EGM2008, judged against the
 * footprints and tree stands the map draws on it (`gate.ts`), blended into
 * the fallback terrain where it ends, then averaged down to z12 and the
 * pyramid. Nothing in a set definition is about one place.
 */
import { TERRAIN_SOURCES, type TerrainSourceId } from '../../lib/map/terrainSources';
import type { LonLatBox } from '../imagery/cells';

/** How a set's heights are read for one window (`inputs.ts`). */
export type TerrainInput =
  /** One GDAL-readable raster (a COG over HTTP): every window reads its pixels by range. */
  | { kind: 'raster'; url: string }
  /**
   * USGS 3DEP's seamless products: an index GeoPackage of COG tiles; the
   * tiles meeting a window are mosaicked (later on top).
   */
  | { kind: 'usgs-index'; index: string; layer: string }
  /**
   * IGN's RGE ALTI, one 7z archive of 1 m GeoTIFFs per département, listed by
   * an ATOM feed; the archives meeting a window are downloaded once (cached),
   * extracted and mosaicked.
   */
  | { kind: 'ign-atom'; feed: string; product: string }
  /**
   * GSI's elevation tiles (web-mercator PNG, 256 px, heights × 100 in 24 bits):
   * the first template with a tile wins, pixel for pixel.
   */
  | { kind: 'gsi-tiles'; templates: readonly { url: string; zoom: number }[] };

export interface TerrainSetDefinition {
  id: string;
  name: string;
  sources: readonly TerrainSourceId[];
  /** When the ground was surveyed, as the source states it. */
  vintage: string;
  /** Where the set has data; cells are planned where they touch it. */
  extent: LonLatBox;
  input: TerrainInput;
  /**
   * The heights' compound CRS, horizontal + vertical (`EPSG:25831+5782`):
   * PROJ takes them to web mercator + EGM2008 (`warp.ts`).
   */
  crs: string;
  /**
   * A PROJ pipeline to use instead of the one PROJ picks, when PROJ's pick is
   * worse than the data (3DEP: PROJ's NAD83(2011) → WGS 84 step is a null
   * transformation, 1.25 m off vertically in New York).
   */
  transform?: string;
  /** The source's pixel on the ground (m), for the resampling and the gate's ring. */
  pixelM: number;
  /**
   * Correct failed footprints with the ground around them (`gate.ts` →
   * `correctWindow`). Only where no cleaner source exists, and only after
   * its gate numbers are in the doc: none of the sets below needs it.
   */
  correct: boolean;
}

/** The zoom tiles are published to: what MapLibre's DEM source requests (`lib/map/style/relief.ts`). */
export const TERRAIN_MAX_ZOOM = 12;
/** The coarsest zoom a set publishes; below it the fallback terrain is drawn, where a datum or source step is under a pixel. */
export const TERRAIN_MIN_ZOOM = 7;
/** One archive per tile of this zoom: z7–12 in a cell is 1,365 tiles (~120 MB at the measured ~90 KB). */
export const TERRAIN_CELL_ZOOM = 7;
/** The analysis grid: z14 (512 px tiles), 2.4–4.8 m pixels — the gate sees a house. */
export const TERRAIN_ANALYSIS_ZOOM = 14;
/** Each cell is processed in blocks of this zoom's tiles: a z10 block is 8,192² analysis pixels. */
export const TERRAIN_BLOCK_ZOOM = 10;

/** USGS's corrected NAD83(2011)/NAVD88 → WGS 84/EGM2008 pipeline (Conus Albers in, web mercator out). */
const USGS_CONUS_TO_EGM2008 = [
  '+proj=pipeline',
  '+step +inv +proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +ellps=GRS80',
  '+step +proj=vgridshift +grids=us_noaa_g2018u0.tif +multiplier=1',
  '+step +proj=cart +ellps=GRS80',
  // EPSG's ITRF2014 → NAD83(2011) (time-dependent, epoch 2010.0), inverted.
  '+step +inv +proj=helmert +x=1.0053 +y=-1.90921 +z=-0.54157 +rx=0.02678138 +ry=-0.00042027',
  '+rz=0.01093206 +s=0.00036891 +dx=0.00079 +dy=-0.0006 +dz=-0.00144 +drx=6.667e-05',
  '+dry=-0.00075744 +drz=-5.133e-05 +ds=-7.201e-05 +t_epoch=2010 +t_obs=2010',
  '+convention=coordinate_frame',
  '+step +inv +proj=cart +ellps=WGS84',
  '+step +inv +proj=vgridshift +grids=us_nga_egm08_25.tif +multiplier=1',
  '+step +proj=webmerc +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +ellps=WGS84',
].join(' ');

export const TERRAIN_SETS: readonly TerrainSetDefinition[] = [
  {
    id: 'icgc-met-2021',
    name: 'Catalonia — ICGC terrain model, 5 m (LiDAR 2021–2023)',
    sources: ['icgc-met'],
    vintage: '2021–2023',
    extent: [0.15, 40.52, 3.33, 42.87],
    input: {
      kind: 'raster',
      url: 'https://datacloud.icgc.cat/datacloud/model-elevacions-terreny/tif_unzip/model-elevacions-terreny-lidar-catalunya-5m-2021-2023.tif',
    },
    // ICGC's heights are orthometric on the Alicante datum (its EGM08D595
    // geoid); IGN's EGM08-REDNAP grid models the same surface.
    crs: 'EPSG:25831+5782',
    pixelM: 5,
    correct: false,
  },
  {
    id: 'ign-rgealti-2',
    name: 'France — IGN RGE ALTI® 1 m',
    sources: ['ign-rgealti'],
    vintage: '2009–2021',
    extent: [-5.3, 41.3, 9.6, 51.15],
    input: {
      kind: 'ign-atom',
      feed: 'https://data.geopf.fr/telechargement/resource/RGEALTI',
      product: 'RGEALTI_2-0_1M_TIF_LAMB93-IGN69',
    },
    crs: 'EPSG:2154+5720',
    pixelM: 1,
    correct: false,
  },
  {
    id: 'usgs-3dep-s1m',
    name: 'United States — USGS 3DEP seamless 1 m',
    sources: ['usgs-3dep'],
    vintage: '2026 release',
    extent: [-125, 24.4, -66.9, 49.4],
    input: {
      kind: 'usgs-index',
      index:
        'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/S1M/FullExtentSpatialMetadata/S1M_Products.gpkg',
      layer: 'current',
    },
    crs: 'EPSG:6350+5703',
    transform: USGS_CONUS_TO_EGM2008,
    pixelM: 1,
    correct: false,
  },
  {
    id: 'gsi-dem5a',
    name: 'Japan — GSI elevation tiles, 5 m laser (10 m where not surveyed)',
    sources: ['gsi-dem'],
    vintage: 'GSI current',
    extent: [122.9, 24.0, 146.0, 45.6],
    input: {
      kind: 'gsi-tiles',
      templates: [
        { url: 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png', zoom: 15 },
        { url: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png', zoom: 14 },
      ],
    },
    // Orthometric heights above Tokyo Bay mean sea level (JGD2011 vertical).
    crs: 'EPSG:3857+6695',
    pixelM: 5,
    correct: false,
  },
];

/** A catalogue set by id, checked against the source list. */
export function catalogueSet(id: string): TerrainSetDefinition {
  const set = TERRAIN_SETS.find((candidate) => candidate.id === id);
  if (!set) throw new Error(`no terrain set "${id}" (${TERRAIN_SETS.map((s) => s.id).join(', ')})`);
  for (const source of set.sources) {
    if (!Object.hasOwn(TERRAIN_SOURCES, source))
      throw new Error(`set ${id}: unknown source ${source}`);
  }
  return set;
}
