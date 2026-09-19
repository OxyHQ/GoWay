/**
 * The polyline decoder, against fixtures that were not produced by it.
 *
 * The precision case is the one that matters. Valhalla encodes at six decimal
 * places and most decoders on the internet assume five, because that is what
 * Google Maps uses. Getting it wrong in the direction that IS detectable puts
 * the point off the Earth; getting it wrong the other way yields coordinates
 * ten times too small, which near the equator and the prime meridian looks like
 * a plausible route that has quietly moved to the Gulf of Guinea. A test that
 * only round-trips through this module's own encoder would pass either way,
 * which is why the first fixture below is Google's published one.
 */

import '../../__tests__/testEnv';
import { describe, expect, it } from 'bun:test';
import { decodePolyline, PolylineDecodeError, VALHALLA_POLYLINE_PRECISION } from '../polyline';

/**
 * The example from Google's own encoded-polyline documentation: the points
 * (38.5, -120.2), (40.7, -120.95) and (43.252, -126.453) at precision 5.
 * Copied verbatim, so it validates the ALGORITHM against a source outside this
 * repository rather than against its own inverse.
 */
const GOOGLE_POLYLINE5 = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

/** The same four points a Valhalla leg fixture uses, encoded at precision 6. */
const VALHALLA_POLYLINE6 = 'o~`}mA_hmcCg^_jAod@gpA_q@gpA';

describe('decodePolyline', () => {
  it('decodes the published precision-5 fixture, longitude first', () => {
    expect(decodePolyline(GOOGLE_POLYLINE5, 5)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('decodes a Valhalla shape at its own precision of 1e6', () => {
    expect(decodePolyline(VALHALLA_POLYLINE6)).toEqual([
      [2.17, 41.387],
      [2.1712, 41.3875],
      [2.1725, 41.3881],
      [2.1738, 41.3889],
    ]);
  });

  it('defaults to Valhalla’s precision', () => {
    expect(VALHALLA_POLYLINE_PRECISION).toBe(6);
    expect(decodePolyline(VALHALLA_POLYLINE6)).toEqual(
      decodePolyline(VALHALLA_POLYLINE6, VALHALLA_POLYLINE_PRECISION),
    );
  });

  it('reads a 1e6 shape at 1e5 as ten times too large, and refuses it', () => {
    // 413.87°N is not a latitude. This is the HALF of the precision mistake
    // that is detectable at all, and it must fail loudly rather than clamp.
    expect(() => decodePolyline(VALHALLA_POLYLINE6, 5)).toThrow(PolylineDecodeError);
  });

  it('reads a 1e5 shape at 1e6 as ten times too small — silently', () => {
    // The dangerous direction, asserted so the cost of the mistake is written
    // down: a route in California becomes a route in the Gulf of Guinea, and
    // every coordinate is still a well-formed one.
    const wrong = decodePolyline(GOOGLE_POLYLINE5, 6);
    expect(wrong[0]).toEqual([-12.02, 3.85]);
    expect(wrong).toHaveLength(3);
  });

  it('decodes an empty shape to no positions', () => {
    expect(decodePolyline('')).toEqual([]);
  });

  it('accumulates deltas as integers rather than as floats', () => {
    // 0.0001 added six times in floating point is 0.0005999999999999999, which
    // renders as a coordinate that is off in the sixth decimal place for every
    // point after the first. Six equal steps must land exactly.
    const stepped = decodePolyline('_c`|@_c`|@?o}@?o}@?o}@?o}@?o}@?o}@', 6);
    expect(stepped.map((position) => position[0])).toEqual([1, 1.001, 1.002, 1.003, 1.004, 1.005, 1.006]);
  });

  it('refuses a shape that ends in the middle of a pair', () => {
    expect(() => decodePolyline('_c`|@')).toThrow(PolylineDecodeError);
  });

  it('refuses a character the encoding does not use', () => {
    expect(() => decodePolyline('_c`|@_c`|@\u0001')).toThrow(PolylineDecodeError);
  });

  it('refuses an over-long varint instead of spinning on it', () => {
    // Every character here carries the continuation bit, so a decoder without
    // the cap would keep shifting until the string ran out.
    expect(() => decodePolyline('~~~~~~~~')).toThrow(PolylineDecodeError);
  });
});
