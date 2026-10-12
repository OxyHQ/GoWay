/**
 * The city layer's sky, atmosphere, sun shadows and time-of-day light — the
 * three.js half. The model is `atmosphere.ts`, the shadow camera `shadows.ts`,
 * the camera recovery `viewRays.ts`, the GLSL `skyShaders.ts`; this module
 * only owns GPU objects and decides when to redraw them.
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
 *     the basemap (`skyShaders.ts`): multiply by light × shadow × haze
 *     transmittance, then add haze in-scatter and, above the horizon, the sky.
 *     Blending is the one thing a layer can do to pixels it did not draw.
 *  3. Then the buildings, with the same light, the shadow map and the same
 *     haze in their own shader.
 *
 * Labels, POIs and overlays are drawn by MapLibre after this layer, so they
 * stay exactly as legible as before: the haze is under them.
 */
import * as THREE from 'three';

import {
  type CitySun,
  SKY_LUT_HEIGHT,
  SKY_LUT_WIDTH,
  type SkyAppearance,
  encodeGamma,
  type HostSkyColours,
  hostSkyColours,
  type SkyState,
  skyStateFor,
  sunDirection,
} from './atmosphere';
import {
  SHADOW_CASTER_FRAGMENT_SHADER,
  SHADOW_CASTER_VERTEX_SHADER,
  SKY_PASS_VERTEX_SHADER,
  skyCityFragmentShader,
  skyCityVertexShader,
  skyOverlayGlsl,
  skyPassFragmentShader,
} from './skyShaders';
import { castersKey, type DrawnTile, SHADOW_CASTER_LAYER } from './frameSelection';
import type { CityOverlaySky } from './overlay';
import type { CityTileFormat } from './protocol';
import {
  castsInto,
  type ShadowFrame,
  shadowFrame,
  shadowMatrixForCentre,
  shadowMatrixForEnu,
  shadowRadiusForView,
} from './shadows';
import { type LngLatBox, mercatorPerMetre } from './tileMath';
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
   * The sky-lit building shaders, by tile format, for the engine to build its
   * per-tile materials with (`cityMeshes.ts`) instead of its own — ONE shading
   * path (`skyShaders.ts` → the contract).
   */
  readonly buildingShaders: Record<
    CityTileFormat,
    { vertexShader: string; fragmentShader: string }
  >;
  /** The uniforms those shaders need beyond the engine's own; live, shared objects. */
  readonly buildingUniforms: Record<string, THREE.IUniform>;
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
  /** What an overlay gets (`overlay.ts` → `setSky`): live uniforms and the GLSL that reads them. */
  readonly overlayInput: CityOverlaySky;
  setSun(sun: CitySun): void;
  /**
   * MapLibre's offscreen pass: redraw the shadow map if it is stale — the
   * sun, the snapped box, or the tiles that can cast into it changed.
   */
  prerender(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    view: CitySkyView,
    casters: { tiles: readonly DrawnTile[]; groundEpoch: number },
  ): void;
  /** Before the buildings, in the map's own framebuffer: ground light, haze, sky. */
  drawBackground(renderer: THREE.WebGLRenderer, view: CitySkyView): void;
  readonly stats: CitySkyStats;
  dispose(): void;
}

/**
 * The building material's uniforms that `cityEngine` owns (palette, opacity,
 * terrain); the sky adds its own beside them, sharing the objects.
 */
export type CityBaseUniforms = Record<string, THREE.IUniform>;

