/**
 * A source building (CityGML or CityJSON, any CRS) → what the compiler keeps:
 * its roof surfaces in web-mercator with heights in metres above the
 * building's own ground, a footprint to conflate with, and a representative
 * point to tile it by.
 *
 * ## What is kept, and why only roofs
 *
 * Seen from above and around, an LOD2 shell is its roof surfaces plus walls
 * that drop from every roof edge to whatever is below. Walls carry no
 * information the roofs do not (their top edges ARE roof edges, their bottoms
 * are the ground or a lower roof), so the tile stores roofs only and the
 * client raises the walls (`lod2Mesher.ts`). That is the whole size saving of
 * this format: NYC's model is 506k wall polygons to 80k roof polygons in one
 * distribution area (measured, DA12).
 *
 * A roof surface is kept as the polygon it is in the source plus the PLANE it
 * lies in. CityGML roof polygons are planar by the standard's own rule; one
 * that is not (beyond {@link PLANAR_TOLERANCE_M}) is split into triangles,
 * each exactly planar, rather than flattened — so the drawn roof is the
 * measured one, never an average of it.
 *
 * Polygons the source calls roofs but that face sideways (|nz| below
 * {@link MIN_ROOF_NZ}: a wall misfiled as roof) are dropped and counted. The
 * normal's SIGN is not trusted for a thematic roof — winding errors are common
 * in published CityGML — but it is what classifies untyped geometry (an
 * `lod2Solid` with no thematic surfaces): up is roof, down is ground.
 */
import earcut from 'earcut';

import { heightForStoreys, STOREY_MODELS, type StoreyModel } from '../storeys';
import type { RawBuilding, RawPolygon } from './cityGml';
import type { Crs } from './crs';
import type { InspirePart } from './inspireBuildings';

/** A roof polygon further than this from its best-fit plane is triangulated instead. */
export const PLANAR_TOLERANCE_M = 0.25;

/** A "roof" steeper than ~84° is a wall. */
export const MIN_ROOF_NZ = 0.1;

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

export const mercX = (lon: number) => (lon + 180) / 360;
export function mercY(lat: number): number {
  const phi = (Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}
export const latFromMercY = (y: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** Metres per web-mercator unit at a mercator `y`. */
export function metresPerMercator(y: number): number {
  return EARTH_CIRCUMFERENCE_M * Math.cos((latFromMercY(y) * Math.PI) / 180);
}

/**
 * One planar roof patch: rings in mercator (`[x, y, …]`, open, exterior
 * first) and the height above the building's ground at every vertex, metres.
 */
export interface RoofSurface {
  rings: Float64Array[];
  heights: Float64Array[];
  /** Storeys above ground the source records for this volume (the cadastre's), when it does. */
  levels?: number;
}

export interface PreparedBuilding {
  /** The source's own identifier for provenance (`BIN 1026885`, a `gml:id`, …). */
  sourceId: string;
  roofs: RoofSurface[];
  /** Exterior rings of the footprint, mercator: ground surfaces, else the roofs' outlines. */
  footprint: Float64Array[];
  point: [number, number];
  /** `[minX, minY, maxX, maxY]` of the footprint, mercator. */
  bbox: [number, number, number, number];
  /** Footprint area, m². */
  areaM2: number;
  /** Highest roof point above ground, metres. */
  height: number;
  /**
   * Roof area that is SLOPED (more than ~3°), m²: what makes a model LOD2
   * rather than stepped flat blocks (LOD1.x), and what conflation weighs
   * against OSM's own 3D mapping.
   */
  slopedAreaM2: number;
}

export interface PrepareStats {
  buildings: number;
  kept: number;
  noRoof: number;
  roofs: number;
  sloped: number;
  triangulated: number;
  droppedSteep: number;
  untypedClassified: number;
}

export function emptyPrepareStats(): PrepareStats {
  return {
    buildings: 0,
    kept: 0,
    noRoof: 0,
    roofs: 0,
    sloped: 0,
    triangulated: 0,
    droppedSteep: 0,
    untypedClassified: 0,
  };
}

/** Newell's normal of a ring in metres (`[x, y, z, …]`), unnormalised. */
export function newellNormal(ring: ArrayLike<number>): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const n = ring.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x1, y1, z1] = [ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2]];
    const [x2, y2, z2] = [ring[j * 3], ring[j * 3 + 1], ring[j * 3 + 2]];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  return [nx, ny, nz];
}

