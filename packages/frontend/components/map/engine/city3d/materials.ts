/**
 * The DETAILED city material: matte clay by day, moonlit blue-grey with warm
 * windows by night. The `detailedCity` map feature (`lib/map/mapFeatures.ts`);
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
import type { BuildingUse } from '@/lib/map/cityTiles';
import type { CityMaterial, Rgb } from '@/lib/map/style/palette3d';

import { FACADE } from './facades';
import { smoothstep } from './occlusion';

/** The preprocessor define that switches every building shader to this material. */
export const DETAILED_DEFINE = 'GOWAY_DETAILED';

/** The share of a storey × bay an opening covers (the classic rhythm's band sizes). */
export const OPENING_AREA = (0.76 - 0.24) * (0.82 - 0.3);

/**
 * The facade's styling per building class (`BUILDING_USES` order, after
 * "unknown"), as the GLSL's tables. `opening`: half-width of a window in bay
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

/** A GLSL float literal. */
const glslNumber = (value: number): string => (Number.isInteger(value) ? `${value}.0` : `${value}`);

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

// ── The facade (near detail only) ────────────────────────────────────────
// Styling on the RECORDED storey rhythm (osmMesher.ts 'facade': bay x256,
// first floor dm, storey cm, storeys): window openings, recessed with a frame;
// piers between window columns; a cornice under the eaves of every part (so
// at every setback); a string course over the ground floor and a plinth.
// Shapes vary by building class and era (flags bits, osmMesher.ts ->
// buildingFlagsOf); nothing here is a fact beyond the recorded storeys.
//
// Per class (FACADE_STYLES in materials.ts; index = the flags' use, 0 unknown).
const vec4 GOWAY_OPENING[${FACADE_STYLES.length}] = vec4[${FACADE_STYLES.length}](
${FACADE_STYLES.map((f) => `  vec4(${f.opening.map(glslNumber).join(', ')})`).join(',\n')}
);
const vec4 GOWAY_RELIEF[${FACADE_STYLES.length}] = vec4[${FACADE_STYLES.length}](
${FACADE_STYLES.map((f) => `  vec4(${f.relief.map(glslNumber).join(', ')})`).join(',\n')}
);

// What the facade does to a fragment: its normal, a recess shade, an albedo
// factor, and the window (open coverage, far fade, cell) the glow reads.
struct GowayFacade {
  vec3 normal;
  float shade;
  float albedo;
  float open;
  float far;
  uvec3 cell;
};

// The derivative in x of GLSL's smoothstep(e0, e1, x).
float gowayStepD(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return 6.0 * t * (1.0 - t) / (e1 - e0);
}

