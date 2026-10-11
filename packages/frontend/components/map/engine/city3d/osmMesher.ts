/**
 * GoWay city-tile buildings → one tile's triangle mesh: real per-building
 * volumes, roof shapes where `roof:shape` is tagged, tagged colours and
 * materials, and the storey rhythm where `building:levels` is recorded.
 *
 * The OpenMapTiles mesher (`mesher.ts`) stays as it is; this is its sibling
 * for the second source mode, and reuses its pure pieces (rings, bevel,
 * corner occlusion) rather than forking them. What is different, and why:
 *
 *  - **No clipping, no cut edges.** City tiles carry each building whole, in
 *    the one tile that owns it (`lib/map/cityTiles.ts`), so there is no tile
 *    boundary to suppress walls along, and vertices may lie outside the tile
 *    square. The model matrix does not care.
 *  - **Roofs.** A flat roof is the prototype's bevelled one. A shaped roof is
 *    built by `roofs.ts`: planar shapes as the lowest of their planes, with
 *    the walls rising to meet it (gable ends included), and domes, onions and
 *    cones as surfaces of revolution. A shape that cannot be built on a
 *    footprint (a dome over a courtyard, a frame-less sliver) falls back to a
 *    pyramid or to flat — never to an invented different building.
 *  - **Two more vertex attributes.** `colors` (RGB + a blend weight, see
 *    `facades.ts`) and `facade` (the storey rhythm, see below), which the OSM
 *    shader (`osmShaders.ts`) reads.
 *
 * ## The `facade` attribute
 *
 * Four `uint16` per vertex, zero everywhere the building records no floors:
 *
 *  - `x`: position along the facade in BAYS × 256 (each facade is divided
 *    into whole bays, so no window is cut by a corner);
 *  - `y`: the lowest storey's floor, decimetres above the ground;
 *  - `z`: the storey height, centimetres;
 *  - `w`: how many storeys — the recorded count, nothing else.
 *
 * Tested in `__tests__/city3dOsmMesher.test.ts`.
 */
import earcut from 'earcut';

import {
  bayCount,
  facadeFor,
  type FacadeRhythm,
  ROOF_MATERIAL_COLOURS,
  surfaceColour,
  WALL_MATERIAL_COLOURS,
} from './facades';
import {
  bevelWidth,
  insetIsValid,
  insetRing,
  MESH,
  type MeshTileOptions,
  type Point2,
  type Ring,
  signedArea,
  type TileMesh,
  turnAngle,
  wallColumns,
} from './mesher';
import { concavity, cornerOcclusion } from './occlusion';
import type { OsmBuilding } from './osmTiles';
import {
  edgeBreaks,
  isStarShaped,
  PLANAR_ROOF_SHAPES,
  type Plane,
  planeAt,
  revolutionProfile,
  ringCentroid,
  roofFrame,
  roofHeightAt,
  roofPatch,
  roofPlanes,
} from './roofs';

/** A tile mesh with the OSM attributes. */
export interface OsmTileMesh extends TileMesh {
  /** Per vertex `[r, g, b, weight]`; weight 0 means "use the height ramp". */
  colors: Uint8Array;
  /** Per vertex `[bays×256, base dm, storey cm, count]`; all 0 where floors are unrecorded. */
  facade: Uint16Array;
}

type Rgba = readonly [number, number, number, number];
type Facade4 = readonly [number, number, number, number];
const NO_FACADE: Facade4 = [0, 0, 0, 0];
const UP = [0, 0, 1] as const;

class Builder {
  positions = new Float32Array(3 * 8192);
  normals = new Int8Array(3 * 8192);
  shade = new Uint8Array(2 * 8192);
  colors = new Uint8Array(4 * 8192);
  facade = new Uint16Array(4 * 8192);
  indices = new Uint32Array(6 * 8192);
  vertexCount = 0;
  indexCount = 0;
  private readonly unitStarts: number[] = [];
  private readonly unitBoxes: number[] = [];
  readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  private grow(): void {
    const twice = <T extends Float32Array | Int8Array | Uint8Array | Uint16Array>(a: T): T => {
      const next = new (a.constructor as new (n: number) => T)(a.length * 2);
      next.set(a);
      return next;
    };
    this.positions = twice(this.positions);
    this.normals = twice(this.normals);
    this.shade = twice(this.shade);
    this.colors = twice(this.colors);
    this.facade = twice(this.facade);
  }

