/**
 * A GoWay city tile's bytes → the buildings the OSM mesher takes.
 *
 * The second source mode of the city-3D engine (`docs/MAP_3D_CITY.md` →
 * Phase 2). The tile is MVT with GoWay's own `building` schema
 * (`lib/map/cityTiles.ts`), decoded with the same `pbf` + `@mapbox/vector-tile`
 * the OpenMapTiles path uses, so this adds no dependency to the worker.
 *
 * Every property is UNTRUSTED here — the tile came over the network — so each
 * is type-checked and range-checked, and a bad one is dropped exactly as the
 * compiler drops a bad tag: a building with a nonsense roof is drawn with a
 * flat one, not with the nonsense.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import {
  CITY_PROPS,
  CITY_TILE_LAYER,
  ROOF_MATERIALS,
  ROOF_SHAPES,
  type RoofMaterial,
  type RoofShape,
  UNKNOWN_HEIGHT_M,
  WALL_MATERIALS,
  type WallMaterial,
} from '@/lib/map/cityTiles';

import type { Point2 } from './mesher';

/** One building or building part, as the mesher needs it. */
export interface OsmBuilding {
  /** `osmId × 10 + 2|3` — provenance, never shown. */
  id: number;
  /** Rings in TILE UNITS (y down), exteriors and holes interleaved per the MVT rule. */
  rings: Point2[][];
  /** Metres above ground of the roof's top, and of the building's base. */
  top: number;
  base: number;
  /** Recorded storeys (`building:levels`); absent means "not recorded", never 0. */
  levels?: number;
  /**
   * Whether anything records the building's height (`height_source`, or a
   * `height` / `levels` an older tile carries). `false`: the top is the 5 m
   * default. Absent is treated as recorded.
   */
  heightRecorded?: boolean;
  minLevel?: number;
  roof?: {
    shape: RoofShape;
    /** Metres from the eaves to the top. */
    height: number;
    /** Compass bearing the slope faces. */
    direction?: number;
    across: boolean;
  };
  /** `0xRRGGBB`. */
  colour?: number;
  roofColour?: number;
  material?: WallMaterial;
  roofMaterial?: RoofMaterial;
  /** Recorded as lit at night (`floodlit` / `lit`, `CITY_PROPS.floodlit`). */
  floodlit?: boolean;
}

export interface DecodedCityTile {
  extent: number;
  buildings: OsmBuilding[];
}

const POLYGON = 3;
const MAX_HEIGHT_M = 1000;

function metres(value: unknown, allowZero: boolean): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value > MAX_HEIGHT_M || value < 0 || (value === 0 && !allowZero)) return undefined;
  return value;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 200
    ? value
    : undefined;
}

function colour(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  return Number.parseInt(value.slice(1), 16);
}

function member<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** One feature's properties → the building's numbers. Exported for the tests. */
export function buildingFromProperties(
  id: number,
  rings: Point2[][],
  properties: Record<string, unknown>,
): OsmBuilding {
  const top = metres(properties[CITY_PROPS.renderHeight], false) ?? UNKNOWN_HEIGHT_M;
  let base = metres(properties[CITY_PROPS.renderMinHeight], true) ?? 0;
  if (base >= top) base = 0;
  const levels = count(properties[CITY_PROPS.levels]);
  const heightRecorded =
    typeof properties[CITY_PROPS.heightSource] === 'string' ||
    metres(properties[CITY_PROPS.height], false) !== undefined ||
    levels !== undefined;
  const building: OsmBuilding = { id, rings, top, base, heightRecorded };

  if (levels !== undefined) building.levels = levels;
  const minLevel = count(properties[CITY_PROPS.minLevel]);
  if (minLevel !== undefined) building.minLevel = minLevel;

  const shape = member(properties[CITY_PROPS.roofShape], ROOF_SHAPES);
  const roofHeight = metres(properties[CITY_PROPS.roofHeight], false);
  if (shape && shape !== 'flat' && roofHeight !== undefined) {
    const direction = properties[CITY_PROPS.roofDirection];
    building.roof = {
      shape,
      height: Math.min(roofHeight, top - base),
      direction:
        typeof direction === 'number' && Number.isFinite(direction) ? direction % 360 : undefined,
      across: properties[CITY_PROPS.roofOrientation] === 'across',
    };
  }
  const wall = colour(properties[CITY_PROPS.colour]);
  if (wall !== undefined) building.colour = wall;
  const roof = colour(properties[CITY_PROPS.roofColour]);
  if (roof !== undefined) building.roofColour = roof;
  const material = member(properties[CITY_PROPS.material], WALL_MATERIALS);
  if (material) building.material = material;
  const roofMaterial = member(properties[CITY_PROPS.roofMaterial], ROOF_MATERIALS);
  if (roofMaterial) building.roofMaterial = roofMaterial;
  if (properties[CITY_PROPS.floodlit] === true) building.floodlit = true;
  return building;
}

/** Decode a city tile. `null` when it has no building layer (an empty tile). */
export function decodeCityTile(bytes: ArrayBuffer | Uint8Array): DecodedCityTile | null {
  const tile = new VectorTile(
    new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  );
  const layer = tile.layers[CITY_TILE_LAYER];
  if (!layer) return null;
  const buildings: OsmBuilding[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== POLYGON) continue;
    const rings = feature.loadGeometry().map((ring) => ring.map((p): Point2 => [p.x, p.y]));
    buildings.push(buildingFromProperties(Number(feature.id ?? 0), rings, feature.properties));
  }
  return { extent: layer.extent, buildings };
}
