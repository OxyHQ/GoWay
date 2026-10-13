/**
 * The city sky's light inputs as TSL nodes: the haze, the sky table, the sun's
 * soft shadow, and the uniforms a sky-lit material reads. ONE copy, read by
 * every sky-lit material — the buildings (`skyBuildingMaterial.ts`), the
 * ground passes (`skyPasses.ts`) and the streets (`cityStreets/streetMaterials.ts`)
 * — so the haze the tests pin (`atmosphere.ts` → `hazeTransmittance`) is the
 * haze every surface draws (`docs/MAP_NATIVE_3D.md` → Phase 2).
 *
 * The uniforms are the sky's own `{ value }` objects (`sky.ts`), read each
 * render: the sky updates them and every material follows.
 *
 * ## WGSL's rules, kept here once
 *
 *  - **A comparison sample needs uniform control flow.** The shadow taps run
 *    under a branch on the shadow strength — a uniform, so uniform flow — and
 *    are masked, not skipped, outside the shadow box (a per-pixel test).
 *  - **The sky table is read at level 0** (it has no mipmaps): an explicit
 *    level is legal anywhere, so a caller may read it under any condition.
 */
import type { DataTexture, DepthTexture, Matrix4, Node, Vector2, Vector3 } from 'three/webgpu';
import {
  abs,
  array,
  asin,
  atan,
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  fract,
  If,
  length,
  Loop,
  max,
  min,
  mix,
  mod,
  select,
  screenCoordinate,
  sin,
  smoothstep,
  sqrt,
  texture,
  vec2,
  vec3,
} from 'three/tsl';

import { HAZE, HAZE_CLEAR_M } from '../atmosphere';
import {
  bindFloat,
  bindMat4,
  bindVec2,
  bindVec3,
  type Float,
  type UniformRef,
  type Vec3,
} from './common';

type Vec4 = Node<'vec4'>;

/**
 * PCF taps per shadowed fragment at the high quality preset; the profile
 * picks 12, 8, 4 or none (`lib/map/quality/profile.ts` → `sky.shadowTaps`).
 */
export const DEFAULT_SHADOW_TAPS = 12;

/**
 * Ordered so any prefix is spread: the first 4 are one per quadrant, the
 * first 8 add the four between them (fewer taps on lower quality presets).
 */
const POISSON: readonly (readonly [number, number])[] = [
  [-0.326, -0.406],
  [-0.696, 0.457],
  [0.962, -0.195],
  [0.519, 0.767],
  [-0.84, -0.074],
  [0.185, -0.893],
  [-0.203, 0.621],
  [0.896, 0.412],
  [0.473, -0.48],
  [0.507, 0.064],
  [-0.322, -0.933],
  [-0.792, -0.598],
];

/** The sky's live uniforms (`sky.ts`), by the names its materials use. */
export interface SkyUniformRefs {
  uSkyLut: UniformRef<DataTexture>;
  uSunAzimuth: UniformRef<number>;
  /** `null`: no shadows at this quality — no sampler is compiled. */
  uShadowMap: UniformRef<DepthTexture | null>;
  uShadowStrength: UniformRef<number>;
  uShadowTexel: UniformRef<Vector2>;
  uShadowBias: UniformRef<number>;
  /** The ground plane's elevation, metres (`CitySkyView.groundM`). */
  uGroundZ: UniformRef<number>;
  /** The camera, ENU metres from the map centre. */
  uCamera: UniformRef<Vector3>;
  uSunDir: UniformRef<Vector3>;
  uSunColor: UniformRef<Vector3>;
  uSkyAmbient: UniformRef<Vector3>;
  uGroundBounce: UniformRef<Vector3>;
  /** Warm street-level light on walls at night (`atmosphere.ts` → STREET_GLOW). */
  uStreetGlow: UniformRef<Vector3>;
  /** Centre-relative mercator → shadow clip. */
  uShadowMatrix: UniformRef<Matrix4>;
  uMetresPerMercator: UniformRef<number>;
  /** How far along the normal a building's shadow lookup starts, metres (a texel). */
  uShadowNormalOffset: UniformRef<number>;
  /** The night seam (`CityEngine.setNightFactor`), shared with every night look. */
  uNightFactor: UniformRef<number>;
}