  vertex(
    x: number,
    y: number,
    z: number,
    normal: readonly number[],
    ao: number,
    tone: number,
    color: Rgba,
    facade: Facade4,
  ): number {
    if (this.vertexCount * 3 + 3 > this.positions.length) this.grow();
    const v = this.vertexCount++;
    const p = v * 3;
    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;
    this.normals[p] = Math.round(normal[0] * 127);
    this.normals[p + 1] = Math.round(normal[1] * 127);
    this.normals[p + 2] = Math.round(normal[2] * 127);
    this.shade[v * 2] = Math.round(Math.max(0, Math.min(1, ao)) * 255);
    this.shade[v * 2 + 1] = tone;
    const c = v * 4;
    this.colors[c] = color[0];
    this.colors[c + 1] = color[1];
    this.colors[c + 2] = color[2];
    this.colors[c + 3] = color[3];
    this.facade[c] = facade[0];
    this.facade[c + 1] = facade[1];
    this.facade[c + 2] = facade[2];
    this.facade[c + 3] = facade[3];
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
    return v;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.indices.length) {
      const next = new Uint32Array(this.indices.length * 2);
      next.set(this.indices);
      this.indices = next;
    }
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  quad(b0: number, b1: number, t1: number, t0: number): void {
    this.triangle(b0, b1, t1);
    this.triangle(b0, t1, t0);
  }

  /**
   * Record one building's vertices, from `start` to here, as one unit placed on
   * terrain (`terrainGround.ts`), with its footprint's box in local metres.
   */
  building(start: number, box: readonly [number, number, number, number]): void {
    if (this.vertexCount <= start) return;
    this.unitStarts.push(start);
    this.unitBoxes.push(...box);
  }

  finish(polygons: number): OsmTileMesh | null {
    if (this.indexCount === 0) return null;
    return {
      positions: this.positions.slice(0, this.vertexCount * 3),
      normals: this.normals.slice(0, this.vertexCount * 3),
      shade: this.shade.slice(0, this.vertexCount * 2),
      colors: this.colors.slice(0, this.vertexCount * 4),
      facade: this.facade.slice(0, this.vertexCount * 4),
      indices: this.indices.slice(0, this.indexCount),
      bounds: { min: [...this.min], max: [...this.max] },
      polygons,
      polygonStarts: Uint32Array.from(this.unitStarts),
      polygonBoxes: Float32Array.from(this.unitBoxes),
    };
  }
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * A building's rings → polygons in local metres (ENU, y north), exteriors
 * counter-clockwise. Same orientation rule as `polygonsOf` in `mesher.ts`
 * (reverse on the way in), without its clipping.
 */
export function osmPolygons(rings: readonly (readonly Point2[])[], scale: number): Point2[][][] {
  const polygons: Point2[][][] = [];
  let current: Point2[][] | null = null;
  for (const raw of rings) {
    const points: Point2[] = [];
    for (let i = raw.length - 1; i >= 0; i--) {
      const point: Point2 = [raw[i][0] * scale, -raw[i][1] * scale];
      const last = points[points.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1]) points.push(point);
    }
    while (
      points.length > 1 &&
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1]
    ) {
      points.pop();
    }
    if (points.length < 3) continue;
    const area = signedArea(points);
    if (Math.abs(area) < MESH.minRingAreaM2) continue;
    if (area > 0) {
      current = [points];
      polygons.push(current);
    } else if (current) {
      current.push(points);
    }
  }
  return polygons;
}

/** What a building's walls look like, shared by every wall it has. */
interface WallStyle {
  base: number;
  tone: number;
  color: Rgba;
  rhythm: FacadeRhythm | null;
  /** Whether the edge `a → b` (local metres) is a party wall: no openings there. */
  party: (a: Point2, b: Point2) => boolean;
}

/**
 * Party walls: an edge another building in the tile shares, over heights the
 * two have in common. Openings are drawn only on walls that face the street,
 * a courtyard or the sky — a wall that another building stands against is
 * blind, and where it rises above its neighbour (Barcelona's medianeras) it is
 * blind in reality too, so drawing windows on it would be inventing them.
 *
 * Neighbours share OSM nodes, so a shared edge has identical integer tile
 * coordinates on both sides; that is the whole test. A neighbour in the NEXT
 * tile is not seen (its edge is in another tile's mesh), so such a wall keeps
 * its rhythm — the known gap, at tile borders only.
 */
export class PartyWalls {
  /** By an edge's lower endpoint: `[other endpoint, owner, base, top]` per edge. */
  private readonly edges = new Map<number, number[]>();

