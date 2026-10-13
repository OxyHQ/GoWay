/**
 * The city layer's sky, atmosphere, sun shadows and time-of-day light — the
 * three.js half. The model is `atmosphere.ts`, the shadow camera `shadows.ts`,
 * the camera recovery `viewRays.ts`, the TSL `tsl/skyNodes.ts` (light, haze,
 * shadow), `tsl/skyPasses.ts` (the ground passes) and
 * `tsl/skyBuildingMaterial.ts` (the buildings); this module only owns GPU
 * objects and decides when to redraw them. Everything is drawn by the
 * engine's one renderer (`tsl/tslPass.ts`).
 *
 * Reached only through `cityEngine.ts` (so only through
 * `components/engine3d/lazyChunk.ts`), and only when the city-sky flag is on
 * (`lib/map/citySkyFlag.ts`): with it off, `cityEngine` never constructs one
 * and draws exactly what it drew before.
 *
 * ## Inside a map that owns the frame
 *
 * A custom layer gets MapLibre's context and MapLibre's framebuffer, mid-frame,
 * with the basemap already drawn under it. That rules out the post-processing
 * pipeline Procedural Tokyo uses (a composer that renders the scene to its own
 * buffers, then runs an aerial-perspective effect over colour + depth) — there
 * is no scene colour or depth buffer of MapLibre's to read. What it allows:
 *
 *  1. **`prerender`** (MapLibre's offscreen pass, before the main framebuffer
 *     is bound): render the buildings' depth from the sun into this module's
 *     own shadow map. Only when something changed — the sun, the snapped
 *     shadow box, or the set of loaded tiles (`shadows.ts`) — so a still map
 *     or a short pan costs nothing.
 *  2. **`render`**, before the buildings: full-screen passes BLENDED over
 *     the basemap (`tsl/skyPasses.ts`): multiply by light × shadow × haze
 *     transmittance, then add haze in-scatter and, above the horizon, the sky.
 *     Blending is the one thing a layer can do to pixels it did not draw.
 *  3. Then the buildings, with the same light, the shadow map and the same
 *     haze in their own shader.
 *
 * Labels, POIs and overlays are drawn by MapLibre after this layer, so they
 * stay exactly as legible as before: the haze is under them.
 */
import { CITY_NIGHT_SKY, type CityNightSky } from '@/lib/map/style/nightSky';
import {
  Camera,
  ClampToEdgeWrapping,
  DataTexture,
  DepthTexture,
  type Group,
  LessEqualCompare,
  LinearFilter,
  Matrix4,
  RedFormat,
  RenderTarget,
  RGBAFormat,
  type Scene,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
} from 'three/webgpu';

import {
  type CitySun,
  encodeGamma,
  type HostSkyColours,
  hostSkyColours,
  SKY_LUT_HEIGHT,
  SKY_LUT_WIDTH,
  type SkyAppearance,
  type SkyState,
  skyStateFor,
  sunDirection,
} from './atmosphere';
import { castersKey, type DrawnTile, SHADOW_CASTER_LAYER } from './frameSelection';
import {
  castsInto,
  type ShadowFrame,
  shadowFrame,
  shadowMatrixForCentre,
  shadowMatrixForEnu,
  shadowRadiusForView,
} from './shadows';
import { type LngLatBox, mercatorPerMetre } from './tileMath';
import type { UniformRef } from './tsl/common';
import { createSkyNodes, type SkyNodes, type SkyUniformRefs } from './tsl/skyNodes';
import { createSkyPasses, type SkyPassUniformRefs } from './tsl/skyPasses';
import type { TslPass } from './tsl/tslPass';
import { viewRays } from './viewRays';