/** Shoelace area of an open `[x, y, …]` ring, relative to its first vertex (precision). */
export function ringArea2(ring: ArrayLike<number>): number {
  const ox = ring[0];
  const oy = ring[1];
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum +=
      (ring[i * 2] - ox) * (ring[j * 2 + 1] - oy) - (ring[j * 2] - ox) * (ring[i * 2 + 1] - oy);
  }
  return sum / 2;
}

/** Point in an open `[x, y, …]` ring (even–odd). */
export function insideRing2(ring: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Best-fit plane `h = c + a·x + b·y` through points in local metres, and the
 * largest residual. `null` when the points are (nearly) collinear in plan.
 */
export function fitPlane(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  hs: ArrayLike<number>,
): { a: number; b: number; c: number; residual: number } | null {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  let mh = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
    mh += hs[i];
  }
  mx /= n;
  my /= n;
  mh /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxh = 0;
  let syh = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    const dh = hs[i] - mh;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxh += dx * dh;
    syh += dy * dh;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(det > 1e-9 * (sxx + syy) ** 2) || sxx + syy < 1e-6) return null;
  const a = (sxh * syy - syh * sxy) / det;
  const b = (syh * sxx - sxh * sxy) / det;
  const c = mh - a * mx - b * my;
  let residual = 0;
  for (let i = 0; i < n; i++) {
    residual = Math.max(residual, Math.abs(c + a * xs[i] + b * ys[i] - hs[i]));
  }
  return { a, b, c, residual };
}

/** Classify an untyped polygon (`kind: 'none'`) by which way it faces. */
function classify(polygon: RawPolygon, verticalMetres: number): RawPolygon['kind'] {
  const ring = polygon.rings[0];
  const scaled = new Float64Array(ring.length);
  for (let i = 0; i < ring.length; i += 3) {
    scaled[i] = ring[i];
    scaled[i + 1] = ring[i + 1];
    scaled[i + 2] = ring[i + 2] * verticalMetres;
  }
  const [nx, ny, nz] = newellNormal(scaled);
  const length = Math.hypot(nx, ny, nz) || 1;
  if (nz / length >= MIN_ROOF_NZ) return 'roof';
  if (nz / length <= -MIN_ROOF_NZ) return 'ground';
  return 'wall';
}

export interface PrepareOptions {
  crs: Crs;
  /** The attribute(s) that identify a building in the source, in preference order. */
  idAttributes: readonly string[];
  /** Horizontal units → metres, for planimetric work before projection (`Crs` gives vertical). */
  horizontalMetres?: number;
}

/**
 * One raw building → a prepared one, or `null` when it has no usable roof.
 * Counts what it drops in `stats`.
 */