  /** A tile-unit point as one exact integer (coordinates stay well inside ±2^20). */
  private static point(p: Point2): number {
    return (p[0] + 0x100000) * 0x200000 + (p[1] + 0x100000);
  }

  /** Record every edge of a building, in tile units, with its vertical range. */
  add(building: OsmBuilding, owner: number): void {
    for (const ring of building.rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = PartyWalls.point(ring[i]);
        const q = PartyWalls.point(ring[(i + 1) % n]);
        if (p === q) continue;
        const low = Math.min(p, q);
        let list = this.edges.get(low);
        if (!list) {
          list = [];
          this.edges.set(low, list);
        }
        list.push(Math.max(p, q), owner, building.base, building.top);
      }
    }
  }

  /** Whether another building shares the tile-unit edge `a → b` over `[base, top]`. */
  shared(a: Point2, b: Point2, owner: number, base: number, top: number): boolean {
    const p = PartyWalls.point(a);
    const q = PartyWalls.point(b);
    const list = this.edges.get(Math.min(p, q));
    if (!list) return false;
    const high = Math.max(p, q);
    for (let i = 0; i < list.length; i += 4) {
      if (list[i] === high && list[i + 1] !== owner && list[i + 2] < top && list[i + 3] > base) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Walls for every ring of a polygon, from `style.base` up to `topAt(x, y)`
 * along each edge, with extra columns at `breaksOf(a, b)` (where the top
 * bends) and at the corner-occlusion reach.
 */
function walls(
  builder: Builder,
  polygon: readonly Point2[][],
  style: WallStyle,
  topAt: (x: number, y: number) => number,
  breaksOf: (a: Point2, b: Point2) => number[],
): void {
  const { rhythm } = style;
  for (const points of polygon) {
    const n = points.length;
    const concave = points.map((here, i) =>
      concavity(turnAngle(points[(i + n - 1) % n], here, points[(i + 1) % n])),
    );
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      const ux = dx / length;
      const uy = dy / length;
      const outward = [uy, -ux, 0];
      const cA = concave[i];
      const cB = concave[(i + 1) % n];
      const columns = new Set(wallColumns(length, cA > 0, cB > 0));
      for (const t of breaksOf(a, b)) columns.add(t * length);
      const sorted = [...columns].sort((p, q) => p - q);
      const bays = rhythm && !style.party(a, b) ? bayCount(length) : 0;
      let previous: [number, number] | null = null;
      for (const s of sorted) {
        const ao = Math.min(cornerOcclusion(cA, s), cornerOcclusion(cB, length - s));
        const x = a[0] + ux * s;
        const y = a[1] + uy * s;
        const facade: Facade4 =
          rhythm && bays > 0
            ? [
                Math.min(65535, Math.round((s / length) * bays * 256)),
                Math.min(65535, Math.round(rhythm.base * 10)),
                Math.min(65535, Math.round(rhythm.storey * 100)),
                rhythm.count,
              ]
            : NO_FACADE;
        const bottom = builder.vertex(
          x,
          y,
          style.base,
          outward,
          ao,
          style.tone,
          style.color,
          facade,
        );
        const top = builder.vertex(x, y, topAt(x, y), outward, ao, style.tone, style.color, facade);
        if (previous) builder.quad(previous[0], bottom, top, previous[1]);
        previous = [bottom, top];
      }
    }
  }
}

/** Triangulate rings (exterior first, then holes) at heights `zAt`, facing `normal`. */
function cap(
  builder: Builder,
  rings: readonly (readonly Point2[])[],
  zAt: (x: number, y: number) => number,
  normal: readonly number[],
  tone: number,
  color: Rgba,
): void {
  const flat: number[] = [];
  const holes: number[] = [];
  rings.forEach((ring, r) => {
    if (r > 0) holes.push(flat.length / 2);
    for (const [x, y] of ring) flat.push(x, y);
  });
  const triangles = earcut(flat, holes.length > 0 ? holes : null, 2);
  if (triangles.length === 0) return;
  const first = builder.vertexCount;
  for (let i = 0; i < flat.length; i += 2) {
    builder.vertex(
      flat[i],
      flat[i + 1],
      zAt(flat[i], flat[i + 1]),
      normal,
      1,
      tone,
      color,
      NO_FACADE,
    );
  }
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const ccw =
      (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) -
        (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]) >=
      0;
    if (ccw) builder.triangle(first + a, first + b, first + c);
    else builder.triangle(first + a, first + c, first + b);
  }
}

