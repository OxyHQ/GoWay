/**
 * The city sky's ground and sky passes in TSL: one full-screen quad drawn
 * three times, before the buildings, over what MapLibre has drawn so far (the
 * basemap: land, water, roads, the flat footprints). It replaced the GLSL
 * passes term for term (`docs/MAP_NATIVE_3D.md` → Phase 2).
 *
 *  0. **FILL** (blend `src × (1 − dst alpha) + dst`): the horizon haze, only
 *     where MapLibre drew nothing at all — past its far plane the canvas is
 *     transparent, and would show the page through.
 *  1. **MULTIPLY** (blend `dst × src`): the basemap times the light on the
 *     ground — sun × shadow + sky — and times the haze transmittance; zero
 *     above the horizon.
 *  2. **ADD** (blend `dst + src`): the haze's in-scattered light below the
 *     horizon, the sky (and the sun's disc) above it.
 *
 * Together: `basemap · light · T + fog · (1 − T)` on the ground and the sky
 * where there is no ground — the aerial-perspective equation, applied to
 * pixels this layer did not draw, using nothing but blending. That is how the
 * basemap gets the same light and haze as the buildings without the layer
 * owning MapLibre's framebuffer.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  Group,
  type Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  OneFactor,
  OneMinusDstAlphaFactor,
  SrcColorFactor,
  type Vector3,
  ZeroFactor,
} from 'three/webgpu';
import {
  attribute,
  dot,
  float,
  fwidth,
  max,
  min,
  mix,
  normalize,
  pow,
  smoothstep,
  uniformArray,
  varying,
  vec3,
  vec4,
} from 'three/tsl';

import { ATMOSPHERE } from '../atmosphere';
import { SKY_PASS_LAYER } from '../frameSelection';
import { bindFloat, bindMat4, bindVec3, type UniformRef, type Vec3 } from './common';
import type { SkyNodes } from './skyNodes';

/** The passes' own uniforms (`sky.ts`), beside the sky's shared ones. */
export interface SkyPassUniformRefs {
  /** Far-plane corner minus camera, ENU metres, for (−1,−1), (1,−1), (−1,1), (1,1). */
  uCorners: UniformRef<Vector3[]>;
  /** ENU (from the centre) → shadow clip, for the ground plane. */
  uShadowEnu: UniformRef<Matrix4>;
  uSunDisc: UniformRef<Vector3>;
  /** 0 → 1: the whole effect, faded in with zoom. */
  uEffect: UniformRef<number>;
}

export type SkyPass = 'fill' | 'multiply' | 'add';

export interface SkyPasses {
  /**
   * The three passes, in draw order and before everything else in the scene
   * they join (their quad is in clip space: any camera draws them), on
   * `SKY_PASS_LAYER`. Shown only while the effect is on.
   */
  group: Group;
  dispose(): void;
}

/** Before every other mesh in the engine's scene (the streets are −3 and −2). */
const FIRST = -100;

const SUN_RADIUS = ATMOSPHERE.sunAngularRadiusDeg * 2 * (Math.PI / 180);

export function createSkyPasses(sky: SkyNodes, refs: SkyPassUniformRefs): SkyPasses {
  const corners = uniformArray(refs.uCorners.value, 'vec3') as unknown as {
    element(index: number): Vec3;
  };
  const shadowEnu = bindMat4(refs.uShadowEnu);
  const sunDisc = bindVec3(refs.uSunDisc);
  const effect = bindFloat(refs.uEffect);

  const position = attribute('position', 'vec3');
  const uv = position.xy.mul(0.5).add(0.5);
  const vRay = varying(
    mix(
      mix(corners.element(0), corners.element(1), uv.x),
      mix(corners.element(2), corners.element(3), uv.x),
      uv.y,
    ),
  );
  const clip = vec4(position.xy, 0, 1);

  const fragment = (pass: SkyPass): Node<'vec4'> => {
    const dir = normalize(vRay);
    // Anti-aliased horizon: one pixel's worth of blend between ground and sky.
    const w = max(fwidth(dir.z), 1e-6);
    const skyness = smoothstep(w.negate(), w, dir.z);
    const h0 = max(sky.camera.z.sub(sky.groundZ), 1);
    // Where the ray meets the ground; past ~200 km the haze is saturated.
    const d = min(h0.div(max(dir.z.negate(), 1e-6)), 2.0e5);
    const T = sky.hazeTransmittance(h0, min(dir.z, 0), d);
    if (pass === 'multiply') {
      const ground = sky.camera.add(dir.mul(d));
      // Above the horizon the factor is 0 whatever the shadow.
      const visible = sky.sunVisibility(shadowEnu.mul(vec4(ground.xy, sky.groundZ, 1)));
      const factor = mix(sky.groundLight(visible).mul(T), vec3(0), skyness);
      return vec4(mix(vec3(1), factor, effect), 1);
    }
    if (pass === 'add') {
      const fog = sky.skyColor(vec3(dir.xy, 0));
      const c = dot(dir, sky.sunDir);
      const disc = smoothstep(Math.cos(SUN_RADIUS * 1.2), Math.cos(SUN_RADIUS * 0.8), c);
      const glow = pow(max(c, 0), 1200).mul(0.5);
      const skyColour = sky.skyColor(dir).add(sunDisc.mul(disc.add(glow)));
      const color = mix(fog.mul(vec3(1).sub(T)), skyColour, skyness).mul(effect);
      return vec4(color, skyness.mul(effect));
    }
    // FILL: only where MapLibre drew nothing (past its far plane, near the
    // horizon). The horizon's haze, divided by the ground light the MULTIPLY
    // pass is about to apply, so that after it and the ADD pass the pixel is
    // exactly the haze, not a lit copy of it (which drew a dark band under the
    // horizon at night).
    const fill = min(
      sky.skyColor(vec3(dir.xy, 0)).div(max(sky.groundLight(float(1)), vec3(1e-3))),
      vec3(1),
    );
    return vec4(fill, 1).mul(effect);
  };

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2, 2, 1, 3]);

  const group = new Group();
  group.visible = false;
  const materials: MeshBasicNodeMaterial[] = [];
  (['fill', 'multiply', 'add'] as const).forEach((pass, order) => {
    const material = new MeshBasicNodeMaterial();
    material.vertexNode = clip;
    material.colorNode = fragment(pass);
    material.depthTest = false;
    material.depthWrite = false;
    material.side = DoubleSide;
    material.forceSinglePass = true;
    material.blending = CustomBlending;
    if (pass === 'fill') {
      // src × (1 − dst alpha) + dst: only where nothing was drawn.
      material.blendSrc = OneMinusDstAlphaFactor;
      material.blendDst = OneFactor;
      material.blendSrcAlpha = OneMinusDstAlphaFactor;
      material.blendDstAlpha = OneFactor;
    } else if (pass === 'multiply') {
      // dst × src (alpha kept: src alpha is 1).
      material.blendSrc = ZeroFactor;
      material.blendDst = SrcColorFactor;
      material.blendSrcAlpha = ZeroFactor;
      material.blendDstAlpha = OneFactor;
    } else {
      // dst + src; the sky makes the pixel opaque even where the basemap
      // left it transparent.
      material.blendSrc = OneFactor;
      material.blendDst = OneFactor;
      material.blendSrcAlpha = OneFactor;
      material.blendDstAlpha = OneFactor;
    }
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = FIRST + order;
    mesh.layers.set(SKY_PASS_LAYER);
    group.add(mesh);
    materials.push(material);
  });
  return {
    group,
    dispose() {
      group.removeFromParent();
      for (const material of materials) material.dispose();
      geometry.dispose();
    },
  };
}
