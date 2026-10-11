/**
 * A vector tile's bytes → what `trees.ts` places trees from.
 *
 * Same decoders and the same rule as `decode.ts`: the source-layer names are
 * OpenMapTiles' and are passed in by the caller (from
 * `OPENMAPTILES_SOURCE_LAYERS`), never spelled here. Imported only by the mesh
 * Web Worker.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import type { Point2 } from './mesher';
import {
  type AreaRings,
  type AreaRole,
  landcoverRole,
  landuseRole,
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

/**
 * Decode the tree sources of a tile. `null` when the tile has no landcover or
 * landuse that could hold a tree (most tiles: sea, fields, dense centres) —
 * checked before anything else is decoded, so those tiles cost one layer scan.
 */
export function decodeTreeSources(
  bytes: ArrayBuffer | Uint8Array,
  layers: TreeSourceLayers,
): TreeSources | null {
  const tile = new VectorTile(
    new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  );
  const sources: TreeSources = {
    extent: 4096,
    wood: [],
    park: [],
    lawn: [],
    blocked: [],
    paths: [],
  };
  const add = (role: AreaRole, rings: AreaRings) => {
    if (role === 'wood') sources.wood.push(rings);
    else if (role === 'park') sources.park.push(rings);
    else if (role === 'lawn') sources.lawn.push(rings);
    else if (role === 'blocked') sources.blocked.push(rings);
  };

  const landcover = tile.layers[layers.landcover];
  const landuse = tile.layers[layers.landuse];
  if (landcover) {
    sources.extent = landcover.extent;
    for (let i = 0; i < landcover.length; i++) {
      const feature = landcover.feature(i);
      if (feature.type !== POLYGON) continue;
      const { class: cls, subclass } = feature.properties;
      add(landcoverRole(cls, subclass), toRings(feature.loadGeometry()));
    }
  }
  if (landuse) {
    sources.extent = landuse.extent;
    for (let i = 0; i < landuse.length; i++) {
      const feature = landuse.feature(i);
      if (feature.type !== POLYGON) continue;
      add(landuseRole(feature.properties.class), toRings(feature.loadGeometry()));
    }
  }
  if (sources.wood.length === 0 && sources.park.length === 0) return null;

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

/** One tree OpenStreetMap records, from a GoWay city tile's `tree` layer. */
export interface MappedTree {
  id: number;
  /** Tile units, y down. */
  x: number;
  y: number;
  crown?: string;
  heightM?: number;
}

/**
 * The `natural=tree` points of a GoWay city tile (`lib/map/cityTiles.ts` →
 * `CITY_TREE_LAYER`, passed in as `layer`). Empty when the tile has none.
 */
export function decodeMappedTrees(
  bytes: ArrayBuffer | Uint8Array,
  layer: string,
): { extent: number; trees: MappedTree[] } {
  const tile = new VectorTile(
    new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  );
  const source = tile.layers[layer];
  if (!source) return { extent: 4096, trees: [] };
  const trees: MappedTree[] = [];
  for (let i = 0; i < source.length; i++) {
    const feature = source.feature(i);
    if (feature.type !== 1) continue;
    const point = feature.loadGeometry()[0]?.[0];
    if (!point) continue;
    const { crown, height } = feature.properties;
    trees.push({
      id: Number(feature.id ?? i),
      x: point.x,
      y: point.y,
      crown: typeof crown === 'string' ? crown : undefined,
      heightM: typeof height === 'number' && height > 0 ? height : undefined,
    });
  }
  return { extent: source.extent, trees };
}
