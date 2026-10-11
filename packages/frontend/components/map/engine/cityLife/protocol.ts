/**
 * Messages between the city-life renderer (`lifeRenderer.ts`, main thread)
 * and its simulation worker (`simWorker.ts`).
 *
 * Types only, so both sides import it without pulling in the other's code.
 */
import type { LngLatBox } from '../city3d/tileMath';
import type { SimBudget, SimStats } from './sim/simulation';
import type { CarModel } from './sim/traffic';

export type SimWorkerRequest =
  | {
      type: 'init';
      /** `{z}/{x}/{y}` of the road tiles (`CITY_ROAD_TILE_PATH`, absolute). */
      template: string;
      seed: number;
      budget: SimBudget;
    }
  | {
      type: 'view';
      center: { lng: number; lat: number };
      zoom: number;
      bounds: LngLatBox;
    }
  /** Stop stepping (tab hidden, zoomed out, buildings faded) — or start again. */
  | { type: 'pause' }
  | { type: 'resume' };

export interface SimFrameMessage {
  type: 'frame';
  /** When this state is true, as `performance.timeOrigin + performance.now()` (shared by both threads). */
  time: number;
  /** The z15 tile whose north-west corner is the frame's origin (metres east, north). */
  origin: { x: number; y: number };
  /** Per car slot: x, y, heading (radians from east, counter-clockwise), scale (0: not drawn). */
  cars: Float32Array;
  /** Per car slot: paint sRGB and length as a fraction of the model's longest. */
  carStyle: Uint8Array;
  /** The taxis' door colour where the city has a taxi livery (`sim/liveries.ts`), else `null`. */
  taxiDoors: [number, number, number] | null;
  /** Car slot ranges per model, `[start, end)`. */
  ranges: Record<CarModel, [number, number]>;
  people: Float32Array;
  /** Per person: clothes sRGB, and a byte the shader picks skin and gait from. */
  peopleStyle: Uint8Array;
}

export interface SimStatsMessage {
  type: 'stats';
  stats: SimStats;
  network: {
    lanes: number;
    connectors: number;
    signals: number;
    crossings: number;
    pedEdges: number;
    buildMs: number;
  } | null;
  tiles: { wanted: number; loaded: number; failed: number };
}

export type SimWorkerResponse = SimFrameMessage | SimStatsMessage;
