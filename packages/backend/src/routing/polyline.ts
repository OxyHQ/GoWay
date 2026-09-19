/**
 * Encoded-polyline decoding, straight into GeoJSON order.
 *
 * ## Precision is 1e6 here, not the 1e5 everyone assumes
 *
 * The encoding is Google's, but the SCALE is a property of the producer, not of
 * the format, and it is not carried in the string. Valhalla emits shapes at six
 * decimal places; most decoders on the internet hardcode five, because that is
 * what Google Maps uses. Decoding a Valhalla shape at 1e5 yields coordinates
 * ten times too large — which `assertOnEarth` below catches — and encoding the
 * mistake the other way round yields coordinates ten times too SMALL, which
 * nothing catches: 41.387°N, 2.17°E becomes 4.1387°N, 0.217°E, a point in the
 * Gulf of Guinea that is a perfectly well-formed coordinate. Near the equator
 * and the prime meridian the error is small enough to look like drift. That is
 * why the default lives here as a named constant instead of at each call site.
 *
 * ## Longitude first
 *
 * The decoder accumulates latitude and longitude (that is the order the format
 * interleaves them in) and returns `GeoPosition`, which is `[longitude,
 * latitude]`. Converting at this boundary — the one place the two spellings
 * meet — is what stops a transposed pair travelling downstream, where it yields
 * a plausible point in the wrong hemisphere rather than an error.
 */

import type { GeoPosition } from '@goway/shared-types';

/** Valhalla's shape precision: six decimal places. */
export const VALHALLA_POLYLINE_PRECISION = 6;

/** A shape string that is not a decodable polyline. */
export class PolylineDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolylineDecodeError';
  }
}

/**
 * The most 5-bit groups one varint may use.
 *
 * A coordinate delta is at most ~180 * 10^6, which is 28 bits, so six groups is
 * already generous. The cap exists so a malformed string cannot spin here: the
 * continuation bit is attacker-influenced input the moment the engine endpoint
 * is configuration-driven.
 */
const MAX_CHUNKS = 6;

function decodeSigned(encoded: string, start: number): { value: number; next: number } {
  let index = start;
  let shift = 0;
  let result = 0;
  let chunk: number;

  do {
    if (index >= encoded.length) {
      throw new PolylineDecodeError('The shape ends in the middle of a value.');
    }
    chunk = encoded.charCodeAt(index) - 63;
    index += 1;
    if (chunk < 0 || chunk > 0x3f) {
      throw new PolylineDecodeError('The shape contains a character the encoding does not use.');
    }
    result |= (chunk & 0x1f) << shift;
    shift += 5;
    if (shift > MAX_CHUNKS * 5) {
      throw new PolylineDecodeError('The shape contains an over-long value.');
    }
  } while (chunk >= 0x20);

  // The low bit is the sign, and the value is the one's complement of the
  // magnitude when it is set.
  return { value: result & 1 ? ~(result >> 1) : result >> 1, next: index };
}

function assertOnEarth(latitude: number, longitude: number): void {
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    // Almost always the wrong precision: a 1e6 shape read at 1e5 lands here.
    // The message names no coordinate — a decoded route point is a user's
    // precise location and never goes into a log line or an error message.
    throw new PolylineDecodeError('The shape decodes to a point that is not on Earth.');
  }
}

/**
 * Decode an encoded polyline into GeoJSON positions, longitude first.
 *
 * @param encoded The shape string. An empty string decodes to no positions.
 * @param precision Decimal places the producer encoded at. Defaults to
 *   Valhalla's {@link VALHALLA_POLYLINE_PRECISION}; pass 5 for a Google-style
 *   shape.
 * @throws {PolylineDecodeError} When the string is not decodable, or decodes to
 *   a point off the Earth (which is what a precision mismatch usually looks
 *   like in the direction that is detectable at all).
 */
export function decodePolyline(
  encoded: string,
  precision: number = VALHALLA_POLYLINE_PRECISION,
): GeoPosition[] {
  const factor = 10 ** precision;
  const positions: GeoPosition[] = [];
  let index = 0;
  // Accumulated as INTEGERS and divided once, per position. Accumulating in
  // floating point instead makes every point after the first carry the rounding
  // error of every point before it.
  let latitudeE = 0;
  let longitudeE = 0;

  while (index < encoded.length) {
    const latitudeDelta = decodeSigned(encoded, index);
    const longitudeDelta = decodeSigned(encoded, latitudeDelta.next);
    latitudeE += latitudeDelta.value;
    longitudeE += longitudeDelta.value;
    index = longitudeDelta.next;

    const latitude = latitudeE / factor;
    const longitude = longitudeE / factor;
    assertOnEarth(latitude, longitude);
    positions.push([longitude, latitude]);
  }

  return positions;
}
