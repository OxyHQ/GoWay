import {
  Buffers,
  MODE,
  packMarkings,
  type PackedMarkings,
  type PackedSurfaces,
} from './meshBuffers';

type Vertex = { x: number; y: number; ox: number; oy: number; u: number; v: number };
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/**
 * Decals are intersections with the actual street triangles, at that triangle's
 * elevation. A mark outside its own deck has no supporting surface and is not
 * drawn. In particular it must never fall through to the terrain below a bridge.
 * The shared tessellation also keeps wide lane tints on a curved carriageway.
 */
export function groundMarkings(
  source: PackedMarkings,
  surface: PackedSurfaces,
  candidates: (minX: number, minY: number, maxX: number, maxY: number) => Iterable<number>,
): PackedMarkings {
  const simple = new Buffers();
  const full = new Buffers();
  const p = surface.positions;
  const shared = new Map<Buffers, Map<string, number>>([
    [simple, new Map()],
    [full, new Map()],
  ]);
  const vertex = (id: number): Vertex => {
    const line = source.attrs[id * 4 + 1] === MODE.line;
    const ox = line ? source.offsets[id * 2] : 0;
    const oy = line ? source.offsets[id * 2 + 1] : 0;
    return {
      x: source.positions[id * 3] + ox,
      y: source.positions[id * 3 + 1] + oy,
      ox,
      oy,
      u: source.uvs[id * 2],
      v: source.uvs[id * 2 + 1],
    };
  };
  const mix = (a: Vertex, b: Vertex, t: number): Vertex => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    ox: a.ox + (b.ox - a.ox) * t,
    oy: a.oy + (b.oy - a.oy) * t,
    u: a.u + (b.u - a.u) * t,
    v: a.v + (b.v - a.v) * t,
  });
  for (let i = 0; i < source.indices.length; i += 3) {
    const ids = [source.indices[i], source.indices[i + 1], source.indices[i + 2]];
    const triangle = ids.map(vertex);
    const attr = Array.from(source.attrs.subarray(ids[0] * 4, ids[0] * 4 + 4));
    const xs = triangle.map((v) => v.x),
      ys = triangle.map((v) => v.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const into = i < source.simpleCount ? simple : full;
    const pieces: { polygon: Vertex[]; height: (v: Vertex) => number }[] = [];
    let coveredArea = 0;
    let planar = true;
    let planeHeights: number[] | null = null;
    for (const t of candidates(minX, minY, maxX, maxY)) {
      const a = surface.indices[t],
        b = surface.indices[t + 1],
        c = surface.indices[t + 2];
      if (surface.attrs[a * 4 + 3] !== attr[3]) continue;
      const ax = p[a * 3],
        ay = p[a * 3 + 1],
        bx = p[b * 3],
        by = p[b * 3 + 1],
        cx = p[c * 3],
        cy = p[c * 3 + 1];
      if (
        Math.max(ax, bx, cx) < minX ||
        Math.min(ax, bx, cx) > maxX ||
        Math.max(ay, by, cy) < minY ||
        Math.min(ay, by, cy) > maxY
      )
        continue;
      const det = cross(bx - ax, by - ay, cx - ax, cy - ay);
      if (Math.abs(det) < 1e-9) continue;
      const sign = Math.sign(det);
      let polygon = triangle;
      const edges = [
        [ax, ay, bx, by],
        [bx, by, cx, cy],
        [cx, cy, ax, ay],
      ];
      for (const [x0, y0, x1, y1] of edges) {
        const clipped: Vertex[] = [];
        for (let j = 0; j < polygon.length; j++) {
          const prev = polygon[(j + polygon.length - 1) % polygon.length],
            next = polygon[j];
          const d0 = sign * cross(x1 - x0, y1 - y0, prev.x - x0, prev.y - y0);
          const d1 = sign * cross(x1 - x0, y1 - y0, next.x - x0, next.y - y0);
          if (d0 >= 0 !== d1 >= 0) clipped.push(mix(prev, next, d0 / (d0 - d1)));
          if (d1 >= 0) clipped.push(next);
        }
        polygon = clipped;
        if (polygon.length < 3) break;
      }
      if (polygon.length < 3) continue;
      const area = polygon.reduce((sum, v, j) => {
        const q = polygon[(j + 1) % polygon.length];
        return sum + cross(v.x - ax, v.y - ay, q.x - ax, q.y - ay);
      }, 0);
      if (Math.abs(area) < 1e-9) continue;
      coveredArea += Math.abs(area);
      const height = (v: Vertex) => {
        const wb = cross(v.x - ax, v.y - ay, cx - ax, cy - ay) / det;
        const wc = cross(bx - ax, by - ay, v.x - ax, v.y - ay) / det;
        return p[a * 3 + 2] * (1 - wb - wc) + p[b * 3 + 2] * wb + p[c * 3 + 2] * wc;
      };
      const heights = triangle.map(height);
      if (planeHeights)
        planar &&= heights.every((h, j) => Math.abs(h - (planeHeights?.[j] ?? h)) < 1e-5);
      else planeHeights = heights;
      pieces.push({ polygon, height });
    }
    const [a, b, c] = triangle;
    const area = Math.abs(cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y));
    // Crossing a triangulation edge on a plane does not require another decal
    // triangle. Retain the source triangle only if the surface covers it fully.
    const first = pieces[0];
    const output =
      first && planar && Math.abs(coveredArea - area) <= Math.max(1e-8, area * 1e-8)
        ? [{ polygon: triangle, height: first.height }]
        : pieces;
    for (const { polygon, height } of output) {
      const vertices = shared.get(into) as Map<string, number>;
      const indices = polygon.map((v) => {
        const values = [v.x - v.ox, v.y - v.oy, height(v) + 0.003, v.ox, v.oy, v.u, v.v].map(
          Math.fround,
        );
        const key = `${attr.join(',')}/${values.join(',')}`;
        let id = vertices.get(key);
        if (id === undefined) {
          id = into.vertex(
            values[0],
            values[1],
            values[2],
            attr,
            values.slice(3, 5),
            values.slice(5),
          );
          vertices.set(key, id);
        }
        return id;
      });
      for (let j = 1; j + 1 < indices.length; j++)
        into.triangle(indices[0], indices[j], indices[j + 1]);
    }
  }
  return packMarkings([simple], [full]);
}