/** What a sky-lit material reads: the sky's uniforms and functions, as nodes. */
export interface SkyNodes {
  sunDir: Vec3;
  sunColor: Vec3;
  skyAmbient: Vec3;
  groundBounce: Vec3;
  streetGlow: Vec3;
  nightFactor: Float;
  camera: Vec3;
  groundZ: Float;
  shadowMatrix: Node<'mat4'>;
  metresPerMercator: Float;
  shadowNormalOffset: Float;
  /** Haze transmittance from a camera `h0` m above the ground, along `dz`, over `d` m. */
  hazeTransmittance(h0: Float, dz: Float, d: Float): Vec3;
  /** The sky's colour toward ENU direction `dir` (gamma-encoded, as the table is). */
  skyColor(dir: Vec3): Vec3;
  /** 1 lit … 0 in shadow, weighted by the strength, faded at the box's rim. */
  sunVisibility(shadowClip: Vec4): Float;
  /** A centre-relative mercator world position in ENU metres (y flips). */
  enu(world: Vec3): Vec3;
  /** `color` (encoded) seen through the haze from the camera to ENU point `at`. */
  aerial(color: Vec3, at: Vec3): Vec3;
  /** The light on an up-facing surface — sun × visibility + sky — gamma-encoded. */
  groundLight(visibility: Float): Vec3;
}

/** `∫₀^d exp(−(h0 + t·dz)/H) dt`, the closed form, stable at `dz → 0`. */
function columnDensity(h0: Float, dz: Float, d: Float, scaleHeight: number): Float {
  const base = exp(max(h0, 0).negate().div(scaleHeight));
  const k = dz.div(scaleHeight);
  return select(
    abs(k.mul(d)).lessThan(1e-4),
    base.mul(d),
    base.mul(float(1).sub(exp(k.negate().mul(d)))).div(k),
  );
}

