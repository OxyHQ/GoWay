/**
 * The map's scale bar: how wide a round distance is on screen at this latitude
 * and zoom.
 *
 * Pure, so "the bar is never wider than the room, and reads a round number" is
 * a test (`test/scale.test.ts`). `MapScale` draws it with Bloom's
 * `MapScaleBar`; Bloom converts nothing, so the projection lives here.
 *
 * Web Mercator at MapLibre's zoom (512 px tiles): metres per pixel is
 * `78271.51696 · cos(latitude) / 2^zoom`.
 */

/** Metres per pixel at the equator at zoom 0, for 512 px tiles. */
const EQUATOR_METRES_PER_PIXEL = 78271.51696402048;
const METRES_PER_FOOT = 0.3048;
const FEET_PER_MILE = 5280;
/** Web Mercator ends here; past it the projection has no scale to draw. */
const MAX_LATITUDE = 85.0511;

/** The widest the bar draws, in px. */
export const SCALE_MAX_WIDTH = 100;

export type ScaleSystem = 'metric' | 'imperial';

export interface MapScaleReading {
  /** The bar's drawn length, in px. */
  width: number;
  /** The distance it stands for, as `{ value, unit }`; format it with {@link formatScale}. */
  value: number;
  unit: 'm' | 'km' | 'ft' | 'mi';
}

/** Countries whose roads and maps speak miles. */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

/** The system a locale reads, by its region: miles in the US, Liberia and Myanmar. */
export function scaleSystemFor(locale: string): ScaleSystem {
  const region = locale.split(/[-_]/)[1]?.toUpperCase();
  return region && IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
}

export function metresPerPixel(latitude: number, zoom: number): number {
  return (EQUATOR_METRES_PER_PIXEL * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

/** The largest 1, 2 or 5 × 10ⁿ that does not exceed `limit`. */
export function niceNumber(limit: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(limit));
  for (const step of [5, 2, 1]) {
    if (step * magnitude <= limit) return step * magnitude;
  }
  return magnitude;
}

/**
 * The bar for a camera, or `null` where no honest bar exists (a pole, where
 * the projection has no scale, or a camera the engine has not placed).
 */
export function scaleFor(
  latitude: number,
  zoom: number,
  system: ScaleSystem,
  maxWidth: number = SCALE_MAX_WIDTH,
): MapScaleReading | null {
  if (!(Math.abs(latitude) <= MAX_LATITUDE)) return null;
  const perPixel = metresPerPixel(latitude, zoom);
  if (!Number.isFinite(perPixel) || perPixel <= 0) return null;
  const limitMetres = perPixel * maxWidth;

  if (system === 'metric') {
    const metres = niceNumber(limitMetres);
    return metres >= 1000
      ? { width: metres / perPixel, value: metres / 1000, unit: 'km' }
      : { width: metres / perPixel, value: metres, unit: 'm' };
  }
  const limitFeet = limitMetres / METRES_PER_FOOT;
  if (limitFeet >= FEET_PER_MILE) {
    const miles = niceNumber(limitFeet / FEET_PER_MILE);
    return {
      width: (miles * FEET_PER_MILE * METRES_PER_FOOT) / perPixel,
      value: miles,
      unit: 'mi',
    };
  }
  const feet = niceNumber(limitFeet);
  return { width: (feet * METRES_PER_FOOT) / perPixel, value: feet, unit: 'ft' };
}

/** "500 m", "2 km", "1000 ft", "5 mi" — in the reader's number format. */
export function formatScale(reading: MapScaleReading, locale: string): string {
  const unit = { m: 'meter', km: 'kilometer', ft: 'foot', mi: 'mile' }[reading.unit];
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: 0,
    }).format(reading.value);
  } catch {
    // An unknown locale tag must not take the bar down.
    return `${reading.value} ${reading.unit}`;
  }
}