/**
 * The sky effect fades in over these zooms; below, the map is left alone.
 *
 * It is a CITY-scale effect: the light, the shadows and the haze of streets.
 * Below z12 the view spans tens of kilometres, the sun over its centre stops
 * describing its edges, and the relief prototype's globe projection
 * (`docs/MAP_TERRAIN_GLOBE.md`) may be easing in — under which the flat-ground
 * rays `viewRays.ts` reconstructs are not the drawn surface. The relief
 * layer's own MapLibre sky covers those zooms.
 */
export const EFFECT_ZOOM: readonly [number, number] = [12, 13];

/**
 * While only the set of shadow casters changes (the box and the sun do not),
 * the shadow map is redrawn at most this often, ms; it catches up once the
 * camera rests.
 */
export const SHADOW_CASTER_REDRAW_MS = 250;

export interface CitySkyView {
  /** Centre-relative mercator → clip (`tileMath.centeredProjection`), float64. */
  projection: ArrayLike<number>;
  /** The map centre, mercator `[0, 1]`. */
  center: { x: number; y: number };
  centerLngLat: { lng: number; lat: number };
  bounds: LngLatBox;
  zoom: number;
  /** The buildings' zoom fade, 0…1: shadows fade with the meshes that cast them. */
  opacity: number;
  /**
   * The drawn ground's elevation near the centre, metres (0 without 3D
   * terrain): the plane the basemap passes put the ground on, and the base of
   * the shadow box. A plane is the honest approximation a blend pass can make
   * — it cannot read the terrain's depth — and holds over a city's gentle
   * slopes; on a steep one the basemap's shadows drift (the buildings' own
   * shadows are exact: they are lifted with the buildings).
   */
  groundM: number;
}

export interface CitySkyStats {
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
  /** Shadow-map redraws since start, and the last one's cost on this thread. */
  shadowRenders: number;
  lastShadowMs: number;
  /** Last sky-table computation on this thread (0 when it was cached). */
  lastSkyMs: number;
  shadowTexelM: number;
  /** The camera's height above the ground, metres, as read back from the projection. */
  cameraHeightM: number;
  /** The shadow strength the last frame drew with (0: no shadow map in force). */
  shadowStrength: number;
  /** The ground plane's elevation the last frame used, metres (`CitySkyView.groundM`). */
  groundM: number;
}

export interface CitySky {
  /**
   * The sky's light inputs as TSL nodes (`tsl/skyNodes.ts`): what the
   * sky-lit buildings are built with (`tsl/skyBuildingMaterial.ts`) and what
   * an overlay gets (`overlay.ts` → `setSky`). Live: they follow the sun, the
   * shadow map and the night with no further calls.
   */
  readonly nodes: SkyNodes;
  /**
   * What the MapLibre-style light the engine still uses elsewhere (the trees)
   * should be for this sky: the sun's direction and the light on an up-facing
   * surface, as `CityLight`'s position and colour. `null` until a sun is set.
   */
  readonly hostLight: {
    position: [number, number, number];
    color: [number, number, number];
  } | null;
  /** The host map's own sky colours for the current sun (`hostSkyColours`), or `null` before one. */
  readonly hostSky: HostSkyColours | null;
  setSun(sun: CitySun): void;
  /**
   * MapLibre's offscreen pass: redraw the shadow map if it is stale — the
   * sun, the snapped box, or the tiles that can cast into it changed. Only
   * the buildings in `scene` cast (`frameSelection.ts` → `SHADOW_CASTER_LAYER`).
   */
  prerender(
    pass: TslPass,
    scene: Scene,
    view: CitySkyView,
    casters: { tiles: readonly DrawnTile[]; groundEpoch: number },
  ): void;
  /**
   * The ground light, haze and sky passes (`tsl/skyPasses.ts`), for the
   * engine to add to its scene: they draw first in the same render as the
   * buildings, on `SKY_PASS_LAYER`, while the effect is on.
   */
  readonly passes: Group;
  /**
   * Every frame, before the scene is drawn: the camera, the ground and the
   * shadow box the passes and sky-lit materials read, and whether the passes
   * show at this zoom. Returns whether they do.
   */
  update(pass: TslPass, view: CitySkyView): boolean;
  readonly stats: CitySkyStats;
  dispose(): void;
}

