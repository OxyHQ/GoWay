/**
 * A vector tile's bytes → what `trees.ts` places trees from, and what
 * `treeContext.ts` reads a mapped tree's setting from.
 *
 * Same decoders and the same rule as `decode.ts`: the source-layer names are
 * OpenMapTiles' and are passed in by the caller (from
 * `OPENMAPTILES_SOURCE_LAYERS`), never spelled here. Imported only by the mesh
 * Web Worker.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { CITY_TREE_PROPS } from '@/lib/map/cityTiles';

import type { Point2 } from './mesher';
import {
  type AreaRings,
  type AreaRole,
  isUrbanLanduse,
  landcoverRole,
  landuseRole,
  type MappedTreeInput,
  pathHalfWidthM,
  type TreeSources,
} from './trees';

/** The OpenMapTiles source-layers trees are placed from. */
export interface TreeSourceLayers {
  landcover: string;
  landuse: string;
  water: string;
  transportation: string;
  building: string;
}

const LINE = 2;
const POLYGON = 3;

type Geometry = ReturnType<ReturnType<VectorTile['layers'][string]['feature']>['loadGeometry']>;

const toRings = (geometry: Geometry): AreaRings =>
  geometry.map((ring) => ring.map((p): Point2 => [p.x, p.y]));

/** A tile's areas by what they mean for trees, in its tile units. */
export interface TreeAreas {
  extent: number;
  wood: AreaRings[];
  park: AreaRings[];
  lawn: AreaRings[];
  blocked: AreaRings[];
  /** Urban landuse (`isUrbanLanduse`): read by the setting, not the fill. */
  urban: AreaRings[];
}

/** Parse a tile once, for {@link treeAreasOf} and {@link treeSourcesOf}. */
export function openTile(bytes: ArrayBuffer | Uint8Array): VectorTile {
  return new VectorTile(new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
}

/** The landcover and landuse areas of a parsed tile, by role. */
export function treeAreasOf(tile: VectorTile, layers: TreeSourceLayers): TreeAreas {
  const areas: TreeAreas = {
    extent: 4096,
    wood: [],
    park: [],
    lawn: [],
    blocked: [],
    urban: [],
  };
  const add = (role: AreaRole, rings: AreaRings) => {
    if (role === 'wood') areas.wood.push(rings);
    else if (role === 'park') areas.park.push(rings);
    else if (role === 'lawn') areas.lawn.push(rings);
    else if (role === 'blocked') areas.blocked.push(rings);
  };
  const landcover = tile.layers[layers.landcover];
  if (landcover) {
    areas.extent = landcover.extent;
    for (let i = 0; i < landcover.length; i++) {
      const feature = landcover.feature(i);
      if (feature.type !== POLYGON) continue;
      const { class: cls, subclass } = feature.properties;
      add(landcoverRole(cls, subclass), toRings(feature.loadGeometry()));
    }
  }
  const landuse = tile.layers[layers.landuse];
  if (landuse) {
    areas.extent = landuse.extent;
    for (let i = 0; i < landuse.length; i++) {
      const feature = landuse.feature(i);
      if (feature.type !== POLYGON) continue;
      const cls = feature.properties.class;
      if (isUrbanLanduse(cls)) areas.urban.push(toRings(feature.loadGeometry()));
      else add(landuseRole(cls), toRings(feature.loadGeometry()));
    }
  }
  return areas;
}

/**
 * The fill's sources of a parsed tile whose areas are `areas`. `null` when it
 * has no wood or park (most tiles: sea, fields, dense centres) — decided
 * before anything else is decoded, so those tiles cost the area scan alone.
 */
export function treeSourcesOf(
  tile: VectorTile,
  layers: TreeSourceLayers,
  areas: TreeAreas,
): TreeSources | null {
  if (areas.wood.length === 0 && areas.park.length === 0) return null;
  const sources: TreeSources = {
    extent: areas.extent,
    wood: areas.wood,
    park: areas.park,
    lawn: areas.lawn,
    blocked: [...areas.blocked],
    paths: [],
  };
  const water = tile.layers[layers.water];
  if (water) {
    for (let i = 0; i < water.length; i++) {
      const feature = water.feature(i);
      if (feature.type === POLYGON) sources.blocked.push(toRings(feature.loadGeometry()));
    }
  }
  const building = tile.layers[layers.building];
  if (building) {
    for (let i = 0; i < building.length; i++) {
      const feature = building.feature(i);
      if (feature.type === POLYGON) sources.blocked.push(toRings(feature.loadGeometry()));
    }
  }
  const transportation = tile.layers[layers.transportation];
  if (transportation) {
    for (let i = 0; i < transportation.length; i++) {
      const feature = transportation.feature(i);
      // Tunnels run under the park; their line is not on the ground.
      if (feature.properties.brunnel === 'tunnel') continue;
      const geometry = feature.loadGeometry();
      if (feature.type === POLYGON) {
        sources.blocked.push(toRings(geometry));
      } else if (feature.type === LINE) {
        const halfWidthM = pathHalfWidthM(feature.properties.class);
        for (const line of geometry) {
          sources.paths.push({ points: line.map((p): Point2 => [p.x, p.y]), halfWidthM });
        }
      }
    }
  }
  return sources;
}

/**
 * Decode the fill's sources of a tile. `null` when the tile has no landcover
 * or landuse that could hold a tree.
 */
export function decodeTreeSources(
  bytes: ArrayBuffer | Uint8Array,
  layers: TreeSourceLayers,
): TreeSources | null {
  const tile = openTile(bytes);
  return treeSourcesOf(tile, layers, treeAreasOf(tile, layers));
}

/** One tree OpenStreetMap records, from a GoWay city tile's `tree` layer. */
export type MappedTree = MappedTreeInput;

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The `natural=tree` points of a GoWay city tile (`lib/map/cityTiles.ts` →
 * `CITY_TREE_LAYER`, passed in as `layer`), with what each records
 * (`CITY_TREE_PROPS`). Empty when the tile has none.
 */
export function decodeMappedTrees(
  bytes: ArrayBuffer | Uint8Array,
  layer: string,
): { extent: number; trees: MappedTree[] } {
  const source = openTile(bytes).layers[layer];
  if (!source) return { extent: 4096, trees: [] };
  const trees: MappedTree[] = [];
  for (let i = 0; i < source.length; i++) {
    const feature = source.feature(i);
    if (feature.type !== 1) continue;
    const point = feature.loadGeometry()[0]?.[0];
    if (!point) continue;
    const p = feature.properties;
    const crown = p[CITY_TREE_PROPS.crown];
    const tree: MappedTree = {
      id: Number(feature.id ?? i),
      x: point.x,
      y: point.y,
      crown: typeof crown === 'string' ? crown : undefined,
      heightM: positive(p[CITY_TREE_PROPS.height]),
    };
    const crownDiameterM = positive(p[CITY_TREE_PROPS.crownDiameter]);
    if (crownDiameterM !== undefined) tree.crownDiameterM = crownDiameterM;
    const circumferenceM = positive(p[CITY_TREE_PROPS.circumference]);
    if (circumferenceM !== undefined) tree.circumferenceM = circumferenceM;
    if (p[CITY_TREE_PROPS.street] === true) tree.street = true;
    trees.push(tree);
  }
  return { extent: source.extent, trees };
}
