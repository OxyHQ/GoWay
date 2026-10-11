/**
 * The messages between the city-3D engine and its mesh Web Workers.
 *
 * Types only — nothing here exists at runtime — so both sides can import it
 * without either pulling the other's dependencies into its bundle.
 */
import type { Lod } from './lod';
import type { PackedMesh } from './packing';
import type { TreeSourceLayers } from './treeSources';
import type { TreeInstances } from './trees';
import type { TileId } from './tileMath';

/**
 * Which tiles a source serves: OpenMapTiles' `building` layer (the
 * prototype's source, and the fallback) or GoWay's per-building city tiles
 * (`lib/map/cityTiles.ts`, meshed by `osmMesher.ts`).
 */
export type CityTileFormat = 'openmaptiles' | 'goway';

export type MeshWorkerRequest =
  | {
      type: 'mesh';
      /** Correlates the reply; unique per engine. */
      id: number;
      tile: TileId;
      /** The tile's absolute URL, already expanded from the source's template. */
      url: string;
      /** OpenMapTiles' building source-layer name. */
      sourceLayer: string;
      /** Absent: `openmaptiles`. */
      format?: CityTileFormat;
      /**
       * The level of detail to mesh (`lodMesher.ts`). GoWay city tiles have
       * only level 0 (`osmMesher.ts`); the engine never asks them for more.
       */
      lod: Lod;
      /** Also place trees, from these source-layers (`trees.ts`); `null`: not wanted. */
      trees: TreeSourceLayers | null;
      /**
       * GoWay city tiles only: the OpenMapTiles tile whose landcover the
       * styling fill reads (the z14 parent of this z15 tile), and the city
       * tile's own tree layer name. Absent: the fill reads this tile.
       */
      treeFill?: { url: string; tile: TileId; mappedLayer: string };
    }
  | { type: 'cancel'; id: number };

export type MeshWorkerResponse =
  | {
      type: 'mesh';
      id: number;
      /** `null`: the tile exists and has nothing to extrude (sea, fields, a 204/404). */
      mesh: PackedMesh | null;
      /** `null`: not asked for, or no wood or park in the tile. */
      trees: TreeInstances | null;
      /** Time spent decoding and meshing, for the dev stats. */
      meshMs: number;
      /** Time spent placing trees. */
      treeMs: number;
    }
  | { type: 'error'; id: number; message: string };
