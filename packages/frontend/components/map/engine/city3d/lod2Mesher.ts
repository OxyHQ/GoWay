/**
 * LOD2 roof surfaces → one tile's triangle mesh: the measured roofs of an
 * official 3D building model, with walls raised from every roof edge down to
 * the ground or to the lower roof beside it.
 *
 * The sibling of `osmMesher.ts` for the `building_lod2` layer
 * (`lib/map/cityOfficial.ts`), writing the SAME vertex layout into the same
 * {@link Builder}, so the two meshes concatenate into one draw with one
 * shader (`osmShaders.ts`) and the engine needs no second material.
 *
 * ## A building as columns
 *
 * The tile stores roofs only (`scripts/citygen/lod2/prepare.ts` says why).
 * Each roof surface is drawn as a COLUMN: its polygon, capped by its plane,
 * with a wall down every edge. Where two surfaces of the model share an edge
 * (a setback, a bulkhead on a roof, the two slopes of a gable), the wall
 * between them is drawn only where it shows:
 *
 *  - the neighbour is as high or higher along the whole edge → no wall
 *    (it would be inside the building, or the ridge of a gable);
 *  - the neighbour is lower → only the step, from its roof up to this one;
 *  - no neighbour (the outline) → the full wall from the ground.
 *
 * Shared edges are found exactly: neighbouring surfaces share source
 * vertices, which quantise to identical integer tile coordinates. An edge
 * that does not line up exactly (a T-junction) gets a full wall, which the
 * neighbour's volume hides — wasted triangles, never a wrong picture.
 *
 * ## Shape from the model, recorded facts from OSM
 *
 * The compiler keeps the OSM building the model building matched best
 * (`osm_id`). Where that OSM feature is in the same tile, its RECORDED facts
 * dress the model's shape exactly as they would dress its own: tagged
 * colours and materials (tempered by the shader, `osmShaders.ts`) and the
 * storey rhythm where `building:levels` is recorded and fits the height
 * (`facadeFor`) — on outline walls only, never on a step above a neighbour
 * (a blind party wall). Without it the first Midtown render turned every
 * tagged brick tower into an anonymous beige one. A model building whose
 * match is in another tile is drawn plain, as an untagged one is.
 *
 * ## Honesty
 *
 * Geometry is the source's: roof planes as measured, walls only where a roof
 * edge forces one. The only things added are the shading terms every city
 * mesh gets (corner and ground occlusion, the height ramp) and the OSM facts
 * above. No bevel — a chamfer is styling, and a measured roof edge should
 * read as measured.
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
import type { Lod2Surface } from './lod2Tiles';
import { planeHeight } from './lod2Tiles';
import {
  MESH,
  type MeshTileOptions,
  type Point2,
  signedArea,
  turnAngle,
  wallColumns,
} from './mesher';
import { concavity, cornerOcclusion } from './occlusion';
import { Builder, type OsmTileMesh, VERTEX_FLAG_FLOODLIT } from './osmMesher';
import type { OsmBuilding } from './osmTiles';

type Rgba = readonly [number, number, number, number];
type Facade4 = readonly [number, number, number, number];
const NO_FACADE: Facade4 = [0, 0, 0, 0];

/** How one model building looks: its OSM match's recorded facts, or the plain ramp. */
interface Appearance {
  wall: Rgba;
  roof: Rgba;
  rhythm: FacadeRhythm | null;
}

const PLAIN: Appearance = { wall: [0, 0, 0, 0], roof: [0, 0, 0, 0], rhythm: null };

/** The recorded facts of an OSM building, as the OSM mesher would draw them. Exported for the tests. */
export function appearanceOf(osm: OsmBuilding | undefined): Appearance {
  if (!osm) return PLAIN;
  const roofHeight = osm.roof ? Math.min(osm.roof.height, osm.top - osm.base) : 0;
  return {
    wall: surfaceColour(osm.colour, osm.material ? WALL_MATERIAL_COLOURS[osm.material] : undefined),
    roof: surfaceColour(
      osm.roofColour,
      osm.roofMaterial ? ROOF_MATERIAL_COLOURS[osm.roofMaterial] : undefined,
    ),
    rhythm: facadeFor(osm.levels, osm.minLevel, osm.base, osm.top - roofHeight),
  };
}
/** Within this many metres a neighbour counts as "as high". */
const SAME_HEIGHT_M = 0.05;

