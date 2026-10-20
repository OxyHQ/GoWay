import type { Lod2Surface } from './lod2Tiles';
import type { Point2 } from './mesher';
import type { OsmBuilding } from './osmTiles';

const bounds = (rings: Point2[][]) => {
  const points = rings.flat();
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
};
const inside = (rings: Point2[][], x: number, y: number) => {
  let hit = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i],
        b = ring[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
        hit = !hit;
    }
  return hit;
};
/** Interior overlap, excluding neighbouring buildings that merely share a wall. */
function overlaps(a: Point2[][], b: Point2[][]): boolean {
  const aa = bounds(a),
    bb = bounds(b);
  const x0 = Math.max(aa[0], bb[0]),
    y0 = Math.max(aa[1], bb[1]);
  const x1 = Math.min(aa[2], bb[2]),
    y1 = Math.min(aa[3], bb[3]);
  if (x1 <= x0 || y1 <= y0) return false;
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 5; j++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / 5,
        y = y0 + ((y1 - y0) * (j + 0.5)) / 5;
      if (inside(a, x, y) && inside(b, x, y)) return true;
    }
  return false;
}

/**
 * One geometry owner per building. Roof-only archives cannot describe an
 * underside: preserve recorded elevated parts rather than filling their voids.
 * Also reads already-published archives, which retain both original sources.
 */
export function buildingSources(buildings: OsmBuilding[], surfaces: Lod2Surface[]) {
  const groups = new Map<string, Lod2Surface[]>();
  const key = (s: Lod2Surface) => `${s.source}/${s.sourceId ?? s.osmId}`;
  for (const surface of surfaces) {
    const id = key(surface),
      group = groups.get(id);
    if (group) group.push(surface);
    else groups.set(id, [surface]);
  }
  const rejected = new Set<string>();
  const restored = new Set<number>();
  for (const part of buildings) {
    if (!part.part || part.base <= 0) continue;
    for (const [id, group] of groups) {
      if (group.some((s) => overlaps(part.rings, s.rings))) rejected.add(id);
    }
  }
  for (const id of rejected) {
    const group = groups.get(id) ?? [];
    for (const building of buildings) {
      if (
        group.some(
          (s) =>
            (building.drawnBy === s.source || building.heightSource === 'cadastre') &&
            overlaps(building.rings, s.rings),
        )
      ) {
        restored.add(building.id);
      }
    }
  }
  return {
    buildings: buildings
      .filter((b) => !b.drawnBy || restored.has(b.id))
      .map((b) =>
        restored.has(b.id)
          ? {
              ...b,
              top: b.osmTop ?? b.top,
              levels: b.osmLevels,
              drawnBy: undefined,
              heightSource: undefined,
            }
          : b,
      ),
    surfaces: surfaces.filter((s) => !rejected.has(key(s))),
  };
}
