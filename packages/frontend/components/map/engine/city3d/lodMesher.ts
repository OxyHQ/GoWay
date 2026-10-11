/**
 * The far-field levels of detail: the same buildings as `mesher.ts`, cheaper.
 *
 * Level 0 is `mesher.ts` — bevelled roofs and corner occlusion columns, repacked
 * by `packing.ts`. Levels 1 and 2 are built here, straight into the compact
 * format, as plain prisms:
 *
 * | level | footprint                                  | bevel | corner AO | drawn (see `lod.ts`)        |
 * | ----: | ------------------------------------------ | :---: | :-------: | --------------------------- |
 * |     0 | as the tile has it                         |  yes  |    yes    | nearest tiles               |
 * |     1 | Douglas–Peucker 1 m; slivers < 4 m² gone   |  no   |    no     | the rest of the visible city |
 * |     2 | Douglas–Peucker 4 m; courtyards < 150 m² filled; low buildings < 80 m² dropped | no | no | toward the horizon |
 *
 * Why those numbers: an error of `e` metres at distance `d` covers
 * `e · f / d` pixels, `f` the focal length in pixels. MapLibre puts the camera
 * `f` pixels from the centre, so in units of that distance (`r`, `lod.ts`)
 * the error is `e / (r · metresPerPixel)`. `lod.ts` charges level 1 with
 * 1.5 m (the 0.7 m bevel plus a 1 m simplification, rounded up for the
 * bevel's highlight) and level 2 with 6 m, and draws each only where that is
 * under a pixel: at zoom 16 in Barcelona (0.9 m/px) level 1 from `r` 1.7 and
 * level 2 from `r` 6.7 — the top edge of a 60° view is `r` 2.5.
 *
 * ## Honesty
 *
 * This is the "far-field simplification" `docs/MAP_3D_CITY.md` allows: derived,
 * never invented. Heights are `buildingSpan`'s, exactly as at level 0. Level 2
 * fills courtyards and drops low small buildings that would be under a pixel
 * where it is drawn; it never adds a volume the footprints do not have beyond
 * a filled courtyard, and the flat footprint layer underneath still shows
 * every building's outline.
 */
import earcut from 'earcut';

import {
  type BuildingFeature,
  buildingSpan,
  heightUnrecorded,
  MESH,
  type MeshTileOptions,
  polygonsOf,
  type Ring,
  signedArea,
} from './mesher';
import { type PackedMesh, PackedBuilder, unitMetres } from './packing';
import { simplifyRing } from './simplify';

/** A building level of detail: 0 full, 1 simple, 2 coarse. */
export type BuildingLod = 0 | 1 | 2;

/** What a far level keeps. */
export interface LodDetail {
  /** Douglas–Peucker tolerance, metres. */
  simplifyM: number;
  /** Courtyards (holes) smaller than this are filled, m². */
  minHoleM2: number;
  /** Polygons smaller than this are dropped, m² … */
  dropAreaM2: number;
  /** … unless at least this tall (a tower is visible however slim). */
  keepAboveM: number;
}

export const LOD_DETAIL: Readonly<Record<1 | 2, LodDetail>> = {
  1: { simplifyM: 1, minHoleM2: 4, dropAreaM2: 0, keepAboveM: 0 },
  2: { simplifyM: 4, minHoleM2: 150, dropAreaM2: 80, keepAboveM: 15 },
};

/** Ring + area after simplification, or `null` when it collapsed. */
function simplified(ring: Ring, toleranceM: number): { ring: Ring; area: number } | null {
  const out = simplifyRing(ring, toleranceM);
  if (out.points.length < 3) return null;
  return { ring: out, area: signedArea(out.points) };
}

/**
 * The polygons of one feature at a far level: simplified, courtyards and tiny
 * buildings filtered. Exported for the tests.
 */
