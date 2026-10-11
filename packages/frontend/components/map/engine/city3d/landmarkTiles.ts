/**
 * Where a landmark model meets the city mesh: which city-tile buildings it
 * hides, and which tiles must be re-meshed when that changes
 * (`docs/MAP_LANDMARKS.md` → Rendering).
 *
 * A landmark REPLACES its OpenStreetMap buildings only while its model is
 * actually drawn. Until the GLB has loaded — and for good if it fails — the
 * city's own buildings stand where they always did; a landmark never leaves a
 * hole. So the hidden set is derived from the DRAWN landmarks, and a change to
 * it re-meshes the few tiles that can hold those buildings, keeping each old
 * mesh on screen until its replacement arrives.
 *
 * Pure (no three.js, no DOM): imported by the engine and by the mesh worker,
 * and tested directly.
 */
import { mercatorXFromLng, mercatorYFromLat, type TileId, tileKey } from './tileMath';

/** The buildings NOT to mesh: one city-tile feature id per replaced element. */
export function hiddenFeatureIds(
  drawn: Iterable<string>,
  hidesById: ReadonlyMap<string, readonly number[]>,
): number[] {
  const out = new Set<number>();
  for (const id of drawn) for (const feature of hidesById.get(id) ?? []) out.add(feature);
  return [...out].sort((a, b) => a - b);
}

/** A tile's buildings without the hidden ones (the worker's filter). */
export function withoutHidden<T extends { id: number }>(
  buildings: readonly T[],
  hidden: readonly number[] | undefined,
): T[] {
  if (!hidden || hidden.length === 0) return buildings as T[];
  const set = new Set(hidden);
  return buildings.filter((building) => !set.has(building.id));
}

/**
 * The tiles at `zoom` that can hold a landmark's buildings: the one under its
 * anchor and the eight around it. The compiler puts each building WHOLE in
 * the tile of its representative point (`docs/MAP_3D_CITY.md` → Addressing),
 * and a landmark's buildings lie within a few hundred metres of its anchor —
 * less than a z15 tile (~700–900 m) — so the 3×3 block always contains them.
 */
export function tilesAround(
  position: { latitude: number; longitude: number },
  zoom: number,
): string[] {
  const n = 2 ** zoom;
  const x = Math.floor(mercatorXFromLng(position.longitude) * n);
  const y = Math.floor(mercatorYFromLat(position.latitude) * n);
  const keys: string[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ty = y + dy;
      if (ty < 0 || ty >= n) continue;
      const tile: TileId = { z: zoom, x: (((x + dx) % n) + n) % n, y: ty };
      keys.push(tileKey(tile));
    }
  }
  return keys;
}
