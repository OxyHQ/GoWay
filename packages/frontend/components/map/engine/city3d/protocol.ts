/**
 * The messages between the city-3D engine and its mesh Web Worker.
 *
 * Types only — nothing here exists at runtime — so both sides can import it
 * without either pulling the other's dependencies into its bundle.
 */
import type { TileMesh } from './mesher';
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
    }
  | { type: 'cancel'; id: number };

export type MeshWorkerResponse =
  | {
      type: 'mesh';
      id: number;
      /** `null`: the tile exists and has nothing to extrude (sea, fields, a 204/404). */
      mesh: TileMesh | null;
      /** Time spent decoding and meshing, for the dev stats. */
      meshMs: number;
    }
  | { type: 'error'; id: number; message: string };
