/**
 * What every TSL material of the city engine shares (`docs/MAP_NATIVE_3D.md`):
 * the engine's uniforms bound as nodes, MapLibre's `fill-extrusion` light, the
 * premultiplied output MapLibre blends custom layers with, the terrain lift
 * and the level-of-detail dither. One copy, so the buildings and the trees
 * cannot drift apart in how they are lit or how they fade.
 */
import {
  CustomBlending,
  type MeshBasicNodeMaterial,
  type Node,
  type Matrix4,
  type NodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type Vector2,
  type Vector3,
} from 'three/webgpu';
import {
  attribute,
  clamp,
  Discard,
  dot,
  float,
  Fn,
  floor,
  fract,
  max,
  mix,
  mod,
  screenCoordinate,
  select,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { FADE_USERDATA_KEY } from '../transitions';

export type Float = Node<'float'>;
export type Vec3 = Node<'vec3'>;

/** A uniform the engine owns and updates in place (three's `IUniform` shape). */
export interface UniformRef<T> {
  value: T;
}

/** A node that reads the engine's `ref` on every render: one source of truth. */
export function bindFloat(ref: UniformRef<number>) {
  return uniform(ref.value).onRenderUpdate(() => ref.value);
}

/*
 * A vector or matrix uniform holds the engine's OWN object, which the engine
 * mutates in place (it never assigns a new one): three reads it as each
 * object is drawn, with no per-render callback. A callback is a node update
 * per draw per uniform, and a sky-lit building reads dozens.
 */

export function bindVec3(ref: UniformRef<Vector3>) {
  return uniform(ref.value);
}

export function bindVec2(ref: UniformRef<Vector2>) {
  return uniform(ref.value);
}

export function bindMat4(ref: UniformRef<Matrix4>) {
  return uniform(ref.value);
}

/** A per-mesh number, read from `object.userData[key]` as each mesh is drawn. */
export function perObject(key: string, read: (value: unknown) => number, fallback: number) {
  return uniform(fallback).onObjectUpdate(({ object }) => {
    const value = (object?.userData as Record<string, unknown> | undefined)?.[key];
    return value === undefined ? fallback : read(value);
  });
}

/** The light the engine hands every material (`occlusion.ts` → `CityLight`), plus terrain. */
export interface LightUniforms {
  uLightPosition: ReturnType<typeof bindVec3>;
  uLightIntensity: ReturnType<typeof bindFloat>;
  uLightColor: ReturnType<typeof bindVec3>;
  uGrounded: ReturnType<typeof bindFloat>;
}

/** Rec. 709 luma, as MapLibre's extrusion shader weighs a colour. */
export const luma = (c: Vec3): Float => dot(c, vec3(0.2126, 0.7152, 0.0722));

/**
 * MapLibre's `fill-extrusion` lighting (`occlusion.ts` → `extrusionDirectional`)
 * of `base` with normal `n`, times the material's own `occlusion`, clamped as
 * MapLibre clamps.
 */
export function extrusionLit(base: Vec3, n: Vec3, occlusion: Float, u: LightUniforms): Vec3 {
  const d = clamp(dot(n, u.uLightPosition), 0, 1);
  const directional = mix(
    float(1).sub(u.uLightIntensity),
    max(float(1).sub(luma(base)).add(u.uLightIntensity), 1),
    d,
  );
  return clamp(
    base.add(0.03).mul(directional.mul(occlusion)).mul(u.uLightColor),
    mix(vec3(0), vec3(0.3), vec3(1).sub(u.uLightColor)),
    vec3(1),
  );
}

/**
 * An opaque surface's output. The buildings and trees are never blended: the
 * zoom fade (`BUILDINGS_3D_FADE`) is the dither's, as every other fade
 * ({@link dithered}), so they draw as one solid layer with their depth, and
 * nothing behind a wall shows through it.
 */
export const opaque = (color: Vec3): Node<'vec4'> => vec4(color, 1);

/** Blend as MapLibre blends custom layers: premultiplied alpha, opaque pass. */
export function mapBlending<T extends NodeMaterial | MeshBasicNodeMaterial>(material: T): T {
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.transparent = false;
  return material;
}

/**
 * A terrain lift (`terrainGround.ts`) read from attribute `name` × `scale`,
 * only where the geometry carries it (a mesh gains it the first time it is
 * placed on terrain) and only while the engine says the map has terrain.
 */
export const terrainLift = (name: string, grounded: Float, scale = 1) =>
  Fn((builder) =>
    builder.geometry?.hasAttribute(name) === true
      ? select(grounded.greaterThan(0.5), attribute(name, 'float').mul(scale), 0)
      : float(0),
  )();

/** One tile entry's fade (`transitions.ts`): the dither keeps noise in `[from, to)`. */
export interface FadeRefs {
  uFadeFrom: UniformRef<number>;
  uFadeTo: UniformRef<number>;
}

/**
 * The fade's screen door (`transitions.ts`): interleaved
 * gradient noise on the fragment's pixel, kept inside the mesh's own
 * `[from, to)` (`userData[FADE_USERDATA_KEY]`), so one material serves every
 * tile. Only the dithered variant of a material carries it: a shader that may
 * discard loses early depth testing.
 */
export function dithered(color: Node<'vec4'>): Node<'vec4'> {
  const fadeFrom = perObject(FADE_USERDATA_KEY, (fade) => (fade as FadeRefs).uFadeFrom.value, 0);
  const fadeTo = perObject(FADE_USERDATA_KEY, (fade) => (fade as FadeRefs).uFadeTo.value, 1);
  return Fn(() => {
    // A 4 × 4 ordered (Bayer) threshold: at any share an even mesh, never
    // the diagonal streaks a hash leaves at one device pixel per CSS pixel.
    const pixel = floor(screenCoordinate.xy);
    const bayer2 = (p: Node<'vec2'>) => mod(p.x.mul(2).add(p.y.mul(3)), 4);
    const fine = bayer2(mod(pixel, 2));
    const coarse = bayer2(mod(floor(pixel.div(2)), 2));
    const noise = fine.mul(4).add(coarse).add(0.5).div(16);
    Discard(noise.lessThan(fadeFrom).or(noise.greaterThanEqual(fadeTo)));
    return color;
  })();
}
