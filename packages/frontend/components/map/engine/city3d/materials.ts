/**
 * The DETAILED city material: matte clay by day, moonlit blue-grey with warm
 * windows by night. The `detailedCity` map feature (`lib/map/mapFeatures.ts`);
 * with it off, every material draws exactly what it did before. The shader is
 * TSL, `tsl/detailedMaterial.ts`; this module is its design, its tables and
 * uniforms, and the JS mirrors the tests pin.
 *
 * ## One shading path
 *
 * Ownership (lead decision): the SKY owns the light inputs — the sun's
 * direction and colour, the sky and bounce irradiance, the shadow map, the
 * haze, what the scene emits, the night factor — and the ART DIRECTION owns
 * the material response: how a surface turns those inputs into colour. The
 * response is `tsl/detailedMaterial.ts`, the `CityMaterialResponse` the sky's
 * one shading path calls (`tsl/skyBuildingMaterial.ts` → the contract), in
 * the sky's linear light. There is no
 * second path: the detailed look always lights its buildings with the city
 * sky (the map adapter gives it a live-clock sky when none was asked for).
 * The surface colour it starts from (`tsl/buildingSurface.ts`: the height
 * ramp and the tempered tag, then the detailed look's tag clamp and
 * per-building tint) is the sky's own.
 *
 * ## The response
 *
 * For a surface with albedo `A`, normal `n`, height `h` on a building of
 * height `H`, and the toward-sun direction `L`, with the sky's light:
 *
 *     wrap    = clamp((n·L + w) / (1 + w), 0, 1)                    the terminator is soft
 *     fill    = mix(grey(f), f, chroma) · gain,  f = mix(bounce, skyUp, n.z/2 + 1/2)
 *     occl    = contact(h) · mix(1, cornerAO, k) · gradient(h/H)    (contact, gradient: walls only)
 *     colour  = rolloff(A · ((sun · sunGain · wrap · shadow + fill) · occl + emitted) + edge · chamfer(n.z) · fill)
 *
 * No face is lit by the sun alone, so a wall facing away keeps the whole
 * fill — a shade under the lit one and cooler, never black: clay, not
 * cardboard. The gains and the chroma are the clay's answer to a physically
 * blue sky and a dim vertical wall; the sun keeps its colour, so golden hour
 * is golden. `chamfer` is 1 on the mesher's 45° roof bevel.
 *
 * ## Night
 *
 * Every parameter has a day and a night value (`palette3d.ts` →
 * `CITY_MATERIALS`), blended ON THE GPU by `uNightFactor` — the engine's one
 * night seam (`CityEngine.setNightFactor`), which the map adapter feeds from
 * `lib/map/landmarks/night.ts` (the dark map is full night) and the city sky
 * from its time of day. Nothing here keeps a night factor of its own.
 *
 * WINDOWS glow only where the mesher drew a storey rhythm — where
 * `building:levels` is RECORDED (`facades.ts`). Each opening is lit or not by
 * a deterministic hash of (bay, storey, building) against `windowLitShare`,
 * and the same hash picks its glow between warm and a cooler white and its
 * brightness: a stylistic pattern, stable frame to frame, never a claim about
 * occupancy. Far away, a facade fades to its average glow. The light at the
 * foot of the walls (street glow, `floodlit=yes`) is the sky's `emitted`.
 *
 * Every number lives in `palette3d.ts`; the pure functions below mirror the
 * shader so the tests can pin it (`__tests__/city3dMaterials.test.ts`).
 */
import type { BuildingUse } from '@/lib/map/cityTiles';
import type { CityMaterial, Rgb } from '@/lib/map/style/palette3d';

import { smoothstep } from './occlusion';

/** The share of a storey × bay an opening covers (the classic rhythm's band sizes). */
export const OPENING_AREA = (0.76 - 0.24) * (0.82 - 0.3);

/**
 * The facade's styling per building class (`BUILDING_USES` order, after
 * "unknown"), as the shader's tables (`tsl/detailedMaterial.ts`). `opening`: half-width of a window in bay
 * fractions, sill and head in storey fractions, pier depth (m). `relief`:
 * window recess (m), cornice projection (m), plinth darkening, string course
 * (m). Styling, not survey: an office is drawn with piers because offices of
 * the kind tend to have them, never because this one is known to.
 */
