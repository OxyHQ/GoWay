/**
 * Terrarium, the elevation encoding MapLibre reads (`encoding: 'terrarium'`):
 * `h = R · 256 + G + B / 256 − 32768` metres, so a pixel holds −32768 to
 * +32767.996 m in steps of 1/256 m (3.9 mm).
 *
 * GoWay's tiles are LOSSLESS WebP, and lossless WebP pays for every bit of
 * noise in the low bytes. So a tile stores heights rounded to a STEP that
 * grows with the pixel (`terrainStepM`): a z12 pixel is ~10–19 m across, and
 * its height is rounded to 1/8 m (12.5 cm, under a kerb), where Mapterhorn
 * rounds to 0.5 m — a slope quantised in steps of under 1% of a pixel.
 * Measured on Paris and Tokyo's urban z12 tiles: 108 KB a tile at 1/8 m,
 * 136 KB at 1/16, 82 KB at 1/4; Mapterhorn's at 0.5 m, 63 KB
 * (`docs/MAP_TERRAIN_GLOBE.md` → "The archive" → Precision).
 */

/** The offset Terrarium adds so a height below sea level stays positive. */
const OFFSET_M = 32768;

/**
 * The height step a tile of zoom `z` is rounded to, in metres: 1/8 m at z12
 * and finer, doubling for each zoom coarser as the pixel does (1/4 m at z11,
 * …), never over 1 m. A power of two, so every step is exact in Terrarium's
 * 1/256 m.
 */
export function terrainStepM(z: number): number {
  return Math.min(1, 2 ** -(3 - Math.max(0, 12 - z)));
}

/** A height rounded to a step, as the tile will hold it. */
export function quantise(heightM: number, stepM: number): number {
  return Math.round(heightM / stepM) * stepM;
}

/**
 * Heights (row-major, `width × height`) → RGBA Terrarium pixels, each height
 * rounded to `stepM`. A height outside Terrarium's range is an error, never a
 * clamp: a −40 km or +40 km pixel is a broken source, not terrain.
 */
export function encodeTerrarium(heights: Float32Array, stepM: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(heights.length * 4);
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (!Number.isFinite(h)) throw new Error(`pixel ${i} has no height (${h})`);
    const units = Math.round((quantise(h, stepM) + OFFSET_M) * 256);
    if (units < 0 || units > 0xffffff) throw new Error(`a height of ${h} m is outside Terrarium`);
    out[i * 4] = units >> 16;
    out[i * 4 + 1] = (units >> 8) & 0xff;
    out[i * 4 + 2] = units & 0xff;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** RGBA Terrarium pixels → heights in metres, as MapLibre decodes them. */
export function decodeTerrarium(rgba: Uint8Array | Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - OFFSET_M;
  }
  return out;
}
