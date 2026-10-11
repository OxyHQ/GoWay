/**
 * Moving along a published track — pure arithmetic over an operator's shape
 * (`LiveShape`: positions in travel order and the running length at each).
 *
 * A vehicle on a track is placed by ONE number, its distance along the shape,
 * and moved by changing that number; its position, its heading and the
 * placement of each car of a train are read off the polyline at that
 * distance. So it can only ever be somewhere on the line the operator
 * published — round every curve, never across one.
 */

export interface TrackShape {
  /** `[longitude, latitude]`, in order of travel. */
  coordinates: readonly (readonly [number, number])[];
  /** Metres along the shape at each position, non-decreasing. */
  alongMeters: readonly number[];
  lengthMeters: number;
}

export interface TrackPoint {
  latitude: number;
  longitude: number;
  /** Degrees clockwise from north, in the direction of travel. */
  heading: number;
}

const DEG = Math.PI / 180;

/** The index of the segment holding `along` (binary search). */
function segmentAt(shape: TrackShape, along: number): number {
  const a = shape.alongMeters;
  let lo = 0;
  let hi = a.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((a[mid] as number) <= along) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function bearing(from: readonly [number, number], to: readonly [number, number]): number {
  const dx = (to[0] - from[0]) * Math.cos(((from[1] + to[1]) / 2) * DEG);
  const dy = to[1] - from[1];
  return (((Math.atan2(dx, dy) / DEG) % 360) + 360) % 360;
}

/** The point at `along` metres (clamped to the shape), and the way the track runs there. */
export function pointAlong(shape: TrackShape, along: number): TrackPoint {
  const s = Math.max(0, Math.min(shape.lengthMeters, along));
  const i = segmentAt(shape, s);
  const p = shape.coordinates[i] as readonly [number, number];
  let q = shape.coordinates[i + 1] as readonly [number, number];
  let j = i + 1;
  // A repeated point has no direction: look ahead for one that does.
  while (q[0] === p[0] && q[1] === p[1] && j + 1 < shape.coordinates.length) {
    j++;
    q = shape.coordinates[j] as readonly [number, number];
  }
  const a0 = shape.alongMeters[i] as number;
  const a1 = shape.alongMeters[i + 1] as number;
  const t = a1 > a0 ? (s - a0) / (a1 - a0) : 0;
  const next = shape.coordinates[i + 1] as readonly [number, number];
  return {
    longitude: p[0] + (next[0] - p[0]) * t,
    latitude: p[1] + (next[1] - p[1]) * t,
    heading: bearing(p, q),
  };
}

/**
 * Where each car of a consist sits: `cars` cars of `carLength` metres with
 * `gap` between them, CENTRED on `along` (a report says where the train is,
 * not where its cab is), the first car leading. Each car follows the curve on
 * its own: its centre on the line, its heading the line's there.
 */
export function consistAlong(
  shape: TrackShape,
  along: number,
  cars: number,
  carLength: number,
  gap: number,
): TrackPoint[] {
  const total = cars * carLength + (cars - 1) * gap;
  const front = along + total / 2;
  const out: TrackPoint[] = [];
  for (let k = 0; k < cars; k++)
    out.push(pointAlong(shape, front - carLength / 2 - k * (carLength + gap)));
  return out;
}

/**
 * Cars laid in a straight line behind a point — for a vehicle that is NOT on
 * a known track, where any curve would be invented. Centred like
 * {@link consistAlong}.
 */
export function consistStraight(
  at: { latitude: number; longitude: number },
  heading: number,
  cars: number,
  carLength: number,
  gap: number,
): TrackPoint[] {
  const total = cars * carLength + (cars - 1) * gap;
  const metresPerDegLat = 111_195;
  const metresPerDegLon = metresPerDegLat * Math.cos(at.latitude * DEG);
  const out: TrackPoint[] = [];
  for (let k = 0; k < cars; k++) {
    const offset = total / 2 - carLength / 2 - k * (carLength + gap);
    out.push({
      latitude: at.latitude + (Math.cos(heading * DEG) * offset) / metresPerDegLat,
      longitude: at.longitude + (Math.sin(heading * DEG) * offset) / metresPerDegLon,
      heading,
    });
  }
  return out;
}
