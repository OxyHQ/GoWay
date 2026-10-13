/**
 * Something drawn in the city-3D scene beside the buildings — the city-life
 * simulation (`engine/cityLife/`), and whatever else wants the same camera,
 * depth buffer and light without a second renderer (`docs/MAP_3D_CITY.md` →
 * "One engine, one scene").
 *
 * Types only. An overlay is created by the adapter (through the lazy engine
 * chunk) and handed to `createCityEngine`, which calls it at fixed points of
 * its frame; it never reaches into the engine.
 */
import type { Scene } from 'three/webgpu';

import type { CityView } from './cityEngine';
import type { CityLight } from './occlusion';
import type { Ground } from './terrainGround';
import type { MercatorPoint } from './tileMath';
import type { SkyNodes } from './tsl/skyNodes';

/**
 * One frame's budget of bytes handed to the GPU, shared by the city's
 * arrivals and its overlays: the profile's `uploadBytesPerFrame`
 * (`lib/map/quality/profile.ts`), or none in a slow frame while the map
 * moves. The first upload of a frame always fits, so one item larger than
 * the budget still goes up, alone.
 */
export interface FrameUploadBudget {
  /** Whether `bytes` may go to the GPU this frame; if they may, they are counted. */
  take(bytes: number): boolean;
}

export interface CityOverlayFrame {
  view: CityView;
  /** The camera centre in mercator, float64: what `tileModelMatrix` is relative to. */
  center: MercatorPoint;
  /** The buildings' zoom fade, 0–1. At 0 the engine draws nothing this frame. */
  opacity: number;
  /**
   * What is left of this frame's upload budget once the city's own arrivals
   * are in. An overlay that hands the GPU new geometry or textures after
   * `attach` takes them from it, and holds what does not fit for a later
   * frame (counting it as pending).
   */
  upload: FrameUploadBudget;
}

export interface CityOverlay {
  /**
   * Once, when the engine is created: add objects to its scene, drawn by the
   * engine's one renderer (`tsl/tslPass.ts`) with TSL node materials. Same
   * camera, same depth buffer; `docs/MAP_NATIVE_3D.md` → Phase 2.
   */
  attach(scene: Scene): void;
  /** Every frame the host draws, before the scene renders. */
  update(frame: CityOverlayFrame): void;
  /** The map's light, whenever the buildings' changes. */
  setLight(light: CityLight): void;
  /**
   * The terrain, as the buildings get it (`terrainGround.ts` → `Ground`): its
   * sampler and the SAME per-tile grids the buildings stand on (one cache,
   * shared), or `null` on a flat map. An overlay stands its objects on it.
   */
  setGround(ground: Ground | null): void;
  /**
   * City sky only, once, before the first frame: the sky's live light
   * inputs, for an overlay that wants more than `setLight` gives it — the
   * sun's shadows on its objects, the same haze, the night factor. Optional:
   * without it an overlay is still lit by the sky through `setLight` (the
   * sun's direction and the light on an up-facing surface), as the trees are.
   */
  setSky?(sky: CityOverlaySky): void;
  /**
   * How much of a night to draw (0 … 1, `lib/map/landmarks/night.ts`), whenever
   * the engine's changes and once at creation. Optional; under the city sky the
   * same value also arrives as {@link SkyNodes.nightFactor}.
   */
  setNightFactor?(nightFactor: number): void;
  /** Free everything; the engine is going away. */
  dispose(): void;
}

/**
 * The city sky's light inputs, for an overlay's own materials: the sky's TSL
 * nodes (`tsl/skyNodes.ts`), LIVE — they follow the sun, the shadow map and
 * the night with no further calls. Among them `sunVisibility(shadowClip)`
 * (`shadowClip` is `shadowMatrix × world`, where `world` is the model matrix
 * applied to the vertex — centre-relative mercator, exactly what
 * `tileModelMatrix` produces), `hazeTransmittance`, `skyColor`, `aerial`,
 * `groundLight`, and the light: `sunDir` (ENU), `sunColor`, `skyAmbient`,
 * `groundBounce` (linear, exposed), `nightFactor`, `camera` (ENU metres),
 * `groundZ`.
 */
export type CityOverlaySky = SkyNodes;