export function createCitySky(options: {
  appearance: SkyAppearance;
  /** The style's night (`CityEngineOptions.sky.nightSky`); Standard's when absent. */
  nightSky?: CityNightSky;
  /**
   * The sun's shadows at this quality (`engine/quality.ts`): the map's side
   * and the PCF taps, or `null` for none — then no shadow map is allocated,
   * no shadow pass drawn, and no shader samples one.
   */
  shadows: { mapSize: number; taps: number } | null;
  /** The engine's clock (`CityEngineOptions.now`): the redraw throttle reads it. */
  now?: () => number;
  /** The engine's night seam (`CityEngine.setNightFactor`), read by every night look. */
  nightFactor: UniformRef<number>;
  /** Ask the host for a frame. */
  requestRepaint: () => void;
}): CitySky {
  const lutTexture = new DataTexture(
    new Uint8Array(SKY_LUT_WIDTH * SKY_LUT_HEIGHT * 4),
    SKY_LUT_WIDTH,
    SKY_LUT_HEIGHT,
    RGBAFormat,
    UnsignedByteType,
  );
  lutTexture.magFilter = LinearFilter;
  lutTexture.minFilter = LinearFilter;
  lutTexture.wrapS = ClampToEdgeWrapping;
  lutTexture.wrapT = ClampToEdgeWrapping;
  lutTexture.generateMipmaps = false;
  lutTexture.needsUpdate = true;

  const shadowSize = options.shadows?.mapSize ?? 0;
  const shadowTaps = options.shadows ? options.shadows.taps : 0;
  let depthTexture: DepthTexture | null = null;
  let shadowTarget: RenderTarget | null = null;
  if (options.shadows) {
    depthTexture = new DepthTexture(shadowSize, shadowSize);
    depthTexture.type = UnsignedIntType;
    depthTexture.compareFunction = LessEqualCompare;
    depthTexture.magFilter = LinearFilter;
    depthTexture.minFilter = LinearFilter;
    // The colour attachment is never read; one byte a texel is the least three
    // will make.
    shadowTarget = new RenderTarget(shadowSize, shadowSize, {
      format: RedFormat,
      type: UnsignedByteType,
      depthBuffer: true,
      depthTexture,
      generateMipmaps: false,
    });
  }

  const refs = {
    uSkyLut: { value: lutTexture },
    uSunAzimuth: { value: 0 },
    uShadowMap: { value: depthTexture },
    uShadowStrength: { value: 0 },
    uShadowTexel: {
      value: new Vector2(1 / Math.max(1, shadowSize), 1 / Math.max(1, shadowSize)),
    },
    uShadowBias: { value: 0 },
    uGroundZ: { value: 0 },
    uCamera: { value: new Vector3(0, 0, 1000) },
    uSunDir: { value: new Vector3(0, 0, 1) },
    uSunColor: { value: new Vector3(1, 1, 1) },
    uSkyAmbient: { value: new Vector3(0.2, 0.2, 0.2) },
    uGroundBounce: { value: new Vector3(0.05, 0.05, 0.05) },
    uStreetGlow: { value: new Vector3() },
    uFloodlight: { value: new Vector3(...(options.nightSky ?? CITY_NIGHT_SKY).floodlight) },
    uShadowMatrix: { value: new Matrix4() },
    uMetresPerMercator: { value: 1 },
    uShadowNormalOffset: { value: 1 },
    uNightFactor: options.nightFactor,
  } satisfies SkyUniformRefs;
  const nodes = createSkyNodes(refs, shadowTaps);

  const passRefs = {
    uCorners: { value: [0, 1, 2, 3].map(() => new Vector3()) },
    uShadowEnu: { value: new Matrix4() },
    uSunDisc: { value: new Vector3() },
    uEffect: { value: 0 },
  } satisfies SkyPassUniformRefs;
  const passes = createSkyPasses(nodes, passRefs);

  const shadowCamera = new Camera();
  // Only the buildings cast (`frameSelection.ts` → `SHADOW_CASTER_LAYER`).
  shadowCamera.layers.set(SHADOW_CASTER_LAYER);

  let hostLight: CitySky['hostLight'] = null;
  let hostSky: HostSkyColours | null = null;
  let sun: CitySun | null = null;
  let state: SkyState | null = null;
  let frame: ShadowFrame | null = null;
  const clock = options.now ?? (() => performance.now());
  let renderedKey = '';
  let lastShadowAt = Number.NEGATIVE_INFINITY;
  let catchUp: ReturnType<typeof setTimeout> | null = null;
  let targetReady = false;
  let disposed = false;

  const stats: CitySkyStats = {
    sunAzimuthDeg: 0,
    sunAltitudeDeg: 0,
    shadowRenders: 0,
    lastShadowMs: 0,
    lastSkyMs: 0,
    shadowTexelM: 0,
    cameraHeightM: 0,
    shadowStrength: 0,
    groundM: 0,
  };

  /**
   * The shadow map must exist before any program samples it — at night none
   * is ever drawn — so its attachments are allocated, once, before the first
   * draw that could read them.
   */
  const ensureTarget = (pass: TslPass) => {
    if (targetReady || !shadowTarget) return;
    targetReady = pass.initTarget(shadowTarget);
  };

  const applyState = (next: SkyState) => {
    state = next;
    (lutTexture.image.data as Uint8Array).set(next.lut);
    lutTexture.needsUpdate = true;
    refs.uSunColor.value.set(...next.sunColor);
    refs.uSkyAmbient.value.set(...next.skyAmbient);
    hostSky = hostSkyColours(next.lut);
    refs.uGroundBounce.value.set(...next.groundBounce);
    refs.uStreetGlow.value.set(...next.streetGlow);
    passRefs.uSunDisc.value.set(...next.sunDisc);
  };

  const sky: CitySky = {
    nodes,
    passes: passes.group,
    get hostLight() {
      return hostLight;
    },
    get hostSky() {
      return hostSky;
    },
    stats,

    setSun(next) {
      if (disposed) return;
      if (sun && sun.azimuthDeg === next.azimuthDeg && sun.altitudeDeg === next.altitudeDeg) return;
      sun = next;
      const started = performance.now();
      const nextState = skyStateFor(next.altitudeDeg, options.appearance, options.nightSky);
      stats.lastSkyMs = nextState === state ? 0 : performance.now() - started;
      if (nextState !== state) applyState(nextState);
      const direction = sunDirection(next);
      refs.uSunDir.value.set(...direction);
      refs.uSunAzimuth.value = (next.azimuthDeg * Math.PI) / 180;
      // The same light for what the engine still lights MapLibre's way (the
      // trees): from the real sun while it is up (overhead at night, when
      // only the colour matters), coloured by the light on the ground — the
      // ground pass's own multiplier — so a tree darkens and cools at night
      // with the street it stands in.
      const up = Math.max(direction[2], 0);
      const lit = (nextState.sunColor as number[]).map((v, c) => v * up + nextState.skyAmbient[c]);
      hostLight = {
        position:
          up > 0 ? (direction.map((v) => v * 1.15) as [number, number, number]) : [0, 0, 1.15],
        color: lit.map((v) => Math.min(1, encodeGamma(v))) as [number, number, number],
      };
      stats.sunAzimuthDeg = next.azimuthDeg;
      stats.sunAltitudeDeg = next.altitudeDeg;
      options.requestRepaint();
    },

    prerender(pass, scene, view, casters) {
      if (disposed || !sun || !state || !shadowTarget) return;
      ensureTarget(pass);
      frame =
        state.shadowStrength > 0 && view.opacity > 0
          ? shadowFrame({
              sun,
              center: view.centerLngLat,
              radiusM: shadowRadiusForView(view.bounds, view.centerLngLat),
              groundM: view.groundM,
              mapSize: shadowSize,
            })
          : null;
      if (!frame) {
        renderedKey = '';
        return;
      }
      const shadow = frame;
      const casting = casters.tiles.filter((t) => castsInto(shadow, t.tile, t.wrap, view.groundM));
      const castersPart = castersKey(casting, casters.groundEpoch);
      const key = `${frame.key}|${castersPart}`;
      if (key === renderedKey) return;
      const started = clock();
      // Same box, same sun, only the casters changed (a tile came into view
      // or finished loading while the camera moves): redraw at most every
      // SHADOW_CASTER_REDRAW_MS, and catch up once the wait is over. An orbit
      // used to redraw the whole city's depth from the sun on most frames;
      // the matrix is unchanged, so the map drawn a moment ago is exact for
      // every building it holds (`docs/MAP_PERFORMANCE.md` → hotspots).
      if (renderedKey.startsWith(`${frame.key}|`)) {
        const wait = lastShadowAt + SHADOW_CASTER_REDRAW_MS - started;
        if (wait > 0) {
          if (!catchUp) {
            catchUp = setTimeout(() => {
              catchUp = null;
              if (!disposed) options.requestRepaint();
            }, wait);
          }
          return;
        }
      }
      shadowCamera.projectionMatrix.fromArray(shadowMatrixForCentre(frame, view.center));
      shadowCamera.projectionMatrixInverse.copy(shadowCamera.projectionMatrix).invert();
      if (!pass.drawOffscreen(scene, shadowCamera, shadowTarget, pass.caster)) return;
      renderedKey = key;
      lastShadowAt = started;
      stats.shadowRenders++;
      stats.lastShadowMs = clock() - started;
      stats.shadowTexelM = frame.texelM;
    },

    update(pass, view) {
      passes.group.visible = false;
      if (disposed || !sun || !state) return false;
      // A host that skipped the offscreen pass must not leave every program
      // with a shadow sampler reading a texture that was never allocated.
      ensureTarget(pass);
      const effect = Math.max(
        0,
        Math.min(1, (view.zoom - EFFECT_ZOOM[0]) / (EFFECT_ZOOM[1] - EFFECT_ZOOM[0])),
      );
      const metresPerMercator = 1 / mercatorPerMetre(view.centerLngLat.lat);
      const rays = viewRays(view.projection, metresPerMercator);
      if (!rays) return false;

      refs.uCamera.value.set(...rays.camera);
      refs.uGroundZ.value = view.groundM;
      stats.groundM = view.groundM;
      stats.cameraHeightM = rays.camera[2];
      rays.corners.forEach((corner, i) => {
        passRefs.uCorners.value[i].set(...corner);
      });
      passRefs.uEffect.value = effect;

      if (frame) {
        refs.uShadowStrength.value = state.shadowStrength * view.opacity;
        refs.uShadowBias.value = frame.depthPerMetre * frame.texelM * 1.5;
        passRefs.uShadowEnu.value.fromArray(
          shadowMatrixForEnu(frame, view.center, 1 / metresPerMercator),
        );
        refs.uShadowMatrix.value.fromArray(shadowMatrixForCentre(frame, view.center));
        refs.uShadowNormalOffset.value = frame.texelM;
      } else {
        refs.uShadowStrength.value = 0;
      }
      stats.shadowStrength = refs.uShadowStrength.value;
      refs.uMetresPerMercator.value = metresPerMercator;

      passes.group.visible = effect > 0;
      return passes.group.visible;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (catchUp) clearTimeout(catchUp);
      catchUp = null;
      lutTexture.dispose();
      depthTexture?.dispose();
      shadowTarget?.dispose();
      passes.dispose();
    },
  };
  return sky;
}
