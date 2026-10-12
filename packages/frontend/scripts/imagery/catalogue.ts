/**
 * The imagery SETS GoWay builds (`docs/MAP_SATELLITE.md` → Sets): what each
 * is made from, at which zooms, for which tier, and how it is cut into cells.
 *
 * A set is one source (or one composite of sources) at one vintage. Its id
 * names both — `icgc-ortofoto-2025` — so a new flight is a new set listed
 * first, never an overwrite of the old one. Its sources must be in
 * `lib/map/imagerySources.ts`, where the licence decision is recorded; the
 * catalogue only says how to build what that file allows.
 *
 * ## Sizing a set's cells
 *
 * One archive per cell, uploaded with `wrangler r2 object put`, which refuses
 * objects over 300 MiB (`scripts/city-r2.sh`). A cell holds every zoom of the
 * set inside it — `4^k · 4/3` tiles for `k` zooms below the cell's — and an
 * imagery tile is 40–65 KB (measured, `docs/MAP_SATELLITE.md` → Encoding), so
 * a set spans at most six zooms from its `cellZoom` (≤ 5,461 tiles, ≤ ~250 MB
 * at the measured densest). With S3 multipart uploads (an R2 access key; an
 * owner decision) cells could be four times as large and the manifest smaller,
 * at no other change.
 */
import { IMAGERY_TIERS, type ImageryTierId } from '../../lib/map/imagery';
import { IMAGERY_SOURCES, type ImagerySourceId } from '../../lib/map/imagerySources';
import type { LonLatBox } from './cells';

/** How a set's pixels are obtained for one cell (`build-satellite-set.ts` → `prepareCell`). */
export type ImageryInput =
  /**
   * An orthophoto readable by GDAL (`/vsicurl/` URL or a local path given with
   * `--input`): warped to the cell in parallel strips, lanczos, alpha kept.
   */
  | { kind: 'ortho'; url: string }
  /**
   * ESA WorldCover's yearly Sentinel-2 median composite (16-bit reflectance,
   * 1° COGs on AWS), colour-stretched to sRGB. The composite has no sea, and
   * neither do these tiles: it is transparent, and the style's ocean (Blue
   * Marble's own deep blue, `IMAGERY_OCEAN`) shows through — the same colour
   * at every zoom, where a 1.85 km Blue Marble pixel up-sampled to 10 m
   * would be a blur that changes at every coast.
   */
  | { kind: 'worldcover'; year: 2020 | 2021 }
  /** NASA's Blue Marble alone, for the zooms where 10 m is not yet needed. */
  | { kind: 'blue-marble' };

export interface ImagerySetDefinition {
  id: string;
  name: string;
  sources: readonly ImagerySourceId[];
  tiers: readonly ImageryTierId[];
  minZoom: number;
  maxZoom: number;
  cellZoom: number;
  /** When the pixels were captured, as the source states it. */
  vintage: string;
  /** Cells are planned where they touch this box (the source's footprint). */
  extent: LonLatBox;
  input: ImageryInput;
  /** WebP quality (`docs/MAP_SATELLITE.md` → Encoding). */
  quality: number;
}

/** The world as web mercator draws it. */
const WORLD: LonLatBox = [-180, -85.0511287798, 180, 85.0511287798];

/**
 * NASA's Blue Marble NG, August 2004 with topography and bathymetry: the
 * 21600 × 10800 global image (~1.85 km a pixel), the ocean of every base tile.
 */
export const BLUE_MARBLE_URL =
  'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73776/world.topo.bathy.200408.3x21600x10800.png';

/** ESA WorldCover's Sentinel-2 RGBNIR composites (AWS Open Data, eu-central-1, public). */
export const WORLDCOVER_BUCKET = 'https://esa-worldcover-s2.s3.eu-central-1.amazonaws.com';

