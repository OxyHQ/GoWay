/**
 * The city-3D building shader, as GLSL ES 3.00 source strings.
 *
 * Kept out of `cityEngine.ts` so it imports no renderer, and generated from
 * the constants in `occlusion.ts` rather than restating them: the fragment
 * shader below is `extrusionDirectional × groundOcclusion × cornerOcclusion`
 * from that module, line for line, so the numbers the tests pin are the
 * numbers the GPU draws.
 *
 * The lighting is MapLibre's own `fill-extrusion` formula (maplibre-gl 6.10),
 * fed the same `light` the map is (`components/map/city3dLight.ts`): the base
 * colour plus MapLibre's 0.03 ambient, times `directional`, times the light
 * colour, clamped per channel exactly as MapLibre clamps it. Where MapLibre
 * multiplies its vertical gradient into `directional`, this multiplies the
 * baked occlusion. So the two renderers agree on every face's light and differ
 * only in what the city layer adds: the bevel and the occlusion.
 *
 * The material is a three.js `RawShaderMaterial` with `glslVersion: GLSL3`, so
 * three prepends only `#version 300 es`; everything else — precision, the
 * `modelViewMatrix`/`projectionMatrix` uniforms three fills in, the attribute
 * names it binds by — is declared here.
 *
 * Colour arithmetic is done on the palette's sRGB values directly, with no
 * linearisation, because that is what MapLibre does for every other layer on
 * the map. A physically correct pipeline (linear light, tone mapping) is the
 * atmosphere phase's job, and doing it for the buildings alone would make
 * them the one thing on the map that does not match its neighbours.
 */
import { CLASSIC_DETAILED_GLSL, DETAILED_DEFINE, MATERIAL_GLSL } from './materials';
import { AO } from './occlusion';
import { Z_UNITS_PER_METRE } from './packing';
import { DITHER_DISCARD_GLSL, DITHER_GLSL } from './transitions';

/** A number as a GLSL float literal (`1` → `1.0`), which GLSL ES insists on. */
export function glslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite GLSL float: ${value}`);
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

export const CITY_VERTEX_SHADER = `
precision highp float;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

// The compact format (packing.ts): x, y in tile units, z in 1/32 m, and the
// shade word (tone × 256 + corner occlusion). The model matrix turns the
// units back into metres, so only the height and the shade are decoded here.
in vec4 position;
// Unit normal × 127 (int8, normalised by the attribute), w unused.
in vec4 normal;
// On 3D terrain: how far this vertex's building is lifted, in metres
// (terrainGround.ts). Read only while uGrounded is set; without terrain the
// attribute may not even be bound.
in float ground;
uniform float uGrounded;

out vec3 vNormal;
out float vCornerAo;
out float vHeightAboveGround;
out float vBuildingHeight;

void main() {
  vNormal = normal.xyz;
  float tone = floor(position.w / 256.0);
  vCornerAo = (position.w - tone * 256.0) / 255.0;
  vHeightAboveGround = position.z * ${glslFloat(1 / Z_UNITS_PER_METRE)};
  vBuildingHeight = tone;
  // The lift is metres; stored z is 1/32 m, scaled back by the model matrix.
  float lift = uGrounded > 0.5 ? ground * ${glslFloat(Z_UNITS_PER_METRE)} : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, position.z + lift, 1.0);
}
`;

export const CITY_FRAGMENT_SHADER = `
precision highp float;

// The palette's height ramp (see buildingHeightRamp in buildings3d.ts).
uniform vec3 uLow;
uniform vec3 uTall;
uniform vec3 uVeryTall;
uniform float uTallM;
uniform float uVeryTallM;

// The map's light (occlusion.ts → CityLight), in MapLibre's units.
uniform vec3 uLightPosition;
uniform float uLightIntensity;
uniform vec3 uLightColor;

// The zoom fade, shared with the fill-extrusion layer this replaces.
uniform float uOpacity;

// The engine's night seam (CityEngine.setNightFactor): the detailed look's day/night blend.
uniform float uNightFactor;

in vec3 vNormal;
in float vCornerAo;
in float vHeightAboveGround;
in float vBuildingHeight;

out vec4 fragColor;

// Level-of-detail and fade-in cross-fades (transitions.ts).
${DITHER_GLSL}
${MATERIAL_GLSL}
${CLASSIC_DETAILED_GLSL}
void main() {
  ${DITHER_DISCARD_GLSL}
  vec3 n = normalize(vNormal);

  vec3 base = vBuildingHeight < uTallM
    ? mix(uLow, uTall, vBuildingHeight / uTallM)
    : mix(uTall, uVeryTall, clamp((vBuildingHeight - uTallM) / (uVeryTallM - uTallM), 0.0, 1.0));

#ifdef ${DETAILED_DEFINE}
  // The detailed material (materials.ts). OpenMapTiles unions a block into
  // one feature, so there is no per-building tint and no window here
  // (an all-zero facade draws none).
  vec3 detailed = gowayClassic(base, n, vHeightAboveGround, vBuildingHeight, vCornerAo, uLightPosition, vec4(0.0), vec4(0.0));
  fragColor = vec4(clamp(detailed, 0.0, 1.0) * uOpacity, uOpacity);
#else
  // extrusionDirectional() — MapLibre's fill-extrusion lighting.
  float luminance = dot(base, vec3(0.2126, 0.7152, 0.0722));
  float d = clamp(dot(n, uLightPosition), 0.0, 1.0);
  float directional = mix(1.0 - uLightIntensity, max(1.0 - luminance + uLightIntensity, 1.0), d);

  // groundOcclusion() × cornerOcclusion, where MapLibre puts its gradient.
  float ground = ${glslFloat(AO.groundMin)}
    + ${glslFloat(1 - AO.groundMin)} * smoothstep(0.0, ${glslFloat(AO.groundReachM)}, vHeightAboveGround);
  directional *= ground * vCornerAo;

  vec3 color = clamp(
    (base + 0.03) * directional * uLightColor,
    mix(vec3(0.0), vec3(0.3), vec3(1.0) - uLightColor),
    vec3(1.0)
  );

  // MapLibre blends custom layers as premultiplied alpha.
  fragColor = vec4(color * uOpacity, uOpacity);
#endif
}
`;