GowayFacade gowayFacade(vec4 facade, vec4 color, float flags, float h, vec3 n) {
  GowayFacade F;
  F.normal = n;
  F.shade = 1.0;
  F.albedo = 1.0;
  F.open = 0.0;
  F.far = 0.0;
  F.cell = uvec3(0u, 0u, uint(color.r * 255.0 + 0.5) + 256u * uint(color.g * 255.0 + 0.5));

  float storey = max(facade.z / 100.0, 0.5);
  float levels = facade.w;
  float level = (h - facade.y / 10.0) / storey;
  float bay = facade.x / 256.0;
  // The only screen derivatives, taken before any branch.
  vec2 fw = max(fwidth(vec2(bay, level)), vec2(1e-4));
  float valid = step(0.5, levels) * (1.0 - step(0.3, abs(n.z)))
    * step(0.0, level) * (1.0 - step(levels, level));
  // The window grid: gone once a storey is a few pixels tall.
  float detail = (1.0 - smoothstep(0.12, 0.3, max(fw.x, fw.y))) * valid;
  // The relief, closer still: full from ~30 px a storey, gone by ~14 px.
  float near = (1.0 - smoothstep(0.035, 0.07, max(fw.x, fw.y))) * valid;
  F.far = valid - detail;
  // Everything below is paid only by a near wall with recorded storeys.
  if (detail <= 0.0) return F;

  int f = int(flags + 0.5);
  int use = min((f >> 1) & 7, ${FACADE_STYLES.length - 1});
  int era = (f >> 4) & 3;
  vec4 o = GOWAY_OPENING[use];
  vec4 r = GOWAY_RELIEF[use];
  // Era: historic narrower openings and heavier cornices; early modern piers
  // (the 1920s-30s verticality); modern wider openings, flat and light.
  if (era == 1) { o.x *= 0.85; r.y *= 1.4; o.w = max(o.w, 0.12); }
  if (era == 2) { o.w = max(o.w, 0.22); }
  if (era == 3) { o.x = min(o.x * 1.25, 0.42); o.w *= 0.3; r.y *= 0.4; }

  vec2 fr = vec2(fract(bay), fract(level));
  bool groundFloor = level < 1.0 && levels >= 3.0;
  float sill = groundFloor ? 0.12 : o.y;
  float head = groundFloor ? 0.84 : o.z;
  float ox = abs(fr.x - 0.5);
  float side = sign(fr.x - 0.5);
  float ex = max(0.025, fw.x);
  float ey = max(0.025, fw.y);
  float inX = 1.0 - smoothstep(o.x - ex, o.x + ex, ox);
  float lo = smoothstep(sill - ey, sill + ey, fr.y);
  float hi = 1.0 - smoothstep(head - ey, head + ey, fr.y);
  float opening = inX * lo * hi;
  F.open = opening * detail;
  F.cell.xy = uvec2(uint(max(floor(bay), 0.0)), uint(max(floor(level), 0.0)));
  if (near <= 0.0) return F;

  // The relief: a height field over the wall (metres out of its plane) —
  // piers, the recessed opening, the cornice under the eaves, the string
  // course over the ground floor — and its ANALYTIC slope along the wall
  // (u, metres) and up it (v = h). A pier is symmetric, so the along-wall
  // sign does not matter.
  float pierD = gowayStepD(o.x + 0.06, o.x + 0.13, ox) * side;
  float inXD = -gowayStepD(o.x - ex, o.x + ex, ox) * side;
  float yD = gowayStepD(sill - ey, sill + ey, fr.y) * hi - lo * gowayStepD(head - ey, head + ey, fr.y);
  float belowEaves = (levels - level) * storey;
  float corniceD = r.y > 0.0 ? gowayStepD(0.3, 0.6, belowEaves) : 0.0;
  float aboveGround = (level - 1.0) * storey;
  float courseD = levels >= 3.0
    ? gowayStepD(-0.32, -0.22, aboveGround) * (1.0 - smoothstep(-0.04, 0.02, aboveGround))
      - smoothstep(-0.32, -0.22, aboveGround) * gowayStepD(-0.04, 0.02, aboveGround)
    : 0.0;
  vec2 g = near * vec2(
    (o.w * pierD - r.x * inXD * lo * hi) / ${glslNumber(FACADE.bayM)},
    -r.x * inX * yD / storey + r.y * corniceD + r.w * courseD
  );
  g = clamp(g, vec2(-1.5), vec2(1.5));
  vec3 along = normalize(cross(vec3(0.0, 0.0, 1.0), n) + vec3(1e-6, 0.0, 0.0));
  F.normal = normalize(n - g.x * along - g.y * vec3(0.0, 0.0, 1.0));

  // A recess is shaded, most under its head; a thin frame is a little
  // lighter; the ground floor sits on a slightly darker plinth.
  float frame = max(
    (1.0 - smoothstep(o.x + 0.05 - ex, o.x + 0.05 + ex, ox))
      * smoothstep(sill - 0.07 - ey, sill - 0.07 + ey, fr.y)
      * (1.0 - smoothstep(head + 0.06 - ey, head + 0.06 + ey, fr.y))
      - opening,
    0.0
  );
  F.shade = 1.0 - near * opening * (0.18 + 0.22 * smoothstep(sill, head, fr.y));
  F.albedo = (1.0 + 0.07 * frame * near) * (groundFloor ? 1.0 - r.z * near : 1.0);
  return F;
}

// The palette's sRGB colours in the sky's linear light.
vec3 gowayLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

// Glass and glow over a lit colour (linear, as is light).
vec3 gowayWindows(GowayMat m, vec3 lit, vec3 light, GowayFacade w) {
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
  // The facade's relief bends the normal the light sees (n stays the wall's,
  // for what is wall and what is roof).
  GowayFacade fc = gowayFacade(s.facade, s.color, s.flags, s.heightAboveGround, n);
  vec3 r = fc.normal;
  vec3 albedo = s.albedo * gowayLinear(m.albedoScale) * fc.albedo;
  // The sky's hemisphere, answered with some of its hue and a gain (palette3d.ts).
  vec3 fill = mix(l.skyDown, l.skyUp, 0.5 + 0.5 * r.z);
  fill = mix(vec3(dot(fill, vec3(0.2126, 0.7152, 0.0722))), fill, m.skyFillChroma) * m.skyFillGain;
  float occl = gowayOcclusion(m, n, s.heightAboveGround, s.buildingHeight, s.cornerAo) * fc.shade;
  vec3 sun = l.sun * m.skySunGain * gowayWrap(m, r, l.sunDir) * l.sunVisibility;
  vec3 light = (sun + fill) * occl;
  vec3 lit = albedo * (light + l.emitted) + m.edge * gowayChamfer(n) * fill;
  lit = gowayWindows(m, lit, light, fc);
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
