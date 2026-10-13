import earcut from 'earcut';
import { Clipper, ClipType, JS, PolyFillType, PolyTree, PolyType } from 'clipper-lib';

import { type Buffers, LAYER, SURFACE } from './meshBuffers';

type Point = [number, number];
type Polygon = Point[][];
type MultiPolygon = Polygon[];

/** Integer clipping keeps coincident boundaries identical through every operation. */
function clip(type: ClipType, subject: MultiPolygon, mask: MultiPolygon = []): MultiPolygon {
  const engine = new Clipper();
  engine.StrictlySimple = true;
  const paths = (polygons: MultiPolygon) =>
    polygons.flatMap((polygon) =>
      polygon.map((ring, i) => {
        const path = ring.map(([x, y]) => ({ X: Math.round(x), Y: Math.round(y) }));
        if (Clipper.Orientation(path) !== (i === 0)) path.reverse();
        return path;
      }),
    );
  engine.AddPaths(paths(subject), PolyType.ptSubject, true);
  engine.AddPaths(paths(mask), PolyType.ptClip, true);
  const tree = new PolyTree();
  engine.Execute(type, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return JS.PolyTreeToExPolygons(tree).map(({ outer, holes }) =>
    [outer, ...holes].map((path) => {
      const ring: Point[] = path.map((p) => [p.X, p.Y]);
      ring.push([...ring[0]]);
      return ring;
    }),
  );
}
const union = (a: MultiPolygon, b: MultiPolygon = []) => clip(ClipType.ctUnion, [...a, ...b]);
const intersection = (a: MultiPolygon, b: Polygon) => clip(ClipType.ctIntersection, a, [b]);
const difference = (a: MultiPolygon, b: MultiPolygon) => clip(ClipType.ctDifference, a, b);
/** Polygon operations use millimetres, well below the archive's coordinate precision. */
const SCALE = 1000;

/**
 * One partition of street space per elevation stratum. Roads, sidewalks and
 * paths are dissolved before triangulation; no independently overlapping
 * slabs and no guessed islands at intersections. Neighbours contribute to
 * the topology, then the result is clipped to the exact owning tile.
 */
export class StreetTopology {
  private groups = new Map<
    string,
    { material: number; span: number; z: number; polygons: Polygon[] }
  >();
  constructor(
    private readonly sizeM: number,
    private readonly triangulationSpanM: number,
  ) {}

  add(ring: readonly Point[], z: number, material: number, span: number): void {
    if (ring.length < 3) return;
    if (
      ring.every(([x]) => x < 0) ||
      ring.every(([x]) => x > this.sizeM) ||
      ring.every(([, y]) => y > 0) ||
      ring.every(([, y]) => y < -this.sizeM)
    )
      return;
    const points: Point[] = ring.map(([x, y]) => [Math.round(x * SCALE), Math.round(y * SCALE)]);
    const area = points.reduce((sum, p, i) => {
      const q = points[(i + 1) % points.length];
      return sum + p[0] * q[1] - p[1] * q[0];
    }, 0);
    if (Math.abs(area) < 1) return;
    const key = `${span}/${material}/${z}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { material, span, z, polygons: [] };
      this.groups.set(key, group);
    }
    group.polygons.push([points]);
  }

  build(simple: Buffers, full: Buffers): void {
    const s = Math.round(this.sizeM * SCALE);
    const bounds: Polygon = [
      [
        [0, 0],
        [s, 0],
        [s, -s],
        [0, -s],
        [0, 0],
      ],
    ];
    const occupied = new Map<number, MultiPolygon>();
    const priority = (material: number) =>
      material === SURFACE.asphalt ? 0 : material === SURFACE.sidewalk ? 1 : 2;
    for (const group of [...this.groups.values()].sort(
      (a, b) => priority(a.material) - priority(b.material),
    )) {
      const merged = intersection(union(group.polygons), bounds);
      const mask = occupied.get(group.span);
      const polygons = mask?.length ? difference(merged, mask) : merged;
      occupied.set(group.span, mask?.length ? union(mask, merged) : merged);
      const attr = [
        group.material,
        255,
        group.material === SURFACE.sidewalk
          ? LAYER.sidewalk
          : group.material === SURFACE.asphalt
            ? LAYER.asphalt
            : LAYER.paving,
        group.span,
      ];
      // Partition before earcut. Triangulating a city-wide polygon directly
      // produces kilometre-long needles which explode under terrain refinement.
      const step = this.triangulationSpanM * SCALE;
      const rectangle = (x0: number, y0: number, x1: number, y1: number): Polygon => [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0],
        ],
      ];
      const patches: Polygon[] = [];
      const range = (geometry: MultiPolygon, axis: number) => {
        let min = Infinity,
          max = -Infinity;
        for (const polygon of geometry)
          for (const p of polygon[0]) {
            min = Math.min(min, p[axis]);
            max = Math.max(max, p[axis]);
          }
        return [min, max];
      };
      const [y0, y1] = range(polygons, 1);
      for (let y = Math.floor(y0 / step) * step; y < y1; y += step) {
        const row = intersection(polygons, rectangle(0, y, s, Math.min(0, y + step)));
        if (!row.length) continue;
        const [x0, x1] = range(row, 0);
        for (let x = Math.floor(x0 / step) * step; x < x1; x += step)
          patches.push(
            ...intersection(row, rectangle(x, y, Math.min(s, x + step), Math.min(0, y + step))),
          );
      }
      for (const polygon of patches) {
        const coords: number[] = [],
          holes: number[] = [];
        for (const [i, closed] of polygon.entries()) {
          if (i) holes.push(coords.length / 2);
          for (const [x, y] of closed.slice(0, -1)) coords.push(x / SCALE, y / SCALE);
        }
        const base = simple.vertexCount;
        for (let i = 0; i < coords.length; i += 2)
          simple.vertex(coords[i], coords[i + 1], group.z, attr);
        const indices = earcut(coords, holes);
        for (let i = 0; i < indices.length; i += 3)
          simple.triangle(base + indices[i], base + indices[i + 1], base + indices[i + 2]);
      }
      const sidewalk = group.material === SURFACE.sidewalk;
      if (!sidewalk && !(group.material === SURFACE.asphalt && group.span > 0)) continue;
      const bottom = sidewalk ? 0 : -0.4;
      for (const polygon of polygons) {
        // Kerbs belong to the final sidewalk boundary, never to an internal
        // seam between two input slabs or to the artificial tile boundary.
        for (const ring of polygon)
          for (let i = 1; i < ring.length; i++) {
            const a = ring[i - 1],
              b = ring[i];
            if (
              (Math.abs(a[0]) < 0.01 && Math.abs(b[0]) < 0.01) ||
              (Math.abs(a[0] - s) < 0.01 && Math.abs(b[0] - s) < 0.01) ||
              (Math.abs(a[1]) < 0.01 && Math.abs(b[1]) < 0.01) ||
              (Math.abs(a[1] + s) < 0.01 && Math.abs(b[1] + s) < 0.01)
            )
              continue;
            const v = full.vertexCount,
              face = [SURFACE.kerb, 170, LAYER.sidewalk, group.span];
            full.vertex(a[0] / SCALE, a[1] / SCALE, bottom, face);
            full.vertex(b[0] / SCALE, b[1] / SCALE, bottom, face);
            full.vertex(b[0] / SCALE, b[1] / SCALE, group.z, face);
            full.vertex(a[0] / SCALE, a[1] / SCALE, group.z, face);
            full.triangle(v, v + 1, v + 2);
            full.triangle(v, v + 2, v + 3);
          }
      }
    }
  }
}
