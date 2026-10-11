/**
 * Encode one city tile as a Mapbox Vector Tile v2 with a single `building`
 * layer (`lib/map/cityTiles.ts` says why MVT and what the properties mean).
 *
 * The geometry rules a reader depends on, enforced here rather than trusted
 * from the input:
 *
 *  - Exterior rings have POSITIVE area in tile coordinates (`y` down, the
 *    shoelace sum) and holes negative — the spec's rule, which both
 *    `@mapbox/vector-tile` and the city-3D mesher use to tell them apart.
 *  - A ring's closing point is implied by `ClosePath`, never repeated.
 *  - Consecutive duplicate points (quantisation collapses them) are removed,
 *    and a ring left with fewer than three points is dropped; an exterior
 *    dropped takes its holes with it.
 *
 * Coordinates may lie outside `[0, extent]`: buildings are whole, unclipped,
 * and belong to the tile holding their representative point.
 */
import { PbfWriter } from 'pbf';

import { CITY_TILE_EXTENT, CITY_TILE_LAYER } from '../../lib/map/cityTiles';

export type TilePoint = readonly [number, number];

export interface TilePolygon {
  outer: TilePoint[];
  holes: TilePoint[][];
}

export interface CityTileFeature {
  /** `osmId × 10 + 2|3` (way | relation), Planetiler's encoding. */
  id: number;
  polygons: TilePolygon[];
  properties: Record<string, string | number | boolean>;
}

/** Twice the signed area in tile coordinates; positive is an exterior per the MVT spec. */
export function tileRingArea(ring: readonly TilePoint[]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/** Round to integers, drop repeats and the closing duplicate. */
export function quantizeRing(ring: readonly TilePoint[]): TilePoint[] {
  const out: TilePoint[] = [];
  for (const [x, y] of ring) {
    const point: TilePoint = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  while (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  ) {
    out.pop();
  }
  return out;
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const command = (id: number, count: number) => (id & 7) | (count << 3);

/** The geometry command stream for one feature's polygons. Empty when nothing survived. */
export function encodePolygons(polygons: readonly TilePolygon[]): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  const ring = (points: TilePoint[], exterior: boolean) => {
    const area = tileRingArea(points);
    const ordered = area > 0 === exterior ? points : points.slice().reverse();
    out.push(command(1, 1), zigzag(ordered[0][0] - cx), zigzag(ordered[0][1] - cy));
    cx = ordered[0][0];
    cy = ordered[0][1];
    out.push(command(2, ordered.length - 1));
    for (let i = 1; i < ordered.length; i++) {
      out.push(zigzag(ordered[i][0] - cx), zigzag(ordered[i][1] - cy));
      cx = ordered[i][0];
      cy = ordered[i][1];
    }
    out.push(command(7, 1));
  };
  for (const polygon of polygons) {
    const outer = quantizeRing(polygon.outer);
    if (outer.length < 3 || tileRingArea(outer) === 0) continue;
    ring(outer, true);
    for (const hole of polygon.holes) {
      const points = quantizeRing(hole);
      if (points.length >= 3 && tileRingArea(points) !== 0) ring(points, false);
    }
  }
  return out;
}

type Value = string | number | boolean;

/** Encode the tile. Features whose geometry vanished on quantisation are omitted. */
export function encodeCityTile(features: readonly CityTileFeature[]): Uint8Array {
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  const values: Value[] = [];
  const valueIndex = new Map<string, number>();
  const encoded: { id: number; tags: number[]; geometry: number[] }[] = [];

  for (const feature of features) {
    const geometry = encodePolygons(feature.polygons);
    if (geometry.length === 0) continue;
    const tags: number[] = [];
    for (const [key, value] of Object.entries(feature.properties)) {
      let k = keyIndex.get(key);
      if (k === undefined) {
        k = keys.length;
        keys.push(key);
        keyIndex.set(key, k);
      }
      const valueKey = `${typeof value}:${String(value)}`;
      let v = valueIndex.get(valueKey);
      if (v === undefined) {
        v = values.length;
        values.push(value);
        valueIndex.set(valueKey, v);
      }
      tags.push(k, v);
    }
    encoded.push({ id: feature.id, tags, geometry });
  }

  const pbf = new PbfWriter();
  if (encoded.length === 0) return pbf.finish();
  pbf.writeMessage(
    3,
    (_: null, layer) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, CITY_TILE_LAYER);
      for (const feature of encoded) {
        layer.writeMessage(
          2,
          (_unused: null, out) => {
            out.writeVarintField(1, feature.id);
            out.writePackedVarint(2, feature.tags);
            out.writeVarintField(3, 3);
            out.writePackedVarint(4, feature.geometry);
          },
          null,
        );
      }
      for (const key of keys) layer.writeStringField(3, key);
      for (const value of values) {
        layer.writeMessage(
          4,
          (_unused: null, out) => {
            if (typeof value === 'string') out.writeStringField(1, value);
            else if (typeof value === 'boolean') out.writeBooleanField(7, value);
            else if (Number.isInteger(value) && value >= 0) out.writeVarintField(5, value);
            else out.writeDoubleField(3, value);
          },
          null,
        );
      }
      layer.writeVarintField(5, CITY_TILE_EXTENT);
    },
    null,
  );
  return pbf.finish();
}
