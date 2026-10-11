/**
 * A vector tile's bytes → the `building` features the mesher takes.
 *
 * The decoders are the same two packages MapLibre itself is built on
 * (`pbf`, `@mapbox/vector-tile`), pinned to the versions `maplibre-gl` already
 * resolves, so this reads a tile exactly the way the basemap does. They are
 * imported only here and only reach the mesh Web Worker's bundle.
 *
 * The source-layer name is NOT spelled here: it is OpenMapTiles' `building`,
 * passed in by the caller from `OPENMAPTILES_SOURCE_LAYERS`, so a schema rename
 * is one edit in `lib/map/style/schema.ts`.
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import type { BuildingFeature, Point2 } from './mesher';

/** Vector-tile geometry type for polygons. */
const POLYGON = 3;

export interface DecodedBuildings {
  /** The layer's extent (tile units per side). */
  extent: number;
  features: BuildingFeature[];
}

/**
 * Decode the polygons of one source-layer. `null` when the tile has no such
 * layer — the normal case over the sea and in the countryside.
 */
export function decodeBuildings(
  bytes: ArrayBuffer | Uint8Array,
  sourceLayer: string,
): DecodedBuildings | null {
  const tile = new VectorTile(
    new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  );
  const layer = tile.layers[sourceLayer];
  if (!layer) return null;
  const features: BuildingFeature[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== POLYGON) continue;
    const rings = feature.loadGeometry().map((ring) => ring.map((p): Point2 => [p.x, p.y]));
    const { render_height, render_min_height, hide_3d } = feature.properties;
    features.push({ rings, properties: { render_height, render_min_height, hide_3d } });
  }
  return { extent: layer.extent, features };
}