export const FACADE_STYLES: readonly {
  use: 'unknown' | BuildingUse;
  opening: readonly [number, number, number, number];
  relief: readonly [number, number, number, number];
}[] = [
  { use: 'unknown', opening: [0.26, 0.3, 0.82, 0], relief: [0.12, 0.25, 0.05, 0.08] },
  { use: 'residential', opening: [0.22, 0.28, 0.8, 0], relief: [0.14, 0.3, 0.06, 0.1] },
  { use: 'commercial', opening: [0.34, 0.18, 0.88, 0.16], relief: [0.1, 0.2, 0.08, 0.12] },
  { use: 'civic', opening: [0.18, 0.22, 0.86, 0.22], relief: [0.16, 0.4, 0.08, 0.14] },
  { use: 'religious', opening: [0.14, 0.25, 0.85, 0.26], relief: [0.18, 0.35, 0.06, 0.12] },
  { use: 'industrial', opening: [0.38, 0.6, 0.88, 0], relief: [0.06, 0, 0, 0] },
];

/** Fields uploaded as `vec3` uniforms, by uniform stem. */
const RGB_FIELDS = {
  Glass: 'glass',
  WindowGlow: 'windowGlow',
  WindowGlowCool: 'windowGlowCool',
} as const satisfies Record<string, keyof CityMaterial>;

/** Fields uploaded as `float` uniforms, by uniform stem. */
const FLOAT_FIELDS = {
  Wrap: 'wrap',
  AoGround: 'aoGround',
  AoReach: 'aoReachM',
  AoCorner: 'aoCorner',
  HeightGradient: 'heightGradient',
  Edge: 'edge',
  TintLightness: 'tintLightness',
  TintHue: 'tintHue',
  TagBlend: 'tagBlend',
  TagSaturation: 'tagSaturation',
  SkyFillGain: 'skyFillGain',
  SkyFillChroma: 'skyFillChroma',
  SkySunGain: 'skySunGain',
  WindowStrength: 'windowStrength',
  WindowLitShare: 'windowLitShare',
} as const satisfies Record<string, keyof CityMaterial>;

/** The material's `vec3` uniform stems (`uMat<Stem>`, `uMat<Stem>Night`). */
export const MATERIAL_VEC3_STEMS: readonly string[] = [...Object.keys(RGB_FIELDS), 'AlbedoScale'];
/** The material's `float` uniform stems. */
export const MATERIAL_FLOAT_STEMS: readonly string[] = Object.keys(FLOAT_FIELDS);

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------

/**
 * Every uniform the detailed material reads (`tsl/detailedMaterial.ts`): each field's day value and
 * its night value, plus the albedo scale (1 by day; night's low ramp over
 * day's, so the shared ramp uniforms stay the day's and the GPU darkens it).
 */
export function materialUniformValues(material: {
  day: CityMaterial;
  night: CityMaterial;
}): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  for (const [phase, m] of [
    ['', material.day],
    ['Night', material.night],
  ] as const) {
    for (const [stem, field] of Object.entries(RGB_FIELDS))
      out[`uMat${stem}${phase}`] = [...(m[field] as Rgb)];
    for (const [stem, field] of Object.entries(FLOAT_FIELDS))
      out[`uMat${stem}${phase}`] = m[field] as number;
  }
  out.uMatAlbedoScale = [1, 1, 1];
  out.uMatAlbedoScaleNight = material.night.low.map((c, i) => c / material.day.low[i]);
  return out;
}

/** The DAY albedo ramp, in the shape the shared `uLow`/`uTall`/… uniforms take. */
export function materialRamp(material: CityMaterial) {
  return {
    low: material.low,
    tall: material.tall,
    veryTall: material.veryTall,
    tallM: material.tallM,
    veryTallM: material.veryTallM,
  };
}

// ---------------------------------------------------------------------------
// JS mirrors of the shader, for the tests
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];

