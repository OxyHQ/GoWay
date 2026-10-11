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
      /**
       * Trees (`workerTrees.ts`): the ones OSM records, from a city tile; with
       * these source-layers for the optional fill. `null`: no trees.
       */
      trees: TreeSourceLayers | null;
      /** Also stand the styling fill in mapped woods (off unless asked; `trees.ts`). */
      treeFillWoods?: boolean;
      /**
       * GoWay city tiles only: the OpenMapTiles tile whose landcover the
       * styling fill reads (the z14 parent of this z15 tile), and the city
       * tile's own tree layer name. Absent: the fill reads this tile.
       */
      treeFill?: { url: string; tile: TileId; mappedLayer: string };
      /**
       * City-tile feature ids (`osmId × 10 + 2|3`) NOT to mesh: buildings a
       * drawn landmark model replaces (`docs/MAP_LANDMARKS.md`). Only the
       * `goway` format has per-building ids; ignored for `openmaptiles`.
       */
      hidden?: readonly number[];
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
      /**
       * `false`: a source the trees needed could not be fetched (not merely
       * absent); the engine draws this and asks again later.
       */
      treesComplete: boolean;
      /**
       * Official 3D datasets (`CITY_LOD2_SOURCES` ids) whose surfaces are in
       * this mesh, so the map can credit each exactly while it is drawn.
       * Absent: none.
       */
      sources?: string[];
    }
  | { type: 'error'; id: number; message: string }
  /** A cancel took effect: the request will not be answered (`workerPool.ts`). */
  | { type: 'cancelled'; id: number };
