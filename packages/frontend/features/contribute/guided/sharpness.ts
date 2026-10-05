/**
 * Cheap per-frame signals for the guided-capture coach.
 *
 * The preview is sampled a few times a second into a small RGBA image (a
 * centre crop, downscaled), and these functions turn it into two numbers:
 *
 *  - `sharpness` — the variance of the 4-neighbour Laplacian of the luma.
 *    Edges give the Laplacian large positive and negative values; motion blur
 *    and defocus smear them out, so the variance drops. It is the standard
 *    "is this frame blurry" measure because it costs one pass and no model.
 *  - `brightness` — mean luma, 0–255. Used to notice exposure jumping between
 *    samples and scenes too dark to reconstruct.
 *
 * Pure and allocation-light so they run on the UI thread at 4 Hz without
 * showing up in a profile, and so they are unit-testable without a camera.
 */

export interface FrameSignals {
  /** Laplacian variance of the sampled luma. Scene-dependent: compare, do not threshold blindly. */
  sharpness: number;
  /** Mean luma, 0–255. */
  brightness: number;
}

/** Rec. 601 luma of an RGBA buffer (`ImageData.data` layout). Alpha is ignored. */
export function toLuma(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const pixels = width * height;
  if (rgba.length < pixels * 4) throw new RangeError('The RGBA buffer is smaller than width × height.');
  const luma = new Float32Array(pixels);
  for (let i = 0, p = 0; i < pixels; i += 1, p += 4) {
    luma[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return luma;
}

/**
 * Variance of the 4-neighbour Laplacian over the interior pixels.
 *
 * The one-pixel border is skipped rather than padded: padding invents edges
 * at the frame boundary, which would make every frame look a little sharper
 * than it is. An image smaller than 3×3 has no interior and scores 0.
 */
export function laplacianVariance(luma: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x;
      const value = luma[i - width] + luma[i + width] + luma[i - 1] + luma[i + 1] - 4 * luma[i];
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}

/** Mean of a luma buffer; 0 for an empty one. */
export function meanLuma(luma: ArrayLike<number>): number {
  if (luma.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < luma.length; i += 1) sum += luma[i];
  return sum / luma.length;
}

/** Both signals from one RGBA sample. */
export function frameSignals(rgba: ArrayLike<number>, width: number, height: number): FrameSignals {
  const luma = toLuma(rgba, width, height);
  return { sharpness: laplacianVariance(luma, width, height), brightness: meanLuma(luma) };
}

/**
 * The source rectangle to sample: the centre half of the frame, keeping its
 * aspect ratio, so a 4K frame is downscaled ~6× instead of ~12× and mild
 * motion blur survives the downscale. The centre is also where façades are
 * when the camera is pointed correctly; the sky and the pavement are at the
 * edges and would only dilute the score.
 */
export function centreCrop(frameWidth: number, frameHeight: number, fraction = 0.5): { x: number; y: number; width: number; height: number } {
  const width = Math.max(1, Math.round(frameWidth * fraction));
  const height = Math.max(1, Math.round(frameHeight * fraction));
  return { x: Math.round((frameWidth - width) / 2), y: Math.round((frameHeight - height) / 2), width, height };
}

/** Sample dimensions for a crop: `maxWidth` wide (or less), same aspect ratio. */
export function sampleSize(cropWidth: number, cropHeight: number, maxWidth = 320): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / Math.max(1, cropWidth));
  return { width: Math.max(3, Math.round(cropWidth * scale)), height: Math.max(3, Math.round(cropHeight * scale)) };
}
