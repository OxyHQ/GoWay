/**
 * Which source each drawn tile comes from: GoWay's city tiles where they
 * cover the ground, the basemap's OpenMapTiles buildings everywhere else.
 *
 * The city tiles exist only where an archive was compiled (a city in
 * development, the regions published so far in production). Asking them for Madrid answers 204 for every tile — the same answer
 * a tile of open sea INSIDE Barcelona gets — so the answer cannot decide; the
 * archives' declared coverage does (`lib/map/cityTiles.ts` →
 * `CITY_COVERAGE_PATH`). The first version had no such rule and drew a flat
 * map anywhere outside an archive, with `building-3d` hidden (owner report).
 *
 * The rule, per z14 tile chosen by `lod.ts`:
 *
 *  - wholly inside a covered area AND at full detail → its z15 city tiles,
 *    all four; an empty one among them is empty ground and draws nothing;
 *  - anything else — outside, straddling the edge, or far enough for a
 *    coarser level (the city tiles have no far levels) → the OpenMapTiles
 *    tile, at its level.
 *
 * One source per z14 tile, so the two never draw the same ground twice or
 * leave a gap between them. Pure; tested in `__tests__/city3dSources.test.ts`.
 */
import type { CityCoverageArea } from '@/lib/map/cityTiles';

import { coverageCovers } from './coverageIndex';

import type { LodTile } from './lod';
import type { CityTileFormat } from './protocol';

/** A tile to draw, and which source it is fetched from. */
export interface SourcedTile extends LodTile {
  format: CityTileFormat;
}

/** What the engine knows about the city tiles: their zoom and coverage. */
export interface CityCoverage {
  tileZoom: number;
  coverage: readonly CityCoverageArea[];
}

/**
 * Assign each selected (basemap-zoom) tile its source, expanding a covered
 * full-detail tile into its city-tile children. `city: null`: all basemap.
 */
export function assignSources(tiles: readonly LodTile[], city: CityCoverage | null): SourcedTile[] {
  const out: SourcedTile[] = [];
  for (const tile of tiles) {
    if (!city || tile.lod !== 0 || city.tileZoom < tile.z || !coverageCovers(tile, city.coverage)) {
      out.push({ ...tile, format: 'openmaptiles' });
      continue;
    }
    const k = 2 ** (city.tileZoom - tile.z);
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        out.push({
          ...tile,
          z: city.tileZoom,
          x: tile.x * k + i,
          y: tile.y * k + j,
          format: 'goway',
        });
      }
    }
  }
  return out;
}