/** The prototype's bevelled flat roof, on a whole (unclipped) polygon. */
function flatBuilding(
  builder: Builder,
  polygon: Point2[][],
  top: number,
  wall: WallStyle,
  roofColor: Rgba,
): void {
  const rings: Ring[] = polygon.map((points) => ({ points, cut: points.map(() => false) }));
  const full = bevelWidth(rings, top - wall.base);
  let bevel = 0;
  let insets: Point2[][] = polygon.map((points) => points.slice());
  for (const candidate of [full, full / 2]) {
    if (candidate <= 0) break;
    const tried = rings.map((ring) => insetRing(ring, candidate));
    if (rings.every((ring, i) => insetIsValid(ring.points, tried[i]))) {
      bevel = candidate;
      insets = tried;
      break;
    }
  }
  const wallTop = top - bevel;
  walls(
    builder,
    polygon,
    wall,
    () => wallTop,
    () => [],
  );
  if (bevel > 0) {
    polygon.forEach((points, r) => {
      const inset = insets[r];
      const n = points.length;
      for (let i = 0; i < n; i++) {
        const a = points[i];
        const b = points[(i + 1) % n];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < 1e-6) continue;
        const ux = (b[0] - a[0]) / length;
        const uy = (b[1] - a[1]) / length;
        const qa = inset[i];
        const qb = inset[(i + 1) % n];
        const mx = (qa[0] + qb[0]) / 2 - (a[0] + b[0]) / 2;
        const my = (qa[1] + qb[1]) / 2 - (a[1] + b[1]) / 2;
        const normal = normalize3(uy * bevel, -ux * bevel, ux * my - uy * mx);
        // The chamfer is the roof's edge: it takes the roof's colour.
        const p0 = builder.vertex(a[0], a[1], wallTop, normal, 1, wall.tone, roofColor, NO_FACADE);
        const p1 = builder.vertex(b[0], b[1], wallTop, normal, 1, wall.tone, roofColor, NO_FACADE);
        const q1 = builder.vertex(qb[0], qb[1], top, normal, 1, wall.tone, roofColor, NO_FACADE);
        const q0 = builder.vertex(qa[0], qa[1], top, normal, 1, wall.tone, roofColor, NO_FACADE);
        builder.quad(p0, p1, q1, q0);
      }
    });
  }
  cap(builder, insets, () => top, UP, wall.tone, roofColor);
}

/** A planar roof (`roofs.ts`) over walls that rise to meet it. */
function planarBuilding(
  builder: Builder,
  polygon: Point2[][],
  eaves: number,
  planes: readonly Plane[],
  wall: WallStyle,
  roofColor: Rgba,
): void {
  walls(
    builder,
    polygon,
    wall,
    (x, y) => eaves + roofHeightAt(planes, x, y),
    (a, b) => edgeBreaks(a, b, planes),
  );
  for (let i = 0; i < planes.length; i++) {
    const patch = roofPatch(polygon, planes, i);
    if (patch.length === 0) continue;
    const plane = planes[i];
    const normal = normalize3(-plane.a, -plane.b, 1);
    cap(
      builder,
      patch,
      (x, y) => eaves + Math.max(0, planeAt(plane, x, y)),
      normal,
      wall.tone,
      roofColor,
    );
  }
}

/** A dome, onion or cone: rings of the footprint shrunk toward its centroid. */
function revolutionRoof(
  builder: Builder,
  exterior: readonly Point2[],
  centre: Point2,
  eaves: number,
  height: number,
  shape: 'dome' | 'onion' | 'cone',
  tone: number,
  color: Rgba,
): void {
  const profile = revolutionProfile(shape);
  const n = exterior.length;
  // A typical radius, to turn the profile's radius fraction into metres for normals.
  let radius = 0;
  for (const [x, y] of exterior) radius += Math.hypot(x - centre[0], y - centre[1]);
  radius /= n;
  const rows: number[][] = [];
  for (let k = 0; k < profile.length; k++) {
    const [h, r] = profile[k];
    // Profile slope by central difference: the normal is (dz, −dρ) in the meridian plane.
    const [h0, r0] = profile[Math.max(0, k - 1)];
    const [h1, r1] = profile[Math.min(profile.length - 1, k + 1)];
    const dz = (h1 - h0) * height;
    const dr = (r1 - r0) * radius;
    const row: number[] = [];
    for (const [x, y] of exterior) {
      const ox = x - centre[0];
      const oy = y - centre[1];
      const d = Math.hypot(ox, oy) || 1;
      const normal = normalize3((ox / d) * dz, (oy / d) * dz, -dr);
      row.push(
        builder.vertex(
          centre[0] + ox * r,
          centre[1] + oy * r,
          eaves + h * height,
          normal,
          1,
          tone,
          color,
          NO_FACADE,
        ),
      );
    }
    rows.push(row);
  }
  for (let k = 0; k + 1 < rows.length; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      builder.quad(rows[k][i], rows[k][j], rows[k + 1][j], rows[k + 1][i]);
    }
  }
}

