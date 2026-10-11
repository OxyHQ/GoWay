/**
 * A building's height MEASURED from the terrain's surface model, for a
 * building nothing records the height of.
 *
 * ## Why
 *
 * A quarter of Barcelona's buildings in OpenStreetMap record neither `height`
 * nor `building:levels` (the city-tile compiler's coverage: levels 75.5%), and
 * both OpenMapTiles and GoWay's city tiles then stand them at 5 m. Beside
 * neighbours with recorded storeys, a whole Eixample block of 25 m apartment
 * buildings drew as a flat footprint (owner report; ways 249405068 and
 * 249408232 on Passeig de Gràcia carry `building=apartments` and nothing else).
 *
 * The terrain GoWay draws is Copernicus GLO-30 on Mapterhorn — a SURFACE
 * model: over a city it records the tops of buildings. Its height above the
 * ground under it (the same de-noised ground the building already stands on,
 * `terrainGround.ts`) is a measurement of how tall what stands there is — the
 * normalised surface model used to estimate building heights wherever
 * cadastral heights are missing. It is coarse (30 m cells, resampled to ~15 m
 * pixels) but it is DATA, not a guess: measured ≠ invented
 * (`docs/MAP_3D_CITY.md` → Honesty).
 *
 * ## How
 *
 * Nine samples of the surface inside the footprint's box (a 3 × 3 lattice at
 * a quarter, a half and three quarters of each side), their MEDIAN — robust
 * to a sample that falls in the street at a corner, or on a taller neighbour —
 * minus the ground the building stands on. Kept only when:
 *
 *  - nothing records the height (the tile says so; `TileMesh.polygonMeasurable`);
 *  - the terrain is on (no surface, no measurement — the 5 m default stands);
 *  - the footprint is at least {@link MEASURED.minSideM} across on both sides
 *    — a narrower one is smaller than the model's cells, and its "height" would
 *    be its neighbours';
 *  - the result is above the {@link MEASURED.floorM} default, and at most
 *    {@link MEASURED.capM} (an unrecorded tower is rare; a spike in the model
 *    over a crane or a bridge pylon is not a building).
 *
 * Precedence, highest first: official 3D data (`height_source=lod2`) >
 * OpenStreetMap tags (`osm`) > this measurement > the 5 m default.
 *
 * Pure; tested in `components/map/__tests__/city3dMeasuredHeight.test.ts`.
 */
import { GROUND, gridAt } from './terrainGround';

export const MEASURED = {
  /** Samples per side of the footprint's box (so 9 in all). */
  samplesPerSide: 3,
  /** Both sides of the footprint's box at least this, metres. */
  minSideM: 15,
  /** The default it replaces; a measurement must exceed it. */
  floorM: 5,
  /** The most a measurement may say. */
  capM: 150,
} as const;

/**
 * The height above `groundM` the surface measures over a footprint's box
 * (local metres, `minX, minY, maxX, maxY`, y north and so ≤ 0 inside the
 * tile), or `null` when it should not replace the default.
 */
export function measuredHeight(
  box: ArrayLike<number>,
  groundM: number,
  surface: Float32Array,
  tileSizeM: number,
): number | null {
  const [minX, minY, maxX, maxY] = [box[0], box[1], box[2], box[3]];
  if (Math.min(maxX - minX, maxY - minY) < MEASURED.minSideM) return null;
  const samples: number[] = [];
  const n = MEASURED.samplesPerSide;
  for (let a = 1; a <= n; a++) {
    for (let b = 1; b <= n; b++) {
      const x = minX + ((maxX - minX) * a) / (n + 1);
      const y = minY + ((maxY - minY) * b) / (n + 1);
      samples.push(gridAt(surface, GROUND.grid, x / tileSizeM, -y / tileSizeM));
    }
  }
  samples.sort((p, q) => p - q);
  const median = samples[Math.floor(samples.length / 2)];
  const height = median - groundM;
  if (!(height > MEASURED.floorM)) return null;
  return Math.min(height, MEASURED.capM);
}
