/**
 * The GoWay city tiles' building material in TSL (three.js's shading
 * language): ONE definition that three compiles to GLSL for WebGL2 on the web
 * and to WGSL for WebGPU — Dawn on Metal or Vulkan — on native.
 * `docs/MAP_NATIVE_3D.md` is why: the native apps get the 3D city by running
 * this same engine on `react-native-webgpu`, and a material written in GLSL
 * (`osmShaders.ts`) cannot follow it there.
 *
 * It is `osmShaders.ts` term for term — the height ramp, the tempered tagged
 * colour, the recorded storeys' openings, MapLibre's `fill-extrusion`
 * directional light, the baked ground and corner occlusion — over the same
 * packed vertex lanes (`packing.ts`). Two things are written differently
 * because WGSL demands it, not because the look changes:
 *
 *  - **No derivative inside a branch.** WGSL only allows `fwidth` in uniform
 *    control flow, so the openings are computed for every fragment and masked,
 *    where the GLSL skips them with an `if`. Same value on every pixel.
 *  - **Integer lanes are declared as floats.** The position and facade lanes
 *    are `uint16` and not normalised; WebGPU reads them as `vec4<u32>`, and
 *    the node builder converts to `vec4<f32>` — what WebGL2's
 *    `vertexAttribPointer` did implicitly.
 *
 * Not ported yet (phase 2 of the plan): the terrain lift (`uGrounded`), the
 * level-of-detail dither and the city-sky variant (`skyShaders.ts`).
 */
import { MeshBasicNodeMaterial, type Node, Vector3 } from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  dot,
  float,
  floor,
  fract,
  fwidth,
  max,
  mix,
  normalize,
  select,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { AO, type CityLight } from '../occlusion';
import { TAG_TEMPER } from '../osmShaders';
import { Z_UNITS_PER_METRE } from '../packing';

/** The palette the ramp is drawn from: `buildingHeightRamp` (`buildings3d.ts`) as sRGB 0–1 triples. */
export interface BuildingRamp {
  low: readonly [number, number, number];
  tall: readonly [number, number, number];
  veryTall: readonly [number, number, number];
  tallM: number;
  veryTallM: number;
}

type Float = Node<'float'>;
type Vec3 = Node<'vec3'>;

const luma = (c: Vec3): Float => dot(c, vec3(0.2126, 0.7152, 0.0722));

/** A soft box: 1 inside `[lo, hi]`, 0 outside, anti-aliased over `w`. */
const band = (x: Float, lo: number, hi: number, w: Float): Float =>
  smoothstep(w.negate().add(lo), w.add(lo), x).mul(
    float(1).sub(smoothstep(w.negate().add(hi), w.add(hi), x)),
  );

/**
 * The material and the uniforms the engine drives (palette, light, opacity),
 * named as in `osmShaders.ts` so one uniform set can feed either renderer.
 */
export function createOsmBuildingMaterial(ramp: BuildingRamp, light: CityLight) {
  const uniforms = {
    uLow: uniform(new Vector3(...ramp.low)),
    uTall: uniform(new Vector3(...ramp.tall)),
    uVeryTall: uniform(new Vector3(...ramp.veryTall)),
    uTallM: uniform(ramp.tallM),
    uVeryTallM: uniform(ramp.veryTallM),
    uLightPosition: uniform(new Vector3(...light.position)),
    uLightIntensity: uniform(light.intensity),
    uLightColor: uniform(new Vector3(...light.color)),
    uOpacity: uniform(1),
  };
  const u = uniforms;

  // --- Vertex: unpack the compact lanes (packing.ts) -----------------------
  // x, y in tile units, z in 1/32 m, w the shade word (tone × 256 + corner AO);
  // the mesh's matrix turns the units back into metres.
  const position = attribute('position', 'vec4');
  const tone = floor(position.w.div(256));
  const vCornerAo = varying(position.w.sub(tone.mul(256)).div(255));
  const vHeightAboveGround = varying(position.z.mul(1 / Z_UNITS_PER_METRE));
  const vBuildingHeight = varying(tone);
  const vNormal = varying(attribute('normal', 'vec4').xyz);
  const vColor = varying(attribute('color', 'vec4'));
  const vFacade = varying(attribute('facade', 'vec4'));

  // --- Fragment: osmBase(), then the extrusion light ------------------------
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

  // 2. Openings, one row per RECORDED storey (vFacade.w), on walls only —
  //    computed everywhere and masked (derivatives need uniform control flow).
  const storey = max(vFacade.z.div(100), 1e-3);
  const level = vHeightAboveGround.sub(vFacade.y.div(10)).div(storey);
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
  const base = select(onFacade, withOpenings, tinted);

  // extrusionDirectional() — MapLibre's fill-extrusion lighting (occlusion.ts).
  const d = clamp(dot(n, u.uLightPosition), 0, 1);
  const directional = mix(
    float(1).sub(u.uLightIntensity),
    max(float(1).sub(luma(base)).add(u.uLightIntensity), 1),
    d,
  );
  const ground = float(AO.groundMin).add(
    float(1 - AO.groundMin).mul(smoothstep(0, AO.groundReachM, vHeightAboveGround)),
  );
  const lit = clamp(
    base.add(0.03).mul(directional.mul(ground).mul(vCornerAo)).mul(u.uLightColor),
    mix(vec3(0), vec3(0.3), vec3(1).sub(u.uLightColor)),
    vec3(1),
  );

  const material = new MeshBasicNodeMaterial();
  material.positionNode = position.xyz;
  material.colorNode = vec4(lit.mul(u.uOpacity), u.uOpacity);
  return { material, uniforms };
}
