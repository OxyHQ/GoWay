/**
 * A GoWay city tile's `building_lod2` layer → the roof surfaces the LOD2
 * mesher (`lod2Mesher.ts`) raises a city from.
 *
 * Schema: `lib/map/cityOfficial.ts` (`CITY_TILE_LOD2_LAYER`, `CITY_LOD2_PROPS`).
 * Each feature is ONE planar roof surface of an official 3D building model;
 * the compiler (`scripts/citygen/lod2/conflate.ts`) decided which buildings
 * it draws and marked the OSM features it replaces (`drawn_by`).
 *
 * Every property is UNTRUSTED (the tile came over the network): the plane
 * must be finite, its height within the same 0–1000 m the OSM decoder
 * accepts, its slope at most {@link MAX_SLOPE} metres per tile unit, and the
 * source a known one — a surface failing any check is dropped, never drawn
 * with a guessed number.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { CITY_PROPS } from '@/lib/map/cityTiles';
import {
  CITY_LOD2_PROPS,
  CITY_LOD2_SOURCES,
  CITY_TILE_LOD2_LAYER,
  type CityLod2Source,
} from '@/lib/map/cityOfficial';

import type { Point2 } from './mesher';

/** One roof surface: rings in TILE UNITS (y down) and the plane it lies in. */
export interface Lod2Surface {
  rings: Point2[][];
  /** Metres above ground at `(x0, y0)`, plus metres per tile unit along x and y. */
  plane: { h: number; dx: number; dy: number; x0: number; y0: number };
  /** The surface's highest point, metres (`render_height`). */
  top: number;
  source: CityLod2Source;
  /** The dataset's building id; surfaces sharing one are one building. */
  sourceId?: string;
  /** The OSM feature the building matched best (`osm_id`): where its recorded colours come from. */
  osmId?: number;
  /** Storeys above ground the source records for this volume (the cadastre's). */
  levels?: number;
}

const POLYGON = 3;
const MAX_HEIGHT_M = 1000;
/** Steeper than this (~76° at z15 over 40°N) is not a roof a source means. */
export const MAX_SLOPE = 1;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** A surface's plane evaluated at a tile-unit point. */
export function planeHeight(plane: Lod2Surface['plane'], x: number, y: number): number {
  return plane.h + plane.dx * (x - plane.x0) + plane.dy * (y - plane.y0);
}

function signedArea(ring: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/** One feature → a surface, or `null` when a property fails its check. Exported for the tests. */
export function surfaceFromFeature(
  rings: Point2[][],
  properties: Record<string, unknown>,
): Lod2Surface | null {
  const source = properties[CITY_LOD2_PROPS.source];
  if (typeof source !== 'string' || !Object.hasOwn(CITY_LOD2_SOURCES, source)) return null;
  // A flat roof carries only `render_height`; a sloped one its plane.
  const h = finite(properties[CITY_LOD2_PROPS.roofH] ?? properties[CITY_PROPS.renderHeight]);
  if (h === undefined || h < -1 || h > MAX_HEIGHT_M) return null;
  const dx =
    properties[CITY_LOD2_PROPS.roofDx] === undefined
      ? 0
      : finite(properties[CITY_LOD2_PROPS.roofDx]);
  const dy =
    properties[CITY_LOD2_PROPS.roofDy] === undefined
      ? 0
      : finite(properties[CITY_LOD2_PROPS.roofDy]);
  if (
    dx === undefined ||
    dy === undefined ||
    Math.abs(dx) > MAX_SLOPE ||
    Math.abs(dy) > MAX_SLOPE
  ) {
    return null;
  }
  // The plane's origin is the exterior's minimum corner, as encoded.
  const exterior = rings.find((ring) => ring.length >= 3 && signedArea(ring) > 0);
  if (!exterior) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  for (const [x, y] of exterior) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
  }
  const plane = { h, dx, dy, x0, y0 };
  let top = 0;
  for (const ring of rings)
    for (const [x, y] of ring) top = Math.max(top, planeHeight(plane, x, y));
  const recorded = finite(properties[CITY_PROPS.renderHeight]);
  // `render_height` is the compiler's own max; trust the plane, bounded by it.
  if (recorded !== undefined && recorded > 0 && recorded <= MAX_HEIGHT_M)
    top = Math.min(top, recorded + 0.5);
  if (!(top > 0) || top > MAX_HEIGHT_M) return null;
  const sourceId = properties[CITY_LOD2_PROPS.sourceId];
  const osmId = properties[CITY_LOD2_PROPS.osmId];
  const levels = properties[CITY_LOD2_PROPS.levels];
  return {
    rings,
    plane,
    top,
    source: source as CityLod2Source,
    sourceId:
      typeof sourceId === 'string' || typeof sourceId === 'number' ? String(sourceId) : undefined,
    osmId: typeof osmId === 'number' && Number.isSafeInteger(osmId) ? osmId : undefined,
    levels:
      typeof levels === 'number' && Number.isInteger(levels) && levels >= 1 && levels <= 200
        ? levels
        : undefined,
  };
}

/** The tile's LOD2 surfaces; empty when it has no `building_lod2` layer. */
export function decodeLod2Tile(bytes: ArrayBuffer | Uint8Array): Lod2Surface[] {
  const tile = new VectorTile(
    new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  );
  const layer = tile.layers[CITY_TILE_LOD2_LAYER];
  if (!layer) return [];
  const surfaces: Lod2Surface[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== POLYGON) continue;
    const rings = feature.loadGeometry().map((ring) => ring.map((p): Point2 => [p.x, p.y]));
    const surface = surfaceFromFeature(rings, feature.properties);
    if (surface) surfaces.push(surface);
  }
  return surfaces;
}