export function lodPolygons(
  feature: BuildingFeature,
  options: MeshTileOptions,
  detail: LodDetail,
  heightM: number,
): Ring[][] {
  const out: Ring[][] = [];
  for (const polygon of polygonsOf(feature.rings, options)) {
    const exterior = simplified(polygon[0], detail.simplifyM);
    // Simplification must not turn an exterior inside out or below the floor.
    if (!exterior || exterior.area < MESH.minRingAreaM2) continue;
    if (exterior.area < detail.dropAreaM2 && heightM < detail.keepAboveM) continue;
    const rings = [exterior.ring];
    for (const hole of polygon.slice(1)) {
      const kept = simplified(hole, detail.simplifyM);
      // Holes are clockwise (negative). One that flipped or shrank is filled.
      if (kept && -kept.area >= detail.minHoleM2) rings.push(kept.ring);
    }
    out.push(rings);
  }
  return out;
}

/** Walls and a flat roof for one polygon, as a plain prism. */
function meshPrism(
  builder: PackedBuilder,
  polygon: readonly Ring[],
  base: number,
  top: number,
  tone: number,
): void {
  for (const { points, cut } of polygon) {
    const n = points.length;
    for (let i = 0; i < n; i++) {
      if (cut[i]) continue;
      const a = points[i];
      const b = points[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      // Outward = right of the direction of travel (solid on the left).
      const nx = dy / length;
      const ny = -dx / length;
      const b0 = builder.vertex(a[0], a[1], base, nx, ny, 0, 1, tone);
      const b1 = builder.vertex(b[0], b[1], base, nx, ny, 0, 1, tone);
      const t1 = builder.vertex(b[0], b[1], top, nx, ny, 0, 1, tone);
      const t0 = builder.vertex(a[0], a[1], top, nx, ny, 0, 1, tone);
      builder.quad(b0, b1, t1, t0);
    }
  }

  const flat: number[] = [];
  const holes: number[] = [];
  polygon.forEach((ring, r) => {
    if (r > 0) holes.push(flat.length / 2);
    for (const [x, y] of ring.points) flat.push(x, y);
  });
  const triangles = earcut(flat, holes.length > 0 ? holes : null, 2);
  if (triangles.length === 0) return;
  const count = flat.length / 2;
  // earcut does not promise a winding; every roof triangle must face up.
  const upward = (a: number, b: number, c: number) =>
    (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) -
      (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]) >=
    0;

  const first = builder.vertices;
  for (let i = 0; i < count; i++) {
    builder.vertex(flat[i * 2], flat[i * 2 + 1], top, 0, 0, 1, 1, tone);
  }
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    if (upward(a, b, c)) builder.triangle(first + a, first + b, first + c);
    else builder.triangle(first + a, first + c, first + b);
  }
}

/** A footprint's box in local metres: `minX, minY, maxX, maxY`. */
function boxOf(points: readonly (readonly [number, number])[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Mesh every building of one tile at far level `lod` (1 or 2), in the
 * compact format. `null` when the tile has nothing to draw at that level.
 */
export function meshBuildingsLod(
  features: readonly BuildingFeature[],
  options: MeshTileOptions,
  lod: 1 | 2,
): PackedMesh | null {
  const detail = LOD_DETAIL[lod];
  const builder = new PackedBuilder(unitMetres(options.tileSizeMetres));
  let polygons = 0;
  for (const feature of features) {
    const span = buildingSpan(feature.properties);
    if (!span) continue;
    const rawHeight = finite(feature.properties.render_height) ?? 0;
    const tone = Math.round(Math.max(0, Math.min(MESH.toneMaxM, rawHeight)));
    for (const polygon of lodPolygons(feature, options, detail, span.top)) {
      builder.beginPolygon(boxOf(polygon[0].points), heightUnrecorded(feature.properties));
      meshPrism(builder, polygon, span.base, span.top, tone);
      polygons++;
    }
  }
  return builder.finish(polygons);
}