/** The sky's nodes for `shadowTaps` taps (0: no shadow sampler at all). */
export function createSkyNodes(refs: SkyUniformRefs, shadowTaps: number): SkyNodes {
  const taps = Math.max(0, Math.min(POISSON.length, Math.round(shadowTaps)));
  const sunAzimuth = bindFloat(refs.uSunAzimuth);
  const strength = bindFloat(refs.uShadowStrength);
  const texel = bindVec2(refs.uShadowTexel);
  const bias = bindFloat(refs.uShadowBias);
  const camera = bindVec3(refs.uCamera);
  const groundZ = bindFloat(refs.uGroundZ);
  const sunDir = bindVec3(refs.uSunDir);
  const sunColor = bindVec3(refs.uSunColor);
  const skyAmbient = bindVec3(refs.uSkyAmbient);
  const metresPerMercator = bindFloat(refs.uMetresPerMercator);
  const lut = refs.uSkyLut.value;
  const shadowMap = taps > 0 ? refs.uShadowMap.value : null;
  // The first `taps` of the kernel, as a constant table (three's types lose its element type).
  const kernel = array(
    POISSON.slice(0, Math.max(1, taps)).map(([x, y]) => vec2(x, y)),
  ) as unknown as {
    element(index: Node<'int'>): Node<'vec2'>;
  };

  const hazeTransmittance = (h0: Float, dz: Float, d: Float): Vec3 => {
    // Clear near field (atmosphere.ts → HAZE_CLEAR_M): the haze starts there.
    const clear = min(max(d, 0), HAZE_CLEAR_M);
    const from = h0.add(dz.mul(clear));
    const rest = max(d.sub(clear), 0);
    const r = columnDensity(from, dz, rest, HAZE.rayleighScaleHeightM);
    const m = columnDensity(from, dz, rest, HAZE.mieScaleHeightM);
    return exp(
      vec3(...HAZE.rayleigh)
        .mul(r)
        .add(m.mul(HAZE.mie))
        .negate(),
    );
  };

  // Across, the angle from the sun's azimuth; down, sqrt(elevation / (π/2)).
  const skyColor = (dir: Vec3): Vec3 => {
    const horizontal = length(dir.xy);
    const az = atan(dir.x, dir.y);
    const delta = select(
      horizontal.greaterThan(1e-6),
      abs(mod(az.sub(sunAzimuth).add(Math.PI), 2 * Math.PI).sub(Math.PI)),
      float(0.5 * Math.PI),
    );
    const el = asin(clamp(dir.z.div(max(length(dir), 1e-6)), 0, 1));
    return texture(lut, vec2(delta.div(Math.PI), sqrt(el.div(0.5 * Math.PI)))).level(float(0)).rgb;
  };

  const sunVisibility =
    shadowMap === null
      ? (_clip: Vec4): Float => float(1)
      : (Fn(([clip]: [Vec4]) => {
          const visible = float(1).toVar();
          If(strength.greaterThan(0), () => {
            const p = clip.xyz.mul(0.5).add(0.5);
            const rim = min(p.xy, vec2(1).sub(p.xy));
            const inside = smoothstep(0, 0.05, min(rim.x, rim.y));
            // Interleaved gradient noise (Jimenez 2014) rotates the kernel per
            // pixel, so the taps read as a smooth penumbra.
            const angle = fract(
              fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189),
            ).mul(6.2831853);
            const c = cos(angle);
            const s = sin(angle);
            const reference = p.z.sub(bias);
            // TSL samples in WebGPU's convention, v = 0 at the TOP (three flips
            // a render target on WebGL to match): the shadow clip's y is up.
            const at = vec2(p.x, float(1).sub(p.y));
            const lit = float(0).toVar();
            // One sampler read in a loop rather than `taps` copies: one texture
            // node to update per draw, and a constant loop is uniform flow.
            Loop(taps, ({ i }) => {
              const k = kernel.element(i);
              // Three texels: a wide, soft penumbra (the maquette look).
              const offset = vec2(c.mul(k.x).sub(s.mul(k.y)), s.mul(k.x).add(c.mul(k.y)))
                .mul(texel)
                .mul(3);
              // A comparison sample is a float (three types it as the texture's vec4).
              const tap = texture(shadowMap, at.add(vec2(offset.x, offset.y.negate()))).compare(
                reference,
              );
              lit.addAssign(tap as unknown as Float);
            });
            // Outside the box (or beyond its far plane) the sun is not blocked:
            // masked here, as the taps must run in uniform flow.
            const weight = select(p.z.greaterThanEqual(1), float(0), inside.mul(strength));
            visible.assign(mix(1, lit.div(taps), weight));
          });
          return visible;
        }) as unknown as (clip: Vec4) => Float);

  const enu = (world: Vec3): Vec3 =>
    vec3(world.x, world.y.negate(), world.z).mul(metresPerMercator);

  const aerial = (color: Vec3, at: Vec3): Vec3 => {
    const toPoint = at.sub(camera);
    const d = length(toPoint);
    const dir = toPoint.div(max(d, 1e-3));
    const T = hazeTransmittance(max(camera.z.sub(groundZ), 1), dir.z, d);
    return color.mul(T).add(skyColor(vec3(dir.xy, 0)).mul(vec3(1).sub(T)));
  };

  const groundLight = (visibility: Float): Vec3 =>
    sunColor
      .mul(max(sunDir.z, 0))
      .mul(visibility)
      .add(skyAmbient)
      .pow(1 / 2.2);

  return {
    sunDir,
    sunColor,
    skyAmbient,
    groundBounce: bindVec3(refs.uGroundBounce),
    streetGlow: bindVec3(refs.uStreetGlow),
    nightFactor: bindFloat(refs.uNightFactor),
    camera,
    groundZ,
    shadowMatrix: bindMat4(refs.uShadowMatrix),
    metresPerMercator,
    shadowNormalOffset: bindFloat(refs.uShadowNormalOffset),
    hazeTransmittance,
    skyColor,
    sunVisibility,
    enu,
    aerial,
    groundLight,
  };
}
