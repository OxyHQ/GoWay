/**
 * The city's building material in TSL (three.js's shading language): ONE
 * definition that three compiles to GLSL for WebGL2 on the web and to WGSL for
 * WebGPU — Dawn on Metal or Vulkan — on native (`docs/MAP_NATIVE_3D.md`).
 *
 * It is the GLSL it replaced (`shaders.ts` for OpenMapTiles buildings,
 * `osmShaders.ts` for GoWay city tiles; deleted in phase 2) term for term:
 * the height ramp, for city tiles the tempered tagged
 * colour and the recorded storeys' openings, MapLibre's `fill-extrusion`
 * directional light, the baked ground and corner occlusion, the terrain lift
 * and the level-of-detail dither — over the same packed vertex lanes
 * (`packing.ts`). Three things are written differently because WGSL or the
 * node system demands it, not because the look changes:
 *
 *  - **No derivative inside a branch.** WGSL only allows `fwidth` in uniform
 *    control flow, so the openings are computed for every fragment and masked,
 *    where the GLSL skips them with an `if`. Same value on every pixel.
 *  - **Integer lanes are declared as floats.** The position and facade lanes
 *    are `uint16` and not normalised; WebGPU reads them as `vec4<u32>`, and
 *    the node builder converts — what WebGL2's `vertexAttribPointer` did.
 *  - **The dither is a material variant, not a `#define`.** A fading tile's
 *    meshes switch to the dithered material, exactly when the GLSL sets
 *    `DITHER`, for the same reason: a shader that may discard loses early
 *    depth testing.
 *  - **One material per format and variant, shared by every tile** — four at
 *    most — where the GLSL path builds one per tile. three keys a node
 *    material's build by its nodes' identity, so per-tile materials meant a
 *    node build per tile and a uniform upload per tile per frame. A tile's
 *    own fade is read per object instead (`FADE_USERDATA_KEY`,
 *    `transitions.ts`).
 *
 * The uniforms are the ENGINE'S own `{ value }` objects, read each render
 * ({@link createBuildingUniforms}): the light, palette, opacity and terrain
 * switch the engine already updates drive this material too, with no second
 * copy to keep in step. What it shares with the trees — light, output,
 * terrain lift, dither — is `common.ts`.
 *
 * Under the city sky the buildings are `skyBuildingMaterial.ts`, on the same
 * surface (`buildingSurface.ts`).
 */
import { MeshBasicNodeMaterial, type Side, type Vector3 } from 'three/webgpu';
import { attribute, float, floor, normalize, smoothstep, varying, vec3 } from 'three/tsl';

import { AO } from '../occlusion';
import { Z_UNITS_PER_METRE } from '../packing';
import type { CityTileFormat } from '../protocol';
import { cityTileSurface, rampAt } from './buildingSurface';
import {
  bindFloat,
  bindVec3,
  dithered,
  extrusionLit,
  mapBlending,
  opaque,
  terrainLift,
  type UniformRef,
} from './common';

/** The engine's building uniforms, by the names the GLSL materials use. */
export interface BuildingUniformRefs {
  uLow: UniformRef<Vector3>;
  uTall: UniformRef<Vector3>;
  uVeryTall: UniformRef<Vector3>;
  uTallM: UniformRef<number>;
  uVeryTallM: UniformRef<number>;
  uLightPosition: UniformRef<Vector3>;
  uLightIntensity: UniformRef<number>;
  uLightColor: UniformRef<Vector3>;
  uGrounded: UniformRef<number>;
}

/**
 * Uniform nodes bound to the engine's uniforms, built ONCE per engine and
 * shared by every building material it makes.
 */
export function createBuildingUniforms(refs: BuildingUniformRefs) {
  return {
    uLow: bindVec3(refs.uLow),
    uTall: bindVec3(refs.uTall),
    uVeryTall: bindVec3(refs.uVeryTall),
    uTallM: bindFloat(refs.uTallM),
    uVeryTallM: bindFloat(refs.uVeryTallM),
    uLightPosition: bindVec3(refs.uLightPosition),
    uLightIntensity: bindFloat(refs.uLightIntensity),
    uLightColor: bindVec3(refs.uLightColor),
    uGrounded: bindFloat(refs.uGrounded),
  };
}

export type BuildingUniforms = ReturnType<typeof createBuildingUniforms>;

export interface BuildingMaterials {
  /** The shared material for a tile format, settled or dithered (built on first use). */
  get(format: CityTileFormat, dithered: boolean): MeshBasicNodeMaterial;
  /**
   * Rebuild every variant's programs on their next draw: a mesh's geometry
   * gained an attribute the material reads only where present (the terrain
   * lift, `common.ts` → `terrainLift`). three re-checks a drawn mesh's program
   * only when its material's version moves, so without this a mesh drawn
   * before its tile was grounded keeps a program with no lift — and stands
   * at z = 0, under the terrain.
   */
  invalidate(): void;
  dispose(): void;
}

/**
 * The building materials an engine draws with: at most four (two formats,
 * settled and dithered), all on the engine's shared uniforms and `side`.
 */
export function createBuildingMaterials(u: BuildingUniforms, side: Side): BuildingMaterials {
  const built = new Map<string, MeshBasicNodeMaterial>();
  return {
    get(format, isDithered) {
      const key = `${format}:${isDithered}`;
      let material = built.get(key);
      if (!material) {
        material = buildMaterial(format, u, side, isDithered);
        built.set(key, material);
      }
      return material;
    },
    invalidate() {
      for (const material of built.values()) material.needsUpdate = true;
    },
    dispose() {
      for (const material of built.values()) material.dispose();
      built.clear();
    },
  };
}

function buildMaterial(
  format: CityTileFormat,
  u: BuildingUniforms,
  side: Side,
  isDithered: boolean,
): MeshBasicNodeMaterial {
  // --- Vertex: unpack the compact lanes (packing.ts) -----------------------
  // x, y in tile units, z in 1/32 m, w the shade word (tone × 256 + corner AO);
  // the mesh's matrix turns the units back into metres.
  const position = attribute('position', 'vec4');
  const tone = floor(position.w.div(256));
  const vCornerAo = varying(position.w.sub(tone.mul(256)).div(255));
  const vHeightAboveGround = varying(position.z.mul(1 / Z_UNITS_PER_METRE));
  const vBuildingHeight = varying(tone);
  const vNormal = varying(attribute('normal', 'vec4').xyz);

  // --- Fragment --------------------------------------------------------------
  const n = normalize(vNormal);
  const ramped = rampAt(u, vBuildingHeight);
  const base =
    format === 'goway'
      ? cityTileSurface(
          u,
          ramped,
          n,
          vHeightAboveGround,
          varying(attribute('color', 'vec4')),
          varying(attribute('facade', 'vec4')),
        )
      : ramped;
  // groundOcclusion() × cornerOcclusion, where MapLibre puts its gradient.
  const ground = float(AO.groundMin).add(
    float(1 - AO.groundMin).mul(smoothstep(0, AO.groundReachM, vHeightAboveGround)),
  );
  const color = opaque(extrusionLit(base, n, ground.mul(vCornerAo), u));

  const material = mapBlending(new MeshBasicNodeMaterial());
  // The lift is metres; stored z is 1/32 m, scaled back by the model matrix.
  material.positionNode = vec3(
    position.xy,
    position.z.add(terrainLift('ground', u.uGrounded, Z_UNITS_PER_METRE)),
  );
  material.colorNode = isDithered ? dithered(color) : color;
  material.side = side;
  return material;
}