/** `gowayHash3(...)`, bit for bit: three values in [0, 1]. */
export function pcgHash3(x: number, y: number, z: number): [number, number, number] {
  let a = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  let b = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  let c = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  a = (a + Math.imul(b, c)) >>> 0;
  b = (b + Math.imul(c, a)) >>> 0;
  c = (c + Math.imul(a, b)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  b = (b ^ (b >>> 16)) >>> 0;
  c = (c ^ (c >>> 16)) >>> 0;
  a = (a + Math.imul(b, c)) >>> 0;
  b = (b + Math.imul(c, a)) >>> 0;
  c = (c + Math.imul(a, b)) >>> 0;
  return [a / 4294967295, b / 4294967295, c / 4294967295];
}

/** `gowayHash3(...).x`: whether-lit's draw. */
export function pcgHash(x: number, y: number, z: number): number {
  return pcgHash3(x, y, z)[0];
}

/** Whether the window at (building seed, bay, storey) is lit under `material`. */
export function windowIsLit(material: CityMaterial, seed: number, bay: number, storey: number) {
  return pcgHash(bay, storey, seed) >= 1 - material.windowLitShare;
}

/** The glow of the window at (seed, bay, storey): `gowayWindows`' `glow × on`. */
export function windowGlowAt(
  material: CityMaterial,
  seed: number,
  bay: number,
  storey: number,
): [number, number, number] {
  const [x, y, z] = pcgHash3(bay, storey, seed);
  if (x < 1 - material.windowLitShare) return [0, 0, 0];
  const k = 0.72 + 0.28 * z;
  return [0, 1, 2].map(
    (i) =>
      (material.windowGlow[i] + (material.windowGlowCool[i] - material.windowGlow[i]) * y * y) * k,
  ) as [number, number, number];
}

/** The sky's light inputs (`tsl/skyBuildingMaterial.ts` → `CitySkyLight`), linear. */
export interface SkyLightInputs {
  sunDir: Vec3;
  sun: Vec3;
  sunVisibility: number;
  skyUp: Vec3;
  skyDown: Vec3;
  emitted: Vec3;
}

/**
 * `cityMaterial` (the sky path) for an untagged, window-less surface, in
 * linear light before the sky's gamma — the facade terms aside, line for
 * line. `albedo` is sRGB, as the ramp uniforms are.
 */
export function skyMaterialResponse(
  material: CityMaterial,
  albedo: Rgb,
  n: Vec3,
  h: number,
  buildingH: number,
  cornerAo: number,
  l: SkyLightInputs,
): [number, number, number] {
  const lin = albedo.map((c) => Math.max(c, 0) ** 2.2);
  const up = 0.5 + 0.5 * n[2];
  const raw = [0, 1, 2].map((i) => l.skyDown[i] + (l.skyUp[i] - l.skyDown[i]) * up);
  const grey = 0.2126 * raw[0] + 0.7152 * raw[1] + 0.0722 * raw[2];
  const fill = raw.map((c) => (grey + (c - grey) * material.skyFillChroma) * material.skyFillGain);
  const len = Math.hypot(...l.sunDir) || 1;
  const ndl = (n[0] * l.sunDir[0] + n[1] * l.sunDir[1] + n[2] * l.sunDir[2]) / len;
  const wrap = Math.max(0, Math.min(1, (ndl + material.wrap) / (1 + material.wrap)));
  const wall = 1 - smoothstep(0.3, 0.6, Math.abs(n[2]));
  const contact = 1 - material.aoGround * (1 - smoothstep(0, material.aoReachM, h)) * wall;
  const corner = 1 + (cornerAo - 1) * material.aoCorner;
  const grad =
    1 - material.heightGradient * (1 - Math.max(0, Math.min(1, h / Math.max(buildingH, 3)))) * wall;
  const occl = contact * corner * grad;
  const chamfer = smoothstep(0.35, 0.6, n[2]) * (1 - smoothstep(0.85, 0.97, n[2]));
  return [0, 1, 2].map((i) => {
    const light = (l.sun[i] * material.skySunGain * wrap * l.sunVisibility + fill[i]) * occl;
    const x = lin[i] * (light + l.emitted[i]) + material.edge * chamfer * fill[i];
    // The sky's `rolloff`.
    return x < 0.8 ? x : 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
  }) as [number, number, number];
}
