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
import type { IUniform, Scene } from 'three';

import type { CityView } from './cityEngine';
import type { CityLight } from './occlusion';
import type { GroundSampler } from './terrainGround';
import type { MercatorPoint } from './tileMath';

export interface CityOverlayFrame {
  view: CityView;
  /** The camera centre in mercator, float64: what `tileModelMatrix` is relative to. */
  center: MercatorPoint;
  /** The buildings' zoom fade, 0–1. At 0 the engine draws nothing this frame. */
  opacity: number;
}

export interface CityOverlay {
  /** Once, when the engine is created: add objects to its scene. */
  attach(scene: Scene): void;
  /** Every frame the host draws, before the scene renders. */
  update(frame: CityOverlayFrame): void;
  /** The map's light, whenever the buildings' changes. */
  setLight(light: CityLight): void;
  /**
   * The terrain, as the buildings get it (`terrainGround.ts`): metres above
   * sea level at a point, or `null` on a flat map. An overlay stands its
   * objects on it.
   */
  setGround(sample: GroundSampler | null): void;
  /**
   * City sky only, once, before the first frame: the sky's live light
   * inputs, for an overlay that wants more than `setLight` gives it — the
   * sun's shadows on its objects, the same haze, the night factor. Optional:
   * without it an overlay is still lit by the sky through `setLight` (the
   * sun's direction and the light on an up-facing surface), as the trees are.
   */
  setSky?(sky: CityOverlaySky): void;
  /** Free everything; the engine is going away. */
  dispose(): void;
}

/**
 * The city sky's light inputs, for an overlay's own materials (`sky.ts`).
 * `uniforms` are LIVE objects — spread them into a `RawShaderMaterial`'s
 * uniforms and they follow the sun, the shadow map and the night with no
 * further calls; `glsl` declares them and defines, for a fragment shader:
 *
 *  - `float sunVisibility(vec4 shadowClip)` — 1 lit … 0 in shadow (soft);
 *    `shadowClip` is `uShadowMatrix * worldPosition`, where `worldPosition`
 *    is the model matrix applied to the vertex (centre-relative mercator,
 *    exactly what `tileModelMatrix` produces);
 *  - `vec3 hazeTransmittance(float cameraHeightM, float dirZ, float distanceM)`
 *    and `vec3 skyColor(vec3 dirEnu)` — the haze, as the buildings get it;
 *  - the light: `uSunDir` (ENU), `uSunColor`, `uSkyAmbient`, `uGroundBounce`
 *    (linear, exposed), `uNightFactor`, `uCamera` (ENU metres), `uGroundZ`.
 */
export interface CityOverlaySky {
  uniforms: Record<string, IUniform>;
  glsl: string;
}