export function prepareBuilding(
  raw: RawBuilding,
  options: PrepareOptions,
  stats: PrepareStats,
): PreparedBuilding | null {
  stats.buildings++;
  const v = options.crs.verticalMetres;

  // Prefer the highest LOD below 3 that has roofs (CityJSON's 2.2 over 1.3);
  // LOD3/4 detail is not drawn.
  const usable = raw.polygons.filter((p) => Math.floor(p.lod) <= 2);
  const lod = Math.max(0, ...usable.filter((p) => p.kind === 'roof').map((p) => p.lod));
  let polygons = usable.filter((p) => p.lod === lod || p.lod === 0);
  if (!polygons.some((p) => p.kind === 'roof')) {
    // No thematic roofs: classify the geometry of the best LOD by its normals.
    const best = Math.max(0, ...usable.map((p) => p.lod));
    polygons = usable
      .filter((p) => p.lod === best)
      .map((p) => {
        if (p.kind !== 'none') return p;
        stats.untypedClassified++;
        return { ...p, kind: classify(p, v) };
      });
  }

  // Ground: the lowest ground-surface vertex, else the lowest vertex at all.
  let ground = Infinity;
  let lowest = Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon.rings) {
      for (let i = 2; i < ring.length; i += 3) {
        const z = ring[i] * v;
        if (z < lowest) lowest = z;
        if (polygon.kind === 'ground' && z < ground) ground = z;
      }
    }
  }
  if (!Number.isFinite(ground)) ground = lowest;
  if (!Number.isFinite(ground)) {
    stats.noRoof++;
    return null;
  }

  const project = (ring: Float64Array): { merc: Float64Array; h: Float64Array } => {
    const n = ring.length / 3;
    const merc = new Float64Array(n * 2);
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const [lon, lat] = options.crs.toLonLat(ring[i * 3], ring[i * 3 + 1]);
      merc[i * 2] = mercX(lon);
      merc[i * 2 + 1] = mercY(lat);
      h[i] = ring[i * 3 + 2] * v - ground;
    }
    return { merc, h };
  };

  const roofs: RoofSurface[] = [];
  const outlines: Float64Array[] = [];
  const grounds: Float64Array[] = [];
  let height = 0;
  let slopedArea = 0;
  let originX = Number.NaN;
  let originY = Number.NaN;
  let scale = 1;

  for (const polygon of polygons) {
    if (polygon.kind === 'ground') {
      grounds.push(project(polygon.rings[0]).merc);
      continue;
    }
    if (polygon.kind !== 'roof') continue;
    const projected = polygon.rings.map(project);
    if (Number.isNaN(originX)) {
      originX = projected[0].merc[0];
      originY = projected[0].merc[1];
      scale = metresPerMercator(originY);
    }
    // Local metres, y north, for the normal and the plane test.
    const local = projected.map(({ merc, h }) => {
      const n = h.length;
      const xyz = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        xyz[i * 3] = (merc[i * 2] - originX) * scale;
        xyz[i * 3 + 1] = -(merc[i * 2 + 1] - originY) * scale;
        xyz[i * 3 + 2] = h[i];
      }
      return xyz;
    });
    const [nx, ny, nz] = newellNormal(local[0]);
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0)) continue;
    // The sign is the ring's winding, which sources get wrong often enough
    // that a roof is judged by how steep it is, not which way it is wound.
    if (Math.abs(nz / length) < MIN_ROOF_NZ) {
      stats.droppedSteep++;
      continue;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    const hs: number[] = [];
    for (const ring of local) {
      for (let i = 0; i < ring.length; i += 3) {
        xs.push(ring[i]);
        ys.push(ring[i + 1]);
        hs.push(ring[i + 2]);
        if (ring[i + 2] > height) height = ring[i + 2];
      }
    }
    const plane = fitPlane(xs, ys, hs);
    if (!plane) continue;
    stats.roofs++;
    if (Math.hypot(plane.a, plane.b) > 0.05) {
      stats.sloped++;
      slopedArea += Math.abs(newellNormal(local[0])[2]) / 2;
    }
    outlines.push(projected[0].merc);
    if (plane.residual <= PLANAR_TOLERANCE_M) {
      roofs.push({ rings: projected.map((p) => p.merc), heights: projected.map((p) => p.h) });
      continue;
    }
    // Not planar: one exactly planar triangle per earcut triangle.
    stats.triangulated++;
    const flat: number[] = [];
    const flatH: number[] = [];
    const holes: number[] = [];
    projected.forEach((p, r) => {
      if (r > 0) holes.push(flat.length / 2);
      for (let i = 0; i < p.h.length; i++) {
        flat.push(p.merc[i * 2], p.merc[i * 2 + 1]);
        flatH.push(p.h[i]);
      }
    });
    const localFlat = flat.map((value, i) =>
      i % 2 === 0 ? (value - originX) * scale : -(value - originY) * scale,
    );
    const triangles = earcut(localFlat, holes.length > 0 ? holes : null, 2);
    for (let t = 0; t < triangles.length; t += 3) {
      const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
      const ring = new Float64Array(6);
      const h = new Float64Array(3);
      ids.forEach((id, k) => {
        ring[k * 2] = flat[id * 2];
        ring[k * 2 + 1] = flat[id * 2 + 1];
        h[k] = flatH[id];
      });
      roofs.push({ rings: [ring], heights: [h] });
    }
  }

  if (roofs.length === 0 || height <= 0) {
    stats.noRoof++;
    return null;
  }
  const footprint = grounds.length > 0 ? grounds : outlines;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let areaMerc = 0;
  let largest = footprint[0];
  let largestArea = 0;
  for (const ring of footprint) {
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
    const area = Math.abs(ringArea2(ring));
    areaMerc += area;
    if (area > largestArea) {
      largestArea = area;
      largest = ring;
    }
  }
  const unit = metresPerMercator((minY + maxY) / 2);
  const sourceId =
    options.idAttributes.map((key) => raw.attributes[key]).find((value) => value) ?? raw.id;
  stats.kept++;
  return {
    sourceId,
    roofs,
    footprint,
    point: representativePoint2(largest),
    bbox: [minX, minY, maxX, maxY],
    areaM2: areaMerc * unit * unit,
    height,
    slopedAreaM2: slopedArea,
  };
}

