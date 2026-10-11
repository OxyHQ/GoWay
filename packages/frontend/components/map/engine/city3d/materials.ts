/**
 * The DETAILED city material: matte clay by day, moonlit blue-grey with warm
 * windows by night. Behind `?cityStyle=detailed` (`lib/map/cityStyleFlag.ts`);
 * with it off, every shader draws exactly what it did before.
 *
 * ## One shading path
 *
 * Ownership (lead decision): the SKY owns the light inputs — the sun's
 * direction and colour, the sky and bounce irradiance, the shadow map, the
 * haze, what the scene emits, the night factor — and the ART DIRECTION owns
 * the material response: how a surface turns those inputs into colour. The
 * response is {@link DETAILED_SKY_MATERIAL_GLSL}, the
 * `cityMaterial(CitySurface, CityLight)` the sky's one shading path calls
 * (`skyShaders.ts` → the contract), in the sky's linear light. There is no
 * second path: the detailed look always lights its buildings with the city
 * sky (the map adapter gives it a live-clock sky when none was asked for).
 * The surface colour it starts from (`osmBase` in `osmShaders.ts`: the height
 * ramp, the tag clamp, the per-building tint) is the sky's own, under the
 * {@link DETAILED_DEFINE} the engine sets on every building material.
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
 * GLSL so the tests can pin it (`__tests__/city3dMaterials.test.ts`).
 */
import type { CityMaterial, Rgb } from '@/lib/map/style/palette3d';

import { smoothstep } from './occlusion';

/** The preprocessor define that switches every building shader to this material. */
export const DETAILED_DEFINE = 'GOWAY_DETAILED';

/** The share of a storey × bay an opening covers (the classic rhythm's band sizes). */
export const OPENING_AREA = (0.76 - 0.24) * (0.82 - 0.3);

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

const lower = (stem: string) => stem[0].toLowerCase() + stem.slice(1);
const declare = (type: string, stem: string) =>
  `uniform ${type} uMat${stem};\nuniform ${type} uMat${stem}Night;`;
const blend = (stem: string) => `  m.${lower(stem)} = mix(uMat${stem}, uMat${stem}Night, t);`;

const VEC3_STEMS = [...Object.keys(RGB_FIELDS), 'AlbedoScale'];
const FLOAT_STEMS = Object.keys(FLOAT_FIELDS);

/**
 * Declarations and helpers, spliced into a fragment shader before use. Behind
 * the define, and include-guarded: `osmBase` and the sky material both splice
 * it into the same sky-lit shader. Expects `uNightFactor` declared already.
 */
