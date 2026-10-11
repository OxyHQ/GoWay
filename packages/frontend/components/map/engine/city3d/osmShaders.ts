/**
 * GoWay city tiles' building surface for the materials that are still GLSL:
 * the city sky's (`skyShaders.ts`), and with it the detailed look. Without the
 * sky the buildings are TSL (`tsl/buildingMaterial.ts`), which reads the same
 * {@link TAG_TEMPER} — one temper, two shading languages until the sky is
 * ported (`docs/MAP_NATIVE_3D.md` → Phase 2).
 *
 * The surface is the palette's height ramp plus, from data the mesher put in
 * the vertices (`osmMesher.ts`):
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
 *     distant facade is a plain wall rather than a moiré.
 */
import { DETAILED_DEFINE, MATERIAL_GLSL } from './materials';
import { glslFloat } from './shaders';
/** How a tagged colour is tempered into the palette; see the module header. */
export const TAG_TEMPER = {
  /** How much of the colour's saturation is kept. */
  saturation: 0.6,
  /** How much of its lightness difference from the ramp is kept. */
  lightness: 0.4,
  /** The most of the tempered colour that replaces the ramp. */
  blend: 0.85,
} as const;

/**
 * The OSM tiles' surface colour as a GLSL function, `vec3 osmBase(vec3 n)`,
 * with its helpers. Reads the palette uniforms and the `vColor`, `vFacade`,
 * `vHeightAboveGround` and `vBuildingHeight` varyings, which every program
 * that includes it must declare. One copy, so the city-sky material lights
 * exactly the colour this shader does.
 */
export const OSM_BASE_GLSL = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
${MATERIAL_GLSL}

// A soft box: 1 inside [lo, hi], 0 outside, anti-aliased over w.
float band(float x, float lo, float hi, float w) {
  return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}

// The surface colour before light: the height ramp, the tagged colour and
// the recorded storeys' openings. Shared with the city-sky material (\`skyShaders.ts\`).
vec3 osmBase(vec3 n) {
  vec3 ramp = vBuildingHeight < uTallM
    ? mix(uLow, uTall, vBuildingHeight / uTallM)
    : mix(uTall, uVeryTall, clamp((vBuildingHeight - uTallM) / (uVeryTallM - uTallM), 0.0, 1.0));

  // 0 on the light palette, 1 on the dark one (its lowest buildings are dark).
  float dark = 1.0 - smoothstep(0.25, 0.55, luma(uLow));

  // 1. Tagged colour / material, tempered into the ramp's lightness. The
  //    lightness is SHIFTED, not scaled, so a tagged black still moves.
  //    The dark appearance keeps less of both.
  vec3 tagged = mix(vec3(luma(vColor.rgb)), vColor.rgb, ${glslFloat(TAG_TEMPER.saturation)} * (1.0 - 0.4 * dark));
  float keep = ${glslFloat(TAG_TEMPER.lightness)} * (1.0 - 0.5 * dark);
  float targetLuma = mix(luma(ramp), luma(tagged), keep);
  tagged = clamp(tagged + vec3(targetLuma - luma(tagged)), 0.0, 1.0);
#ifdef ${DETAILED_DEFINE}
  // The detailed look (materials.ts): the tag clamped to a lightness hint (most
  // of its chroma gone), and a per-building tint. An untagged surface carries
  // the building's seed in its unused rgb (osmMesher.ts -> withSeed); a tagged
  // one varies by its own colour. Openings are the material's, not drawn here.
  GowayMat gm = gowayMat();
  bool seeded = vColor.a < 0.002;
  vec3 base = gowayTint(
    gm,
    mix(ramp, mix(vec3(luma(tagged)), tagged, gm.tagSaturation), vColor.a * ${glslFloat(TAG_TEMPER.blend)} * gm.tagBlend),
    seeded ? vColor.r : fract(luma(vColor.rgb) * 7.0),
    seeded ? vColor.g : fract(vColor.b * 5.0)
  );
#else
  vec3 base = mix(ramp, tagged, vColor.a * ${glslFloat(TAG_TEMPER.blend)});

  // 2. Openings, one row per RECORDED storey (vFacade.w), on walls only.
  if (vFacade.w > 0.5 && abs(n.z) < 0.3) {
    float storey = vFacade.z / 100.0;
    float level = (vHeightAboveGround - vFacade.y / 10.0) / storey;
    if (level >= 0.0 && level < vFacade.w) {
      float bay = vFacade.x / 256.0;
      vec2 f = vec2(fract(bay), fract(level));
      vec2 w = max(fwidth(vec2(bay, level)), vec2(1e-4));
      float opening = band(f.x, 0.24, 0.76, w.x) * band(f.y, 0.3, 0.82, w.y);
      // Fade the rhythm out once a storey is only a few pixels tall.
      float detail = 1.0 - smoothstep(0.12, 0.3, max(w.x, w.y));
      vec3 glass = mix(vec3(0.34, 0.40, 0.48), vec3(0.07, 0.08, 0.10), dark);
      base = mix(base, mix(base * 0.6, glass, 0.55), opening * detail * 0.7);
    }
  }
#endif
  return base;
}
`;