/** Mesh one building into `builder`; returns how many polygons drew. */
function meshOsmBuilding(
  builder: Builder,
  building: OsmBuilding,
  scale: number,
  owner: number,
  partyWalls: PartyWalls,
): number {
  const base = building.base;
  const top = Math.max(building.top, base + 0.5, base === 0 ? MESH.minHeightM : 0);
  const tone = Math.round(Math.max(0, Math.min(MESH.toneMaxM, building.top)));
  const wallColor = surfaceColour(
    building.colour,
    building.material ? WALL_MATERIAL_COLOURS[building.material] : undefined,
  );
  const roofColor = surfaceColour(
    building.roofColour,
    building.roofMaterial ? ROOF_MATERIAL_COLOURS[building.roofMaterial] : undefined,
  );
  const roof = building.roof;
  const roofHeight = roof ? Math.min(roof.height, top - base) : 0;
  const eaves = top - roofHeight;
  const wall: WallStyle = {
    base,
    tone,
    color: wallColor,
    rhythm: facadeFor(building.levels, building.minLevel, base, eaves),
    // Local metres back to the tile units the edges were recorded in.
    party: (a, b) =>
      partyWalls.shared(
        [Math.round(a[0] / scale), Math.round(-a[1] / scale)],
        [Math.round(b[0] / scale), Math.round(-b[1] / scale)],
        owner,
        base,
        top,
      ),
  };

  let drawn = 0;
  for (const polygon of osmPolygons(building.rings, scale)) {
    drawn++;
    if (!roof || roofHeight <= 0) {
      flatBuilding(builder, polygon, top, wall, roofColor);
      continue;
    }
    let shape = roof.shape;
    if (shape === 'dome' || shape === 'onion' || shape === 'cone') {
      const centre = ringCentroid(polygon[0]);
      if (polygon.length === 1 && isStarShaped(polygon[0], centre)) {
        walls(
          builder,
          polygon,
          wall,
          () => eaves,
          () => [],
        );
        revolutionRoof(builder, polygon[0], centre, eaves, roofHeight, shape, tone, roofColor);
        continue;
      }
      // Not buildable as a surface of revolution: the nearest planar roof.
      shape = 'pyramidal';
    }
    const frame = PLANAR_ROOF_SHAPES.has(shape)
      ? roofFrame(polygon[0], { direction: roof.direction, across: roof.across })
      : null;
    if (!frame) {
      flatBuilding(builder, polygon, top, wall, roofColor);
      continue;
    }
    planarBuilding(builder, polygon, eaves, roofPlanes(shape, frame, roofHeight), wall, roofColor);
  }
  return drawn;
}

/** A building's box in local metres (ENU, y north): `minX, minY, maxX, maxY`. */
function footprintBox(
  rings: OsmBuilding['rings'],
  scale: number,
): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      const east = x * scale;
      const north = -y * scale;
      if (east < minX) minX = east;
      if (north < minY) minY = north;
      if (east > maxX) maxX = east;
      if (north > maxY) maxY = north;
    }
  }
  return [minX, minY, maxX, maxY];
}

/** Mesh every building of one city tile. `null` when nothing draws. */
export function meshOsmBuildings(
  buildings: readonly OsmBuilding[],
  options: MeshTileOptions,
): OsmTileMesh | null {
  const builder = new Builder();
  const scale = options.tileSizeMetres / options.extent;
  let polygons = 0;
  const partyWalls = new PartyWalls();
  buildings.forEach((building, i) => {
    partyWalls.add(building, i);
  });
  buildings.forEach((building, i) => {
    const start = builder.vertexCount;
    polygons += meshOsmBuilding(builder, building, scale, i, partyWalls);
    // A whole building (all its polygons) stands on ONE ground, so a
    // multipolygon's pieces stay level with each other on a slope.
    builder.building(start, footprintBox(building.rings, scale));
  });
  return builder.finish(polygons);
}