/** A surface's polygons, in local metres (ENU, y north), exteriors counter-clockwise. */
interface Column {
  surface: Lod2Surface;
  polygons: Point2[][][];
  tone: number;
  look: Appearance;
  /**
   * Storeys on this column's outline walls: the source's own count for the
   * volume (the cadastre's) when it records one, else the OSM match's.
   */
  rhythm: FacadeRhythm | null;
}

/** A tile-unit point as one exact integer key (coordinates stay well inside ±2^20). */
const pointKey = (x: number, y: number) =>
  (Math.round(x) + 0x100000) * 0x200000 + (Math.round(y) + 0x100000);

/**
 * Rings (tile units, y down, closing point optional) → polygons in local
 * metres with exteriors counter-clockwise and holes clockwise — the
 * orientation rule of `osmPolygons` (`osmMesher.ts`), here for ONE surface.
 */
export function surfacePolygons(
  rings: readonly (readonly Point2[])[],
  scale: number,
): Point2[][][] {
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
    // Lower than the OSM mesher's floor: a bulkhead or a gable's end slope
    // can be a square metre and is still measured.
    if (Math.abs(area) < 0.05) continue;
    if (area > 0) {
      current = [points];
      polygons.push(current);
    } else if (current) {
      current.push(points);
    }
  }
  return polygons;
}

/**
 * Mesh a tile's LOD2 surfaces. `null` when nothing draws. Walls rise from the
 * ground (or a lower neighbouring roof) to each roof's plane; see the module
 * header for which walls are drawn.
 */
