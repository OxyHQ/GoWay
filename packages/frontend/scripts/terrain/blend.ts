/**
 * Where a set ends: its heights feathered into the fallback terrain (what the
 * map draws where no set is published — Mapterhorn), so no step shows where
 * one source meets another, whatever their datums (`docs/MAP_TERRAIN_GLOBE.md`
 * → "The archive" → Seams).
 *
 * Every pixel takes `w · set + (1 − w) · fallback`, `w` rising smoothly from
 * 0 at the set's last pixel to 1 a FEATHER inside it: a 0.8 m datum step
 * becomes a 0.16% grade over 500 m, which nobody can see, and a set's own
 * ground is untouched everywhere but its outermost half kilometre.
 *
 * Only an edge on LAND is feathered. Where a set ends at the sea (its
 * no-data over water, ESA WorldCover's water class), the coast is the edge
 * of the land, not of the source: no fallback ground is drawn beside it, and
 * the set's own shore is kept — Manhattan is never more than 2 km from water.
 */

/** How far inside its own edge a set's ground reaches full weight (m). */
export const FEATHER_M = 500;

/** WorldCover's class for permanent water bodies. */
export const WORLDCOVER_WATER = 80;

/**
 * Distance (pixels) from every pixel to the nearest seed (`seeds[i] = 1`),
 * capped at `cap` — chamfer 3-4 (an octagon within 8% of Euclidean), two passes.
 */
export function distanceToSeeds(
  seeds: Uint8Array,
  width: number,
  height: number,
  cap: number,
): Float32Array {
  const far = cap * 3 + 3;
  const d = new Float32Array(seeds.length);
  for (let i = 0; i < seeds.length; i++) d[i] = seeds[i] ? 0 : far;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - width] + 3);
        if (x > 0) v = Math.min(v, d[i - width - 1] + 4);
        if (x < width - 1) v = Math.min(v, d[i - width + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < width - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < height - 1) {
        v = Math.min(v, d[i + width] + 3);
        if (x < width - 1) v = Math.min(v, d[i + width + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + width - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = Math.min(cap, d[i] / 3);
  return d;
}

/**
 * The set's heights feathered into the fallback's over `featherPx` pixels
 * inside the set's edge on land (smoothstep); where the set has none, the
 * fallback's; where neither has a height, sea level, as MapLibre draws a
 * missing DEM tile. `classes` (WorldCover) marks water, which is no edge; a
 * window that is all set is returned as the set's heights exactly.
 */
export function blendIntoFallback(
  set: Float32Array,
  fallback: Float32Array,
  width: number,
  height: number,
  featherPx: number,
  classes: Uint8Array | null,
): Float32Array {
  const seeds = new Uint8Array(set.length);
  for (let i = 0; i < set.length; i++) {
    // WorldCover's 0 is outside its tiles: the open sea.
    const water = classes !== null && (classes[i] === WORLDCOVER_WATER || classes[i] === 0);
    seeds[i] = !Number.isNaN(set[i]) || water ? 0 : 1;
  }
  const distance = distanceToSeeds(seeds, width, height, featherPx);
  const out = new Float32Array(set.length);
  for (let i = 0; i < set.length; i++) {
    const s = set[i];
    const f = Number.isNaN(fallback[i]) ? 0 : fallback[i];
    if (Number.isNaN(s)) {
      out[i] = f;
      continue;
    }
    const t = distance[i] / featherPx;
    if (t >= 1) {
      out[i] = s;
      continue;
    }
    const w = t * t * (3 - 2 * t);
    out[i] = w * s + (1 - w) * f;
  }
  return out;
}
