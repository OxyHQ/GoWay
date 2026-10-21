/**
 * The messages between the city-3D engine and its mesh Web Workers.
 *
 * Types only — nothing here exists at runtime — so both sides can import it
 * without either pulling the other's dependencies into its bundle.
 */
import type { SurfaceMesh, VolumeIndex, VolumeLimits } from '../camera/volumes';
import type { Lod } from './lod';
import type { PackedMesh } from './packing';
import type { TreeSettingCounts } from './treeContext';
import type { TreeSourceLayers } from './treeSources';
import type { TreeInstances } from './trees';
import type { TileId } from './tileMath';

/**
 * Which tiles a source serves: OpenMapTiles' `building` layer (the
 * prototype's source, and the fallback) or GoWay's per-building city tiles
 * (`lib/map/cityTiles.ts`, meshed by `osmMesher.ts`).
 */
export type CityTileFormat = 'openmaptiles' | 'goway';

/**
 * What surrounds a city tile's mapped trees: the OpenMapTiles tile whose areas
 * set a tree's setting and whose landcover the styling fill reads (`url`,
 * `tile`: the z14 parent of this z15 tile); the road archive's tile at this
 * tile's address (`roadsUrl`) and its eight neighbours' (`roadNeighbours`,
 * read only where a tree stands near that edge, `workerTrees.ts` →
 * `treeTilesFor`) — both absent where none is published, or beyond the
 * profile's `city.treeRoadTiles` nearest tiles; and the city tile's own tree
 * layer name.
 */
export interface TreeContextTiles {
  url: string;
  tile: TileId;
  roadsUrl?: string;
  roadNeighbours?: readonly { tile: TileId; url: string }[];
  mappedLayer: string;
}

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
       * GoWay city tiles only: what surrounds the trees OSM records
       * (`treeContext.ts`). Absent: the fill reads this tile.
       */
      treeContext?: TreeContextTiles;
      /**
       * City-tile feature ids (`osmId × 10 + 2|3`) NOT to mesh: buildings a
       * drawn landmark model replaces (`docs/MAP_LANDMARKS.md`). Only the
       * `goway` format has per-building ids; ignored for `openmaptiles`.
       */
      hidden?: readonly number[];
      /**
       * What the camera's volume index of this tile may hold (the quality
       * profile's `camera`, `camera/volumes.ts`). Absent: no limit.
       */
      volumes?: VolumeLimits;
    }
  /**
   * The trees of a city tile already drawn, read again without meshing its
   * buildings: when its first answer was incomplete (a context tile failed
   * to fetch), or it was read without the road archive and is now among the
   * profile's nearest tiles. Answered with one `trees` reply.
   */
  | {
      type: 'trees';
      id: number;
      tile: TileId;
      url: string;
      trees: TreeSourceLayers;
      treeFillWoods?: boolean;
      treeContext: TreeContextTiles;
    }
  /**
   * Measure a landmark's columns for the camera (`camera/volumes.ts` →
   * `surfaceVolumes`) off the main thread: its triangles in its own metres.
   */
  | { type: 'volumes'; id: number; meshes: SurfaceMesh[]; cellM: number }
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
      /** Where the mapped trees went (`treeContext.ts`); absent: none, or not asked. */
      treeSettings?: TreeSettingCounts;
      /**
       * `false`: a source the trees needed could not be fetched (not merely
       * absent); the engine draws this and asks again later.
       */
      treesComplete: boolean;
      /**
       * `true`: the trees were not ready (the tiles they are read against
       * were still downloading), so the buildings came first and the trees
       * follow in a `trees` reply to the same id — buildings never wait on
       * trees. `trees` is then `null`.
       */
      more?: true;
      /**
       * Official 3D datasets (`CITY_LOD2_SOURCES` ids) whose surfaces are in
       * this mesh, so the map can credit each exactly while it is drawn.
       * Absent: none.
       */
      sources?: string[];
    }
  /** A tile's trees: after a `mesh` reply with `more`, or for a `trees` request. */
  | {
      type: 'trees';
      id: number;
      trees: TreeInstances | null;
      treeMs: number;
      treeSettings?: TreeSettingCounts;
      treesComplete: boolean;
    }
  | { type: 'volumes'; id: number; volumes: VolumeIndex | null }
  | { type: 'error'; id: number; message: string }
  /** A cancel took effect: the request will not be answered (`workerPool.ts`). */
  | { type: 'cancelled'; id: number };
