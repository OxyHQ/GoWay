/**
 * Douglas–Peucker simplification of GeoJSON areas, planar in degrees.
 *
 * Natural Earth's 1:10m borders are ~13 MB; at ~110 m they are a fraction of
 * that and put a position in the right country everywhere but within a street
 * of the line. A ring that collapses below a triangle is dropped, and a
 * polygon whose outer ring does is dropped with its holes — a speck of an
 * island the tolerance erases is not a country GoWay can place anyone in.
 */

import type { GeoGeometry, GeoPosition } from '@goway/contracts';

type Position = [number, number];
type Area = Extract<GeoGeometry, { type: 'Polygon' | 'MultiPolygon' }>;

const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

function distanceToSegment(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The line, keeping every point farther than `tolerance` from the simplified one. Iterative: a coastline can be 100,000 points. */
export function simplifyLine(points: readonly Position[], tolerance: number): Position[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop() as [number, number];
    let worst = -1;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegment(
        points[i] as Position,
        points[from] as Position,
        points[to] as Position,
      );
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at >= 0) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** A closed ring simplified, or `null` when it no longer encloses anything. */
function simplifyRing(ring: readonly GeoPosition[], tolerance: number): GeoPosition[] | null {
  const simplified = simplifyLine(
    ring.map((p): Position => [p[0], p[1]]),
    tolerance,
  );
  // Five decimals is ~1 m: the digits past it are noise that triples the size.
  const rounded = simplified.map((p): Position => [round5(p[0]), round5(p[1])]);
  return rounded.length >= 4 ? rounded : null;
}

export function simplifyArea(area: Area, tolerance: number): Area | null {
  const polygons = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
  const out: GeoPosition[][][] = [];
  for (const rings of polygons) {
    const [outer, ...holes] = rings;
    const simplifiedOuter = outer ? simplifyRing(outer, tolerance) : null;
    if (!simplifiedOuter) continue;
    out.push([
      simplifiedOuter,
      ...holes.flatMap((hole) => {
        const ring = simplifyRing(hole, tolerance);
        return ring ? [ring] : [];
      }),
    ]);
  }
  if (out.length === 0) return null;
  return out.length === 1 && area.type === 'Polygon'
    ? { type: 'Polygon', coordinates: out[0] as GeoPosition[][] }
    : { type: 'MultiPolygon', coordinates: out };
}
