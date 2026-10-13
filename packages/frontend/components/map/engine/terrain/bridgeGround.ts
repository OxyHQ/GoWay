import { allowsMotorTraffic, roadAccessOf } from '@goway.to/sdk/road-access';
import { chainPieces, pointAt, polyline, project, type Polyline } from '../roads/roadGraph';
import type { RoadPiece } from '../roads/roadTiles';
import { drivingSideAt } from '../roads/drivingSide';
import { BRIDGE_MEMBER_MAX_OFFSET_M } from '../roads/bridgeGeometry';
import { crossSection, paintRulesAt } from '../cityStreets/lanes';

export interface TerrainBridge {
  line: Polyline;
  halfWidth: number;
  left?: number;
  right?: number;
  bounds?: [number, number, number, number];
}

/** Global z15 road units to this DEM's pixel coordinates. */
export function terrainBridges(
  roads: RoadPiece[],
  tile: { z: number; x: number; y: number },
  size: number,
): TerrainBridge[] {
  const world = 2 ** tile.z * size;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 0.5)) / 2 ** tile.z))) * 180) / Math.PI;
  const lng = ((tile.x + 0.5) / 2 ** tile.z) * 360 - 180;
  const metresPerPixel = (40075016.68557849 * Math.cos((lat * Math.PI) / 180)) / world;
  const rules = paintRulesAt(lng, lat, drivingSideAt(lng, lat));
  const nodes = new Map<string, number>(),
    degrees = new Map<number, number>();
  const node = (p: [number, number]) => {
    const key = p.join('/');
    const existing = nodes.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.size;
    nodes.set(key, id);
    return id;
  };
  const seen = new Set<string>();
  const pieces = roads
    .filter((p) => p.bridge && !p.tunnel)
    .flatMap((p) => {
      const key = `${p.way}/${p.points[0]}/${p.points[p.points.length - 1]}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const a = node(p.points[0]),
        b = node(p.points[p.points.length - 1]);
      for (const n of [a, b]) degrees.set(n, (degrees.get(n) ?? 0) + 1);
      return [{ a, b, oneway: false, road: p, points: p.points }];
    });
  const corridors = chainPieces(
    pieces,
    (n) => degrees.get(n) ?? 0,
    (p) => ({ ...p, a: p.b, b: p.a, points: [...p.points].reverse() }),
    (a, b) => a.road.highway === b.road.highway,
  ).map((chain) => {
    const points = chain
      .flatMap((p, i) => (i ? p.points.slice(1) : p.points))
      .map(([x, y]): [number, number] => [
        (x / (32768 * 4096)) * world - tile.x * size,
        (y / (32768 * 4096)) * world - tile.y * size,
      ]);
    // The same carriageway width used by the street renderer. Separate mapped
    // bridge footways contribute their own corridors, not an invented margin.
    const width = Math.max(
      ...chain.map(({ road: p }) =>
        allowsMotorTraffic(roadAccessOf(p.highway, p.access))
          ? crossSection(p, rules).width
          : (p.width ?? p.sidewalkWidth ?? 2),
      ),
    );
    return {
      line: polyline(points),
      halfWidth: width / metresPerPixel / 2,
      carriageway: chain.some((p) =>
        allowsMotorTraffic(roadAccessOf(p.road.highway, p.road.access)),
      ),
    };
  });
  // A separately mapped sidewalk is part of the same physical deck. Its
  // recorded position bounds that deck; gaps between its line and the road
  // are not strips of earth penetrating the bridge.
  const result: TerrainBridge[] = [];
  for (const anchor of corridors.filter((c) => c.carriageway)) {
    let left = -anchor.halfWidth,
      right = anchor.halfWidth;
    for (const member of corridors) {
      if (member === anchor) continue;
      const middle = { x: 0, y: 0, h: 0 },
        at = { x: 0, y: 0, h: 0 };
      pointAt(member.line, member.line.length / 2, middle);
      const match = project(anchor.line, middle.x, middle.y);
      pointAt(anchor.line, match.s, at);
      if (
        match.s <= 0 ||
        match.s >= anchor.line.length ||
        match.d * metresPerPixel > BRIDGE_MEMBER_MAX_OFFSET_M ||
        Math.abs(Math.cos(at.h - middle.h)) < 0.9
      )
        continue;
      const lateral = -(middle.x - at.x) * Math.sin(at.h) + (middle.y - at.y) * Math.cos(at.h);
      left = Math.min(left, lateral - member.halfWidth);
      right = Math.max(right, lateral + member.halfWidth);
    }
    result.push({ line: anchor.line, halfWidth: Math.max(-left, right), left, right });
  }
  result.push(...corridors.filter((c) => !c.carriageway));
  return result;
}

/**
 * Bare-earth reconstruction only inside a mapped bridge footprint. Some DTM
 * sources retain bridge returns: interpolate the obscured ground between the
 * two exterior terrain samples. Never raise terrain or change land outside
 * the footprint; preserve both abutment sections. No assumed clearance.
 * Coordinates are DEM pixels, so the one-cell support is sampling accuracy.
 */
export function bridgeGround(
  x: number,
  y: number,
  bridges: readonly TerrainBridge[],
  sample: (x: number, y: number) => number,
): number {
  const original = sample(x, y);
  let result = original;
  for (const bridge of bridges) {
    const b = bridge.bounds;
    if (b && (x < b[0] || y < b[1] || x > b[2] || y > b[3])) continue;
    const match = project(bridge.line, x, y);
    if (match.d > bridge.halfWidth || match.s <= 1 || match.s >= bridge.line.length - 1) continue;
    const at = { x: 0, y: 0, h: 0 };
    pointAt(bridge.line, match.s, at);
    const nx = -Math.sin(at.h),
      ny = Math.cos(at.h);
    const lateral = (x - at.x) * nx + (y - at.y) * ny;
    const edgeLeft = bridge.left ?? -bridge.halfWidth,
      edgeRight = bridge.right ?? bridge.halfWidth;
    if (lateral < edgeLeft || lateral > edgeRight) continue;
    const outside = (side: number) => {
      let d = (side < 0 ? -edgeLeft : edgeRight) + 1;
      // An adjacent bridge carriageway belongs to the same excluded surface.
      // Stop at the first actual terrain cell, within the source tile halo.
      for (let i = 0; i < 64; i++, d++) {
        const px = at.x + nx * d * side,
          py = at.y + ny * d * side;
        if (
          !bridges.some((b) => {
            const p = project(b.line, px, py);
            if (p.s <= 0 || p.s >= b.line.length || p.d > b.halfWidth) return false;
            const at = { x: 0, y: 0, h: 0 };
            pointAt(b.line, p.s, at);
            const lateral = -(px - at.x) * Math.sin(at.h) + (py - at.y) * Math.cos(at.h);
            return lateral >= (b.left ?? -b.halfWidth) && lateral <= (b.right ?? b.halfWidth);
          })
        )
          return { d: d * side, z: sample(px, py) };
      }
      return null;
    };
    const left = outside(-1),
      right = outside(1);
    if (!left || !right || !Number.isFinite(left.z) || !Number.isFinite(right.z)) continue;
    // Only remove an elevated surface above BOTH banks, not a natural slope.
    if (original <= Math.max(left.z, right.z)) continue;
    const t = (lateral - left.d) / (right.d - left.d);
    const floor = left.z + (right.z - left.z) * t;
    const support = Math.min(1, match.s - 1, bridge.line.length - match.s - 1);
    result = Math.min(result, original + (floor - original) * support);
  }
  return result;
}
