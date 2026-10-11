/**
 * The city's building material in TSL (three.js's shading language): ONE
 * definition that three compiles to GLSL for WebGL2 on the web and to WGSL for
 * WebGPU — Dawn on Metal or Vulkan — on native (`docs/MAP_NATIVE_3D.md`).
 *
 * It is the GLSL it replaced (`shaders.ts` for OpenMapTiles buildings,
 * `osmShaders.ts` for GoWay city tiles; deleted in phase 2, step 2, except
 * the `osmBase` the city sky still reads) term for term: the height ramp, for city tiles the tempered tagged
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
 * Not ported yet: the city-sky variant (`skyShaders.ts`).
 */
import { MeshBasicNodeMaterial, type Side, type Vector3 } from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  max,
  mix,
  normalize,
  select,
  smoothstep,
  varying,
  vec2,
  vec3,
} from 'three/tsl';

import { AO } from '../occlusion';
import { TAG_TEMPER } from '../osmShaders';
import { Z_UNITS_PER_METRE } from '../packing';
import type { CityTileFormat } from '../protocol';
import {
  bindFloat,
  bindVec3,
  dithered,
  extrusionLit,
  type Float,
  luma,
  mapBlending,
  premultiplied,
  terrainLift,
  type UniformRef,
  type Vec3,
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
  uOpacity: UniformRef<number>;
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
    uOpacity: bindFloat(refs.uOpacity),
    uGrounded: bindFloat(refs.uGrounded),
  };
}

export type BuildingUniforms = ReturnType<typeof createBuildingUniforms>;

/** A soft box: 1 inside `[lo, hi]`, 0 outside, anti-aliased over `w`. */
const band = (x: Float, lo: number, hi: number, w: Float): Float =>
  smoothstep(w.negate().add(lo), w.add(lo), x).mul(
    float(1).sub(smoothstep(w.negate().add(hi), w.add(hi), x)),
  );

export interface BuildingMaterials {
  /** The shared material for a tile format, settled or dithered (built on first use). */
  get(format: CityTileFormat, dithered: boolean): MeshBasicNodeMaterial;
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
  const ramped = select(
    vBuildingHeight.lessThan(u.uTallM),
    mix(u.uLow, u.uTall, vBuildingHeight.div(u.uTallM)),
    mix(
      u.uTall,
      u.uVeryTall,
      clamp(vBuildingHeight.sub(u.uTallM).div(u.uVeryTallM.sub(u.uTallM)), 0, 1),
    ),
  );
  const base = format === 'goway' ? cityTileSurface(u, ramped, n, vHeightAboveGround) : ramped;
  // groundOcclusion() × cornerOcclusion, where MapLibre puts its gradient.
  const ground = float(AO.groundMin).add(
    float(1 - AO.groundMin).mul(smoothstep(0, AO.groundReachM, vHeightAboveGround)),
  );
  const color = premultiplied(extrusionLit(base, n, ground.mul(vCornerAo), u), u.uOpacity);

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

/**
 * GoWay city tiles' surface (`osmShaders.ts` → `osmBase`): the tagged colour
 * tempered into the ramp, and one row of openings per RECORDED storey.
 */
function cityTileSurface(u: BuildingUniforms, ramped: Vec3, n: Vec3, vHeight: Float): Vec3 {
  const vColor = varying(attribute('color', 'vec4'));
  const vFacade = varying(attribute('facade', 'vec4'));
  // 0 on the light palette, 1 on the dark one (its lowest buildings are dark).
  const dark = float(1).sub(smoothstep(0.25, 0.55, luma(u.uLow)));

  // 1. Tagged colour / material, tempered into the ramp's lightness.
  const raw = vColor.rgb;
  const desaturated = mix(
    vec3(luma(raw)),
    raw,
    float(TAG_TEMPER.saturation).mul(float(1).sub(dark.mul(0.4))),
  );
  const keep = float(TAG_TEMPER.lightness).mul(float(1).sub(dark.mul(0.5)));
  const targetLuma = mix(luma(ramped), luma(desaturated), keep);
  const tagged = clamp(desaturated.add(vec3(targetLuma.sub(luma(desaturated)))), 0, 1);
  const tinted = mix(ramped, tagged, vColor.a.mul(TAG_TEMPER.blend));

  // 2. Openings, computed everywhere and masked (derivatives need uniform flow).
  const storey = max(vFacade.z.div(100), 1e-3);
  const level = vHeight.sub(vFacade.y.div(10)).div(storey);
  const bay = vFacade.x.div(256);
  const w = max(fwidth(vec2(bay, level)), vec2(1e-4));
  const opening = band(fract(bay), 0.24, 0.76, w.x).mul(band(fract(level), 0.3, 0.82, w.y));
  // Fade the rhythm out once a storey is only a few pixels tall.
  const detail = float(1).sub(smoothstep(0.12, 0.3, max(w.x, w.y)));
  const onFacade = vFacade.w
    .greaterThan(0.5)
    .and(abs(n.z).lessThan(0.3))
    .and(level.greaterThanEqual(0))
    .and(level.lessThan(vFacade.w));
  const glass = mix(vec3(0.34, 0.4, 0.48), vec3(0.07, 0.08, 0.1), dark);
  const withOpenings = mix(tinted, mix(tinted.mul(0.6), glass, 0.55), opening.mul(detail).mul(0.7));
  return select(onFacade, withOpenings, tinted);
}
