/**
 * EXIF/QuickTime GPS normalization.
 *
 * ## The normalization that has to happen somewhere, and why it happens here
 *
 * EXIF does not store a coordinate. It stores a magnitude as three rationals —
 * degrees, minutes, seconds — and a SEPARATE reference tag holding one letter
 * for the hemisphere. Nothing in the magnitude is signed, so `41° 23' 6.36" `
 * with `GPSLatitudeRef = S` is *minus* 41.385, and the same magnitude with `N`
 * is plus 41.385. Dropping the ref tag is the classic EXIF bug: it does not
 * fail, it silently relocates a photo to the mirror latitude — Barcelona
 * becomes a point in the South Atlantic — and every downstream query still
 * returns rows.
 *
 * So the conversion lives in one tested function rather than at each call site,
 * and it REFUSES rather than clamps. A magnitude with 70 minutes in it, or a
 * latitude past the pole, is a corrupt tag or a mis-parse; clamping it to 90
 * would turn a detectable error into a confident wrong position, which is the
 * one outcome geographic code must never produce.
 *
 * ## What this module deliberately does not do
 *
 * It does not open a file. The GoWay API never touches media bytes — they go
 * straight to the object store — so the EXIF that reaches this module is what a
 * client PARSED and sent, and the normalized result is recorded with witness
 * `client` for exactly that reason. Reading the tags out of the stored object
 * and recording them with witness `goway_ingest` is ingest's job, in #11; this
 * module is the shared conversion both sides use, so the two witnesses cannot
 * disagree because of arithmetic.
 */

import type { GeoCoordinate } from '@goway/shared-types';

/** One EXIF GPS magnitude plus its hemisphere reference tag. */
export interface ExifGpsMagnitude {
  degrees: number;
  minutes?: number;
  seconds?: number;
  /** `N`/`S` for a latitude, `E`/`W` for a longitude. Case-insensitive. */
  ref: string;
}

/** A GPS block as a client reads it out of a photo. */
export interface ExifGpsBlock {
  latitude: ExifGpsMagnitude;
  longitude: ExifGpsMagnitude;
  /** `GPSAltitude`, in metres, always non-negative in EXIF. */
  altitude?: number;
  /** `GPSAltitudeRef`: 0 above sea level, 1 below. */
  altitudeRef?: number;
  /** `GPSImgDirection`, degrees. */
  imageDirection?: number;
}

/** The normalized result, or `null` when the tags do not describe a position. */
export interface NormalizedExifGps {
  coordinate: GeoCoordinate;
  altitudeMeters?: number;
  headingDegrees?: number;
}

const NEGATIVE_REFS = new Set(['s', 'w']);
const POSITIVE_REFS = new Set(['n', 'e']);

function isFiniteNonNegative(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}

/**
 * One EXIF magnitude plus its ref, as signed decimal degrees.
 *
 * Returns `null` rather than a best effort. `minutes` and `seconds` must be
 * inside their sexagesimal ranges — 61 minutes is not 1° 1', it is a tag this
 * code did not understand — and the ref must be one of the four letters,
 * because an absent or unrecognised one is the exact condition under which a
 * hemisphere gets guessed wrong.
 */
export function exifGpsToDecimal(magnitude: ExifGpsMagnitude): number | null {
  const { degrees, minutes = 0, seconds = 0 } = magnitude;
  if (!Number.isFinite(degrees) || degrees < 0) return null;
  if (!isFiniteNonNegative(minutes) || minutes >= 60) return null;
  if (!isFiniteNonNegative(seconds) || seconds >= 60) return null;

  const ref = magnitude.ref.trim().toLowerCase();
  if (!NEGATIVE_REFS.has(ref) && !POSITIVE_REFS.has(ref)) return null;

  const decimal = degrees + minutes / 60 + seconds / 3600;
  return NEGATIVE_REFS.has(ref) ? -decimal : decimal;
}

/**
 * A whole EXIF GPS block as a GoWay coordinate.
 *
 * The hemisphere refs are checked against the AXIS as well as against the set
 * of valid letters: `GPSLatitudeRef = E` is not a latitude with an odd ref, it
 * is a block whose two magnitudes have been swapped — the single most expensive
 * mistake in geographic code, and one that produces a plausible point rather
 * than an error. Refusing it here is the only cheap place to catch it.
 */
export function normalizeExifGps(block: ExifGpsBlock): NormalizedExifGps | null {
  const latitudeRef = block.latitude.ref.trim().toLowerCase();
  const longitudeRef = block.longitude.ref.trim().toLowerCase();
  if (latitudeRef !== 'n' && latitudeRef !== 's') return null;
  if (longitudeRef !== 'e' && longitudeRef !== 'w') return null;

  const latitude = exifGpsToDecimal(block.latitude);
  const longitude = exifGpsToDecimal(block.longitude);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  const result: NormalizedExifGps = { coordinate: { latitude, longitude } };

  if (block.altitude !== undefined && Number.isFinite(block.altitude) && block.altitude >= 0) {
    // `GPSAltitudeRef = 1` means BELOW sea level and the magnitude stays
    // positive, the same trap the hemisphere refs carry. A dive site and a
    // mountain must not normalize to the same number.
    result.altitudeMeters = block.altitudeRef === 1 ? -block.altitude : block.altitude;
  }

  if (block.imageDirection !== undefined && Number.isFinite(block.imageDirection)) {
    // Wrapped into `[0, 360)` rather than refused: 360 and -10 are both real
    // things a compass writes, and both name a real direction unambiguously.
    const wrapped = ((block.imageDirection % 360) + 360) % 360;
    result.headingDegrees = wrapped;
  }

  return result;
}

/**
 * An EXIF orientation tag, or `undefined` when it is not one.
 *
 * 1–8, and anything else — 0, 9, a float, a string a client coerced badly — is
 * dropped rather than defaulted to 1. Defaulting would assert "this image is
 * already upright", which is a claim about pixels nobody has looked at, and a
 * reconstruction that trusts it matches features against a sideways façade.
 */
export function normalizeExifOrientation(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= 8 ? value : undefined;
}