/**
 * Reflectance (× 10⁴) → sRGB: `255 · (v / 4000)^(1/2.2)`. A reflectance of
 * 0.4 is white; vegetation (~0.04–0.08) lands in the low mid-tones and
 * water (~0.02) near-black but not clipped. Chosen by eye against the ICGC
 * orthophoto over Catalonia, where the two meet at z12–13.
 */
export const WORLDCOVER_STRETCH = { max: 4000, exponent: 1 / 2.2 } as const;

export const IMAGERY_SETS: readonly ImagerySetDefinition[] = [
  {
    id: 'icgc-ortofoto-2025',
    name: 'Catalonia — ICGC Ortofoto territorial 25 cm, 2025',
    sources: ['icgc-ortofoto'],
    tiers: ['detail'],
    // From z13, where 25 cm is already finer than the 10 m base by 2^5; a z12
    // cell would hold z12–18 and measured 413 MB over central Barcelona, past
    // wrangler's 300 MiB, while a z13 cell measured 107 MB.
    minZoom: 13,
    // z18 is 0.22 m a pixel at 41.5°N: the 25 cm flight, not over-sampled.
    maxZoom: 18,
    cellZoom: 13,
    vintage: '2025',
    // ICGC's own extent of the 2025 mosaic (EPSG:25831 corners, in degrees).
    extent: [0.048, 40.51, 3.358, 42.9],
    input: {
      kind: 'ortho',
      url: 'https://datacloud.icgc.cat/datacloud/orto-territorial/gpkg_unzip/ortofoto-rgb-25cm-catalunya-2025.gpkg',
    },
    quality: 80,
  },
  {
    id: 'worldcover-2021',
    name: 'Sentinel-2 yearly median 2021 (ESA WorldCover)',
    sources: ['esa-worldcover-2021'],
    tiers: ['base'],
    minZoom: 8,
    // z13 is 9.6 m a pixel at the equator: Sentinel-2's 10 m.
    maxZoom: 13,
    cellZoom: 8,
    vintage: '2021',
    extent: WORLD,
    input: { kind: 'worldcover', year: 2021 },
    quality: 80,
  },
  {
    id: 'blue-marble-2004',
    name: 'NASA Blue Marble NG, August 2004 (topography and bathymetry)',
    sources: ['nasa-blue-marble'],
    tiers: ['base'],
    minZoom: 0,
    // z7 is 0.6 km a pixel; the image is 1.85 km. Beyond z7 the 10 m set takes over.
    maxZoom: 7,
    cellZoom: 0,
    vintage: '2004-08',
    extent: WORLD,
    input: { kind: 'blue-marble' },
    quality: 80,
  },
];

/** A set by id, checked against the source registry and the tiers. */
export function catalogueSet(id: string): ImagerySetDefinition {
  const set = IMAGERY_SETS.find((candidate) => candidate.id === id);
  if (!set) {
    throw new Error(
      `unknown imagery set "${id}"; the catalogue has ${IMAGERY_SETS.map((s) => s.id).join(', ')}`,
    );
  }
  checkSet(set);
  return set;
}

export function checkSet(set: ImagerySetDefinition): void {
  for (const source of set.sources) {
    if (!Object.hasOwn(IMAGERY_SOURCES, source)) {
      throw new Error(`${set.id}: "${source}" is not in lib/map/imagerySources.ts`);
    }
  }
  if (!(set.cellZoom <= set.minZoom && set.minZoom <= set.maxZoom)) {
    throw new Error(`${set.id}: zooms must satisfy cellZoom ≤ minZoom ≤ maxZoom`);
  }
  if (set.maxZoom - set.cellZoom > 7) {
    throw new Error(`${set.id}: ${set.maxZoom - set.cellZoom + 1} zooms in a cell is too many`);
  }
  for (const tier of set.tiers) {
    const range = IMAGERY_TIERS[tier];
    if (set.maxZoom < range.minZoom || set.minZoom > range.maxZoom) {
      throw new Error(`${set.id}: zooms ${set.minZoom}–${set.maxZoom} miss the ${tier} tier`);
    }
  }
}