export function meshLod2Surfaces(
  surfaces: readonly Lod2Surface[],
  options: MeshTileOptions,
  /** The tile's OSM buildings, hidden ones included: where each model building's `osm_id` points. */
  osm: readonly OsmBuilding[] = [],
): OsmTileMesh | null {
  const scale = options.tileSizeMetres / options.extent;
  const builder = new Builder();
  const osmById = new Map<number, OsmBuilding>();
  for (const building of osm) osmById.set(building.id, building);

  // Tone: one per BUILDING (its highest roof), so a building is one colour of
  // the height ramp, as an OSM building is.
  const buildingTop = new Map<string, number>();
  surfaces.forEach((surface, i) => {
    const key = surface.sourceId !== undefined ? `${surface.source}|${surface.sourceId}` : `#${i}`;
    buildingTop.set(key, Math.max(buildingTop.get(key) ?? 0, surface.top));
  });
  const columns: Column[] = surfaces.map((surface, i) => {
    const key = surface.sourceId !== undefined ? `${surface.source}|${surface.sourceId}` : `#${i}`;
    const top = buildingTop.get(key) ?? surface.top;
    const look = appearanceOf(surface.osmId !== undefined ? osmById.get(surface.osmId) : undefined);
    return {
      surface,
      polygons: surfacePolygons(surface.rings, scale),
      tone: Math.round(Math.max(0, Math.min(MESH.toneMaxM, top))),
      look,
      rhythm:
        surface.levels !== undefined
          ? facadeFor(surface.levels, undefined, 0, surface.top)
          : look.rhythm,
    };
  });

  // Every edge, by its lower endpoint key: [other endpoint key, column index].
  const edges = new Map<number, number[]>();
  const toTile = (p: Point2): [number, number] => [p[0] / scale, -p[1] / scale];
  columns.forEach((column, c) => {
    for (const polygon of column.polygons) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const a = toTile(ring[i]);
          const b = toTile(ring[(i + 1) % ring.length]);
          const p = pointKey(a[0], a[1]);
          const q = pointKey(b[0], b[1]);
          if (p === q) continue;
          const low = Math.min(p, q);
          let list = edges.get(low);
          if (!list) {
            list = [];
            edges.set(low, list);
          }
          list.push(Math.max(p, q), c);
        }
      }
    }
  });
  const neighboursOf = (a: [number, number], b: [number, number], self: number): number[] => {
    const p = pointKey(a[0], a[1]);
    const q = pointKey(b[0], b[1]);
    const list = edges.get(Math.min(p, q));
    const out: number[] = [];
    if (!list) return out;
    const high = Math.max(p, q);
    for (let i = 0; i < list.length; i += 2) {
      if (list[i] === high && list[i + 1] !== self && !out.includes(list[i + 1]))
        out.push(list[i + 1]);
    }
    return out;
  };

  // One building (every surface sharing a source id) is one unit on terrain
  // (`terrainGround.ts`): its vertices contiguous, all on ONE ground, so its
  // setbacks stay level with each other on a slope.
  const groups = new Map<string, number[]>();
  columns.forEach((column, c) => {
    const surface = column.surface;
    const key = surface.sourceId !== undefined ? `${surface.source}|${surface.sourceId}` : `#${c}`;
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  });

  let drawn = 0;
  const meshColumn = (column: Column, c: number) => {
    const plane = column.surface.plane;
    // Clamped at the ground: a plane fitted to a sloped roof can dip a few
    // centimetres below zero at an eave.
    const heightAt = (x: number, y: number) =>
      Math.max(0, planeHeight(plane, x / scale, -y / scale));
    for (const polygon of column.polygons) {
      drawn++;
      // Walls.
      for (const ring of polygon) {
        const n = ring.length;
        const concave = ring.map((here, i) =>
          concavity(turnAngle(ring[(i + n - 1) % n], here, ring[(i + 1) % n])),
        );
        for (let i = 0; i < n; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % n];
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const length = Math.hypot(dx, dy);
          if (length < 1e-6) continue;
          const topA = heightAt(a[0], a[1]);
          const topB = heightAt(b[0], b[1]);
          const ta = toTile(a);
          const tb = toTile(b);
          let floorA = 0;
          let floorB = 0;
          for (const other of neighboursOf(ta, tb, c)) {
            const p = columns[other].surface.plane;
            floorA = Math.max(floorA, planeHeight(p, ta[0], ta[1]));
            floorB = Math.max(floorB, planeHeight(p, tb[0], tb[1]));
          }
          if (floorA >= topA - SAME_HEIGHT_M && floorB >= topB - SAME_HEIGHT_M) continue;
          floorA = Math.min(floorA, topA);
          floorB = Math.min(floorB, topB);
          const ux = dx / length;
          const uy = dy / length;
          const outward = [uy, -ux, 0];
          const cA = concave[i];
          const cB = concave[(i + 1) % n];
          // Openings only on an outline wall: one standing on a neighbour's
          // roof is a party wall rising above it, and blind.
          const rhythm = floorA === 0 && floorB === 0 ? column.rhythm : null;
          const bays = rhythm ? bayCount(length) : 0;
          let previous: [number, number] | null = null;
          for (const s of wallColumns(length, cA > 0, cB > 0)) {
            const t = s / length;
            const ao = Math.min(cornerOcclusion(cA, s), cornerOcclusion(cB, length - s));
            const x = a[0] + ux * s;
            const y = a[1] + uy * s;
            const bottom = floorA + (floorB - floorA) * t;
            const top = topA + (topB - topA) * t;
            const facade: Facade4 =
              rhythm && bays > 0
                ? [
                    Math.min(65535, Math.round(t * bays * 256)),
                    Math.min(65535, Math.round(rhythm.base * 10)),
                    Math.min(65535, Math.round(rhythm.storey * 100)),
                    rhythm.count,
                  ]
                : NO_FACADE;
            const wall = column.look.wall;
            const v0 = builder.vertex(x, y, bottom, outward, ao, column.tone, wall, facade);
            const v1 = builder.vertex(x, y, top, outward, ao, column.tone, wall, facade);
            if (previous) builder.quad(previous[0], v0, v1, previous[1]);
            previous = [v0, v1];
          }
        }
      }
      // Roof: the polygon on its plane.
      const flat: number[] = [];
      const holes: number[] = [];
      polygon.forEach((ring, r) => {
        if (r > 0) holes.push(flat.length / 2);
        for (const [x, y] of ring) flat.push(x, y);
      });
      const triangles = earcut(flat, holes.length > 0 ? holes : null, 2);
      if (triangles.length === 0) continue;
      // dh/dx and dh/dy in metres per metre, in ENU (tile y runs south).
      const gx = plane.dx / scale;
      const gy = -plane.dy / scale;
      const length = Math.hypot(gx, gy, 1);
      const normal = [-gx / length, -gy / length, 1 / length];
      const first = builder.vertexCount;
      for (let i = 0; i < flat.length; i += 2) {
        builder.vertex(
          flat[i],
          flat[i + 1],
          heightAt(flat[i], flat[i + 1]),
          normal,
          1,
          column.tone,
          column.look.roof,
          NO_FACADE,
        );
      }
      for (let t = 0; t < triangles.length; t += 3) {
        const [p, q, r] = [triangles[t], triangles[t + 1], triangles[t + 2]];
        const ccw =
          (flat[q * 2] - flat[p * 2]) * (flat[r * 2 + 1] - flat[p * 2 + 1]) -
            (flat[q * 2 + 1] - flat[p * 2 + 1]) * (flat[r * 2] - flat[p * 2]) >=
          0;
        if (ccw) builder.triangle(first + p, first + q, first + r);
        else builder.triangle(first + p, first + r, first + q);
      }
    }
  };
  for (const members of groups.values()) {
    const start = builder.vertexCount;
    // Per-building flags from the OSM match (lit at night), as `osmMesher.ts` sets them.
    const first = columns[members[0]].surface;
    const match = first.osmId !== undefined ? osmById.get(first.osmId) : undefined;
    builder.buildingFlags = match?.floodlit ? VERTEX_FLAG_FLOODLIT : 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of members) {
      for (const polygon of columns[c].polygons) {
        for (const [x, y] of polygon[0]) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      meshColumn(columns[c], c);
    }
    if (minX <= maxX) builder.building(start, [minX, minY, maxX, maxY]);
  }
  return builder.finish(drawn);
}