export const MATERIAL_GLSL = `
#ifdef ${DETAILED_DEFINE}
#ifndef GOWAY_MATERIAL_DECLS
#define GOWAY_MATERIAL_DECLS
${VEC3_STEMS.map((stem) => declare('vec3', stem)).join('\n')}
${FLOAT_STEMS.map((stem) => declare('float', stem)).join('\n')}

// The material at this frame's night factor (palette3d.ts: day and night).
struct GowayMat {
${VEC3_STEMS.map((stem) => `  vec3 ${lower(stem)};`).join('\n')}
${FLOAT_STEMS.map((stem) => `  float ${lower(stem)};`).join('\n')}
};
GowayMat gowayMat() {
  float t = clamp(uNightFactor, 0.0, 1.0);
  GowayMat m;
${[...VEC3_STEMS, ...FLOAT_STEMS].map(blend).join('\n')}
  return m;
}

// pcg3d (Jarzynski & Olano 2020): integer hash, identical on every GPU.
uvec3 gowayPcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 gowayHash3(uvec3 v) { return vec3(gowayPcg3d(v)) * (1.0 / 4294967295.0); }

// 1 on walls, 0 on roofs.
float gowayWall(vec3 n) { return 1.0 - smoothstep(0.3, 0.6, abs(n.z)); }

// Per-building albedo variation: v lightness, v2 warm <-> cool.
vec3 gowayTint(GowayMat m, vec3 albedo, float v, float v2) {
  vec3 warm = vec3(1.0 + m.tintHue, 1.0, 1.0 - m.tintHue);
  vec3 cool = vec3(1.0 - m.tintHue, 1.0, 1.0 + m.tintHue);
  return albedo * (1.0 + (v - 0.5) * 2.0 * m.tintLightness) * mix(cool, warm, v2);
}

// Contact and corner occlusion and the wall gradient (see materials.ts).
float gowayOcclusion(GowayMat m, vec3 n, float h, float buildingH, float cornerAo) {
  float wall = gowayWall(n);
  float contact = 1.0 - m.aoGround * (1.0 - smoothstep(0.0, m.aoReach, h)) * wall;
  float corner = mix(1.0, cornerAo, m.aoCorner);
  float grad = 1.0 - m.heightGradient * (1.0 - clamp(h / max(buildingH, 3.0), 0.0, 1.0)) * wall;
  return contact * corner * grad;
}

// Wrap diffuse toward the sun.
float gowayWrap(GowayMat m, vec3 n, vec3 toSun) {
  return clamp((dot(n, normalize(toSun)) + m.wrap) / (1.0 + m.wrap), 0.0, 1.0);
}

// 1 on the 45-degree roof bevel, fading out toward flat and vertical faces.
float gowayChamfer(vec3 n) {
  return smoothstep(0.35, 0.6, n.z) * (1.0 - smoothstep(0.85, 0.97, n.z));
}

float gowayBand(float x, float lo, float hi, float w) {
  return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}

// One opening of the recorded storey rhythm (osmMesher.ts 'facade'): how much
// of this fragment it covers (open), how far the facade has faded to its
// average (far), and which window it is (cell: bay, storey, building seed).
struct GowayWindow { float open; float far; uvec3 cell; };
GowayWindow gowayWindow(vec4 facade, vec4 color, float h, vec3 n) {
  GowayWindow w;
  w.open = 0.0;
  w.far = 0.0;
  w.cell = uvec3(0u, 0u, uint(color.r * 255.0) + 256u * uint(color.g * 255.0));
  if (facade.w > 0.5 && abs(n.z) < 0.3) {
    float storey = facade.z / 100.0;
    float level = (h - facade.y / 10.0) / storey;
    if (level >= 0.0 && level < facade.w) {
      float bay = facade.x / 256.0;
      vec2 f = vec2(fract(bay), fract(level));
      vec2 fw = max(fwidth(vec2(bay, level)), vec2(1e-4));
      float detail = 1.0 - smoothstep(0.12, 0.3, max(fw.x, fw.y));
      w.open = gowayBand(f.x, 0.24, 0.76, fw.x) * gowayBand(f.y, 0.3, 0.82, fw.y) * detail;
      w.far = 1.0 - detail;
      w.cell.xy = uvec2(uint(floor(bay)), uint(floor(level)));
    }
  }
  return w;
}

// The palette's sRGB colours in the sky's linear light.
vec3 gowayLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

// Glass and glow over a lit colour (linear, as is light).
vec3 gowayWindows(GowayMat m, vec3 lit, vec3 light, GowayWindow w) {
  lit = mix(lit, gowayLinear(m.glass) * light, w.open * m.windowStrength);
  vec3 h = gowayHash3(w.cell);
  float on = step(1.0 - m.windowLitShare, h.x);
  vec3 glow = gowayLinear(m.windowGlow);
  lit += mix(glow, gowayLinear(m.windowGlowCool), h.y * h.y) * (0.72 + 0.28 * h.z) * on * w.open;
  lit += glow * (m.windowLitShare * ${(OPENING_AREA * 0.8 * 0.86).toFixed(4)}) * w.far;
  return lit;
}
#endif
#endif
`;

/**
 * The material response (`CityEngineOptions.sky.material`), in the sky's
 * linear light. The palette's colours are sRGB, so they are linearised here;
 * the sky rolls off, gamma-encodes and hazes the result.
 */
export const DETAILED_SKY_MATERIAL_GLSL = `${MATERIAL_GLSL}
#ifdef ${DETAILED_DEFINE}
vec3 cityMaterial(CitySurface s, CityLight l) {
  GowayMat m = gowayMat();
  vec3 n = s.normal;
  vec3 albedo = s.albedo * gowayLinear(m.albedoScale);
  // The sky's hemisphere, answered with some of its hue and a gain (palette3d.ts).
  vec3 fill = mix(l.skyDown, l.skyUp, 0.5 + 0.5 * n.z);
  fill = mix(vec3(dot(fill, vec3(0.2126, 0.7152, 0.0722))), fill, m.skyFillChroma) * m.skyFillGain;
  float occl = gowayOcclusion(m, n, s.heightAboveGround, s.buildingHeight, s.cornerAo);
  vec3 sun = l.sun * m.skySunGain * gowayWrap(m, n, l.sunDir) * l.sunVisibility;
  vec3 light = (sun + fill) * occl;
  vec3 lit = albedo * (light + l.emitted) + m.edge * gowayChamfer(n) * fill;
  lit = gowayWindows(m, lit, light, gowayWindow(s.facade, s.color, s.heightAboveGround, n));
  return rolloff(lit);
}
#endif
`;

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------

/**
 * Every uniform {@link MATERIAL_GLSL} declares: each field's day value and
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
// JS mirrors of the GLSL, for the tests
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

/** The sky's light inputs (`skyShaders.ts` → `CityLight`), linear. */
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
