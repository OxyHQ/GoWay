/**
 * A building's surface colour before light, in TSL: the palette's height
 * ramp and, for GoWay city tiles, the data the mesher put in the vertices
 * (`osmMesher.ts`). ONE copy, read by the map-lit material
 * (`buildingMaterial.ts`) and the sky-lit one (`skyBuildingMaterial.ts`), so
 * the sky lights exactly the colour the map-lit buildings have.
 *
 *  1. **Surface colour.** `color.rgb` is a tagged `building:colour` /
 *     `roof:colour`, or a material's typical colour; `color.a` is how much of
 *     it to use against the palette's ramp (0 = none, the ramp alone). It is
 *     TEMPERED before it is used — desaturated by {@link TAG_TEMPER}.saturation
 *     and pulled {@link TAG_TEMPER}.lightness of the way to the ramp's own
 *     lightness — because the raw values make exactly the patchwork
 *     `buildings3d.ts` refused `colour` for: measured on Lower Manhattan, a
 *     tagged `black` tower and a `yellow` roof were the two loudest things on
 *     the map. Tempered, the hue survives as a hint (a red-brick block reads
 *     warm, a glass tower cool) and the lightness stays the palette's, which is
 *     also what makes it right in the dark appearance with no special case.
 *  2. **The storey rhythm.** Where `facade.w` (recorded storeys) is non-zero,
 *     each storey of each wall gets a row of identical openings, one per bay;
 *     nowhere else. They fade out as a storey shrinks below a few pixels, so a
 *     distant facade is a plain wall rather than a moiré. (The detailed look
 *     draws its own windows instead: `detailedMaterial.ts`.)
 *
 * The openings are computed for every fragment and masked: WGSL allows
 * `fwidth` only in uniform control flow.
 */
import type { Node } from 'three/webgpu';
import {
  abs,
  clamp,
  float,
  fract,
  fwidth,
  max,
  mix,
  select,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl';

import { type Float, luma, type Vec3 } from './common';

type Vec4 = Node<'vec4'>;

/** How a tagged colour is tempered into the palette; see the module header. */
export const TAG_TEMPER = {
  /** How much of the colour's saturation is kept. */
  saturation: 0.6,
  /** How much of its lightness difference from the ramp is kept. */
  lightness: 0.4,
  /** The most of the tempered colour that replaces the ramp. */
  blend: 0.85,
} as const;

/** The palette's height ramp (the engine's `uLow`/`uTall`/… uniforms, as nodes). */
export interface RampNodes {
  uLow: Vec3;
  uTall: Vec3;
  uVeryTall: Vec3;
  uTallM: Float;
  uVeryTallM: Float;
}

/** The ramp's colour for a building `height` metres tall. */
export const rampAt = (u: RampNodes, height: Float): Vec3 =>
  select(
    height.lessThan(u.uTallM),
    mix(u.uLow, u.uTall, height.div(u.uTallM)),
    mix(u.uTall, u.uVeryTall, clamp(height.sub(u.uTallM).div(u.uVeryTallM.sub(u.uTallM)), 0, 1)),
  );

/** 0 on the light palette, 1 on the dark one (its lowest buildings are dark). */
export const darkness = (u: RampNodes): Float => float(1).sub(smoothstep(0.25, 0.55, luma(u.uLow)));

/**
 * The tagged colour tempered into the ramp's lightness. The lightness is
 * SHIFTED, not scaled, so a tagged black still moves; the dark appearance
 * keeps less of both.
 */
export function temperedTag(u: RampNodes, ramped: Vec3, color: Vec4): Vec3 {
  const dark = darkness(u);
  const raw = color.rgb;
  const desaturated = mix(
    vec3(luma(raw)),
    raw,
    float(TAG_TEMPER.saturation).mul(float(1).sub(dark.mul(0.4))),
  );
  const keep = float(TAG_TEMPER.lightness).mul(float(1).sub(dark.mul(0.5)));
  const targetLuma = mix(luma(ramped), luma(desaturated), keep);
  return clamp(desaturated.add(vec3(targetLuma.sub(luma(desaturated)))), 0, 1);
}

/** A soft box: 1 inside `[lo, hi]`, 0 outside, anti-aliased over `w`. */
const band = (x: Float, lo: number, hi: number, w: Float): Float =>
  smoothstep(w.negate().add(lo), w.add(lo), x).mul(
    float(1).sub(smoothstep(w.negate().add(hi), w.add(hi), x)),
  );

/** GoWay city tiles' surface: the tempered tag over the ramp, and one row of openings per RECORDED storey. */
export function cityTileSurface(
  u: RampNodes,
  ramped: Vec3,
  n: Vec3,
  height: Float,
  color: Vec4,
  facade: Vec4,
): Vec3 {
  const tinted = mix(ramped, temperedTag(u, ramped, color), color.a.mul(TAG_TEMPER.blend));
  const storey = max(facade.z.div(100), 1e-3);
  const level = height.sub(facade.y.div(10)).div(storey);
  const bay = facade.x.div(256);
  const w = max(fwidth(vec2(bay, level)), vec2(1e-4));
  const opening = band(fract(bay), 0.24, 0.76, w.x).mul(band(fract(level), 0.3, 0.82, w.y));
  // Fade the rhythm out once a storey is only a few pixels tall.
  const detail = float(1).sub(smoothstep(0.12, 0.3, max(w.x, w.y)));
  const onFacade = facade.w
    .greaterThan(0.5)
    .and(abs(n.z).lessThan(0.3))
    .and(level.greaterThanEqual(0))
    .and(level.lessThan(facade.w));
  const glass = mix(vec3(0.34, 0.4, 0.48), vec3(0.07, 0.08, 0.1), darkness(u));
  const withOpenings = mix(tinted, mix(tinted.mul(0.6), glass, 0.55), opening.mul(detail).mul(0.7));
  return select(onFacade, withOpenings, tinted);
}