/** Two tile meshes as one (vertex buffers appended, indices offset). `null` + `null` is `null`. */
export function concatTileMeshes(a: OsmTileMesh | null, b: OsmTileMesh | null): OsmTileMesh | null {
  if (!a) return b;
  if (!b) return a;
  const vertices = a.positions.length / 3;
  const join = <T extends Float32Array | Int8Array | Uint8Array | Uint16Array | Uint32Array>(
    x: T,
    y: T,
  ): T => {
    const out = new (x.constructor as new (n: number) => T)(x.length + y.length);
    out.set(x);
    out.set(y, x.length);
    return out;
  };
  const indices = join(a.indices, b.indices);
  for (let i = a.indices.length; i < indices.length; i++) indices[i] += vertices;
  return {
    positions: join(a.positions, b.positions),
    normals: join(a.normals, b.normals),
    shade: join(a.shade, b.shade),
    colors: join(a.colors, b.colors),
    facade: join(a.facade, b.facade),
    flags: join(a.flags, b.flags),
    indices,
    bounds: {
      min: [0, 1, 2].map((k) => Math.min(a.bounds.min[k], b.bounds.min[k])) as [
        number,
        number,
        number,
      ],
      max: [0, 1, 2].map((k) => Math.max(a.bounds.max[k], b.bounds.max[k])) as [
        number,
        number,
        number,
      ],
    },
    polygons: a.polygons + b.polygons,
    polygonStarts: Uint32Array.from([
      ...a.polygonStarts,
      ...Array.from(b.polygonStarts, (start) => start + vertices),
    ]),
    polygonBoxes: join(a.polygonBoxes, b.polygonBoxes),
  };
}