export function createCitySky(options: {
  appearance: SkyAppearance;
  /**
   * The material response, a GLSL chunk defining `cityMaterial(CitySurface,
   * CityLight)` (`skyShaders.ts` → the contract). Absent: the default clay.
   */
  material?: string;
  /**
   * The sun's shadows at this quality (`engine/quality.ts`): the map's side
   * and the PCF taps, or `null` for none — then no shadow map is allocated,
   * no shadow pass drawn, and no shader samples one.
   */
  shadows: { mapSize: number; taps: number } | null;
  /** The engine's clock (`CityEngineOptions.now`): the redraw throttle reads it. */
  now?: () => number;
  baseUniforms: CityBaseUniforms;
  /** Ask the host for a frame. */
  requestRepaint: () => void;
}): CitySky {
  const lutTexture = new THREE.DataTexture(
    new Uint8Array(SKY_LUT_WIDTH * SKY_LUT_HEIGHT * 4),
    SKY_LUT_WIDTH,
    SKY_LUT_HEIGHT,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  lutTexture.magFilter = THREE.LinearFilter;
  lutTexture.minFilter = THREE.LinearFilter;
  lutTexture.wrapS = THREE.ClampToEdgeWrapping;
  lutTexture.wrapT = THREE.ClampToEdgeWrapping;
  lutTexture.generateMipmaps = false;

  const shadowSize = options.shadows?.mapSize ?? 0;
  const shadowTaps = options.shadows ? options.shadows.taps : 0;
  let depthTexture: THREE.DepthTexture | null = null;
  let shadowTarget: THREE.WebGLRenderTarget | null = null;
  if (options.shadows) {
    depthTexture = new THREE.DepthTexture(shadowSize, shadowSize);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.compareFunction = THREE.LessEqualCompare;
    depthTexture.magFilter = THREE.LinearFilter;
    depthTexture.minFilter = THREE.LinearFilter;
    // The colour attachment is never read; one byte a texel is the least three
    // will make.
    shadowTarget = new THREE.WebGLRenderTarget(shadowSize, shadowSize, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      depthTexture,
      generateMipmaps: false,
    });
  }

  const shared = {
    uSkyLut: { value: lutTexture },
    uSunAzimuth: { value: 0 },
    uShadowMap: { value: depthTexture },
    uShadowStrength: { value: 0 },
    uShadowTexel: {
      value: new THREE.Vector2(1 / Math.max(1, shadowSize), 1 / Math.max(1, shadowSize)),
    },
    uShadowBias: { value: 0 },
    uCamera: { value: new THREE.Vector3(0, 0, 1000) },
    uSunDir: { value: new THREE.Vector3(0, 0, 1) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uSkyAmbient: { value: new THREE.Vector3(0.2, 0.2, 0.2) },
    // The ground plane's elevation, metres (`CitySkyView.groundM`).
    uGroundZ: { value: 0 },
  };

  const buildingUniforms: Record<string, THREE.IUniform> = {
    ...shared,
    uGroundBounce: { value: new THREE.Vector3(0.05, 0.05, 0.05) },
    uStreetGlow: { value: new THREE.Vector3() },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uMetresPerMercator: { value: 1 },
    uShadowNormalOffset: { value: 1 },
  };
  const buildingShaders = {
    openmaptiles: {
      vertexShader: skyCityVertexShader('openmaptiles'),
      fragmentShader: skyCityFragmentShader('openmaptiles', options.material, shadowTaps),
    },
    goway: {
      vertexShader: skyCityVertexShader('goway'),
      fragmentShader: skyCityFragmentShader('goway', options.material, shadowTaps),
    },
  };
  let hostLight: CitySky['hostLight'] = null;
  let hostSky: HostSkyColours | null = null;
  const overlayInput: CityOverlaySky = {
    uniforms: {
      ...buildingUniforms,
      ...(options.baseUniforms.uNightFactor
        ? { uNightFactor: options.baseUniforms.uNightFactor }
        : {}),
    },
    glsl: skyOverlayGlsl(shadowTaps),
  };

  const passUniforms = {
    ...shared,
    uCorners: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
    uShadowEnu: { value: new THREE.Matrix4() },
    uSunDisc: { value: new THREE.Vector3() },
    uEffect: { value: 0 },
  };
  const passMaterial = (pass: 'fill' | 'multiply' | 'add') =>
    new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SKY_PASS_VERTEX_SHADER,
      fragmentShader: skyPassFragmentShader(pass, shadowTaps),
      uniforms: passUniforms,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      ...(pass === 'fill'
        ? {
            // src × (1 − dst alpha) + dst: only where nothing was drawn.
            blendSrc: THREE.OneMinusDstAlphaFactor,
            blendDst: THREE.OneFactor,
            blendSrcAlpha: THREE.OneMinusDstAlphaFactor,
            blendDstAlpha: THREE.OneFactor,
          }
        : pass === 'multiply'
          ? {
              // dst × src (alpha kept: src alpha is 1)
              blendSrc: THREE.ZeroFactor,
              blendDst: THREE.SrcColorFactor,
              blendSrcAlpha: THREE.ZeroFactor,
              blendDstAlpha: THREE.OneFactor,
            }
          : {
              // dst + src; the sky makes the pixel opaque even where the
              // basemap left it transparent.
              blendSrc: THREE.OneFactor,
              blendDst: THREE.OneFactor,
              blendSrcAlpha: THREE.OneFactor,
              blendDstAlpha: THREE.OneFactor,
            }),
    });
  const quad = new THREE.BufferGeometry();
  quad.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3),
  );
  quad.setIndex([0, 1, 2, 2, 1, 3]);
  const skyScene = new THREE.Scene();
  const passes = (['fill', 'multiply', 'add'] as const).map(
    (pass) => new THREE.Mesh(quad, passMaterial(pass)),
  );
  for (const [i, mesh] of passes.entries()) {
    mesh.frustumCulled = false;
    mesh.renderOrder = i;
    skyScene.add(mesh);
  }
  const passCamera = new THREE.Camera();

  const casterMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SHADOW_CASTER_VERTEX_SHADER,
    fragmentShader: SHADOW_CASTER_FRAGMENT_SHADER,
    // The engine's own uniform object: buildings cast from where terrain put them.
    uniforms: { uGrounded: options.baseUniforms.uGrounded ?? { value: 0 } },
    // Both faces: the mirrored model matrices make "front" ambiguous (see
    // `cityEngine`), and a closed solid casts the same shadow either way.
    side: THREE.DoubleSide,
  });
  const shadowCamera = new THREE.Camera();
  // Only the buildings cast (`frameSelection.ts` → `SHADOW_CASTER_LAYER`).
  shadowCamera.layers.set(SHADOW_CASTER_LAYER);

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

  const applyState = (next: SkyState) => {
    state = next;
    (lutTexture.image.data as Uint8Array).set(next.lut);
    lutTexture.needsUpdate = true;
    shared.uSunColor.value.set(...next.sunColor);
    shared.uSkyAmbient.value.set(...next.skyAmbient);
    hostSky = hostSkyColours(next.lut);
    buildingUniforms.uGroundBounce.value.set(...next.groundBounce);
    buildingUniforms.uStreetGlow.value.set(...next.streetGlow);
    passUniforms.uSunDisc.value.set(...next.sunDisc);
  };

  const sky: CitySky = {
    buildingShaders,
    buildingUniforms,
    overlayInput,
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
      const nextState = skyStateFor(next.altitudeDeg, options.appearance);
      stats.lastSkyMs = nextState === state ? 0 : performance.now() - started;
      if (nextState !== state) applyState(nextState);
      const direction = sunDirection(next);
      shared.uSunDir.value.set(...direction);
      shared.uSunAzimuth.value = (next.azimuthDeg * Math.PI) / 180;
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

    prerender(renderer, scene, view, casters) {
      if (disposed || !sun || !state || !shadowTarget) return;
      if (!targetReady) {
        // Every program that DECLARES the shadow sampler fails to draw while
        // its depth texture has never been allocated with compare mode on —
        // whether it reads it or not (WebGL: INVALID_OPERATION). At night no
        // shadow is ever rendered, so the target is allocated, once, here.
        renderer.resetState();
        renderer.initRenderTarget(shadowTarget);
        targetReady = true;
      }
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
      renderer.resetState();
      renderer.setRenderTarget(shadowTarget);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, true, false);
      const previous = scene.overrideMaterial;
      scene.overrideMaterial = casterMaterial;
      renderer.render(scene, shadowCamera);
      scene.overrideMaterial = previous;
      renderer.setRenderTarget(null);
      renderedKey = key;
      lastShadowAt = started;
      stats.shadowRenders++;
      stats.lastShadowMs = clock() - started;
      stats.shadowTexelM = frame.texelM;
    },

    drawBackground(renderer, view) {
      if (disposed || !sun || !state) return;
      if (!targetReady && shadowTarget) {
        // Belt and braces for the rule in `prerender`: a host that skipped the
        // offscreen pass must not leave every program with a shadow sampler
        // undrawable. `initRenderTarget` rebinds the framebuffer, so state is
        // reset after it, before anything is drawn into the map's.
        renderer.initRenderTarget(shadowTarget);
        targetReady = true;
        renderer.resetState();
      }
      const effect = Math.max(
        0,
        Math.min(1, (view.zoom - EFFECT_ZOOM[0]) / (EFFECT_ZOOM[1] - EFFECT_ZOOM[0])),
      );
      const metresPerMercator = 1 / mercatorPerMetre(view.centerLngLat.lat);
      const rays = viewRays(view.projection, metresPerMercator);
      if (!rays) return;

      shared.uCamera.value.set(...rays.camera);
      shared.uGroundZ.value = view.groundM;
      stats.groundM = view.groundM;
      stats.cameraHeightM = rays.camera[2];
      rays.corners.forEach((corner, i) => {
        passUniforms.uCorners.value[i].set(...corner);
      });
      passUniforms.uEffect.value = effect;

      if (frame) {
        shared.uShadowStrength.value = state.shadowStrength * view.opacity;
        shared.uShadowBias.value = frame.depthPerMetre * frame.texelM * 1.5;
        passUniforms.uShadowEnu.value.fromArray(
          shadowMatrixForEnu(frame, view.center, 1 / metresPerMercator),
        );
        buildingUniforms.uShadowMatrix.value.fromArray(shadowMatrixForCentre(frame, view.center));
        buildingUniforms.uShadowNormalOffset.value = frame.texelM;
      } else {
        shared.uShadowStrength.value = 0;
      }
      stats.shadowStrength = shared.uShadowStrength.value;
      buildingUniforms.uMetresPerMercator.value = metresPerMercator;

      if (effect <= 0) return;
      renderer.render(skyScene, passCamera);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (catchUp) clearTimeout(catchUp);
      catchUp = null;
      lutTexture.dispose();
      depthTexture?.dispose();
      shadowTarget?.dispose();
      for (const pass of passes) pass.material.dispose();
      quad.dispose();
      casterMaterial.dispose();
    },
  };
  return sky;
}