/** The ring's area centroid when it is inside the ring, else its first edge's midpoint. */
export function representativePoint2(ring: Float64Array): [number, number] {
  const ox = ring[0];
  const oy = ring[1];
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = ring[i * 2] - ox;
    const y1 = ring[i * 2 + 1] - oy;
    const x2 = ring[j * 2] - ox;
    const y2 = ring[j * 2 + 1] - oy;
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (a !== 0) {
    const point: [number, number] = [ox + cx / (3 * a), oy + cy / (3 * a)];
    if (insideRing2(ring, point[0], point[1])) return point;
  }
  return [(ring[0] + ring[2]) / 2, (ring[1] + ring[3]) / 2];
}

/**
 * One cadastral building (its INSPIRE `BuildingPart`s) → a prepared building
 * of FLAT roofs, one per part, each at the height its recorded storeys stand
 * in the region's storey model (`citygen/storeys.ts`; Spain: 4.0 m ground
 * floor, 3.05 m upper floors, 0.9 m parapet).
 *
 * Parts with no storeys above ground (a basement's roof, a patio) carry
 * nothing to draw and are left out; a building with none at all is `null`.
 */
export function prepareInspireBuilding(
  reference: string,
  parts: readonly InspirePart[],
  crs: Crs,
  stats: PrepareStats,
  storeys: StoreyModel = STOREY_MODELS.es,
): PreparedBuilding | null {
  stats.buildings++;
  const roofs: RoofSurface[] = [];
  const footprint: Float64Array[] = [];
  let height = 0;
  for (const part of parts) {
    const floors = part.floorsAbove;
    if (floors === null || floors < 1) continue;
    const h = heightForStoreys(floors, storeys);
    for (const polygon of part.polygons) {
      const rings = polygon.map((ring) => {
        const n = ring.length / 3;
        const merc = new Float64Array(n * 2);
        for (let i = 0; i < n; i++) {
          const [lon, lat] = crs.toLonLat(ring[i * 3], ring[i * 3 + 1]);
          merc[i * 2] = mercX(lon);
          merc[i * 2 + 1] = mercY(lat);
        }
        return merc;
      });
      roofs.push({
        rings,
        heights: rings.map((ring) => new Float64Array(ring.length / 2).fill(h)),
        levels: floors,
      });
      footprint.push(rings[0]);
      stats.roofs++;
    }
    height = Math.max(height, h);
  }
  if (roofs.length === 0) {
    stats.noRoof++;
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let areaMerc = 0;
  let largest = footprint[0];
  let largestArea = 0;
  for (const ring of footprint) {
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
    const area = Math.abs(ringArea2(ring));
    areaMerc += area;
    if (area > largestArea) {
      largestArea = area;
      largest = ring;
    }
  }
  const unit = metresPerMercator((minY + maxY) / 2);
  stats.kept++;
  return {
    sourceId: reference,
    roofs,
    footprint,
    point: representativePoint2(largest),
    bbox: [minX, minY, maxX, maxY],
    areaM2: areaMerc * unit * unit,
    height,
    slopedAreaM2: 0,
  };
}
