/**
 * Messages between the street renderer (`streetRenderer.ts`, main thread) and
 * its worker (`streetWorker.ts`), run through the city engine's `WorkerPool`
 * (one worker: it owns the SDF atlas, so there is one packing order).
 *
 * Types only, so both sides import it without pulling in the other's code.
 */
import type { PackedMarkings, PackedSurfaces } from './meshBuffers';
import type { AtlasPatch } from './streetAtlas';
import type { StreetMeshStats } from './streetMesher';

export type StreetWorkerRequest =
  | {
      type: 'mesh';
      id: number;
      /** The z15 tile. */
      x: number;
      y: number;
      /** Absolute `{z}/{x}/{y}` template of the road tiles (`CITY_ROAD_TILE_PATH`). */
      template: string;
      /** Absolute glyph template of the map's style (`{fontstack}`, `{range}`), or `null`: no words. */
      glyphs: string | null;
      fontstack: string;
      groundMeshCells: number;
    }
  | { type: 'cancel'; id: number };

export type StreetWorkerResponse =
  | {
      type: 'mesh';
      id: number;
      /** `null`: no road there (or none drawable). */
      surfaces: PackedSurfaces | null;
      markings: PackedMarkings | null;
      stats: StreetMeshStats | null;
      /** Atlas bytes placed while meshing, to copy before drawing this tile. */
      patches: AtlasPatch[];
      /** The worker instance whose atlas the UVs index: a new one means a fresh atlas. */
      epoch: number;
      meshMs: number;
      /** `[lng, lat]` points along the names this tile paints (`StreetMesh.paintedNames`). */
      paintedNames: [number, number][];
    }
  | { type: 'error'; id: number; message: string }
  | { type: 'cancelled'; id: number };
