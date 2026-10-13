/**
 * Closed rings from an OpenStreetMap multipolygon's member ways, and the
 * GeoJSON they make.
 *
 * A relation stores its outline as ways that meet end to end; the ring is
 * whatever those ways join into. Joined by their end points exactly as OSM
 * shares nodes, reversing a way where that is how it continues. A relation
 * whose ways do not all close into rings (a member missing from the extract, a
 * gap in the mapping) yields `null`: a zone drawn from half an outline is a
 * wrong zone, and wrong is worse than absent.
 */

import { geoGeometryContains, type GeoGeometry, type GeoPosition } from '@goway/contracts';

type Position = [number, number];

const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];

/** Joins ways into closed rings, or `null` when any way is left over. */
export function assembleRings(ways: readonly Position[][]): Position[][] | null {
  const pending = ways.filter((way) => way.length >= 2).map((way) => way.slice());
  const rings: Position[][] = [];
  while (pending.length > 0) {
    const ring = pending.pop() as Position[];
    for (;;) {
      const first = ring[0] as Position;
      const last = ring[ring.length - 1] as Position;
      if (ring.length >= 4 && same(first, last)) break;
      const at = pending.findIndex((w) => {
        const a = w[0] as Position;
        const b = w[w.length - 1] as Position;
        return same(last, a) || same(last, b);
      });
      if (at < 0) return null;
      const [next] = pending.splice(at, 1) as [Position[]];
      const joined = same(last, next[0] as Position) ? next : next.slice().reverse();
      ring.push(...joined.slice(1));
    }
    rings.push(ring);
  }
  return rings.length > 0 ? rings : null;
}

/**
 * A MultiPolygon from outer and inner member ways: each inner ring goes to the
 * outer ring that contains it. `null` when the outline does not close, or an
 * inner ring lies in no outer one.
 */
export function multiPolygonOf(
  outerWays: readonly Position[][],
  innerWays: readonly Position[][],
): Extract<GeoGeometry, { type: 'MultiPolygon' }> | null {
  const outers = assembleRings(outerWays);
  if (!outers) return null;
  const inners = innerWays.length === 0 ? [] : assembleRings(innerWays);
  if (!inners) return null;
  const polygons: Position[][][] = outers.map((outer) => [outer]);
  for (const inner of inners) {
    const probe = inner[0] as Position;
    const owner = polygons.find((polygon) =>
      geoGeometryContains(
        { type: 'Polygon', coordinates: [polygon[0] as GeoPosition[]] },
        { longitude: probe[0], latitude: probe[1] },
      ),
    );
    if (!owner) return null;
    owner.push(inner);
  }
  return { type: 'MultiPolygon', coordinates: polygons as GeoPosition[][][] };
}
