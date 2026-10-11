/**
 * The city-3D building shader, as GLSL ES 3.00 source strings.
 *
 * Kept out of `cityEngine.ts` so it imports no renderer, and generated from
 * the constants in `occlusion.ts` rather than restating them: the fragment
 * shader below is `surfaceBrightness × groundOcclusion × cornerOcclusion` from
 * that module, line for line, so the numbers the tests pin are the numbers the
 * GPU draws.
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
import { AO } from './occlusion';

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

in vec3 position;
in vec3 normal;
// x: corner occlusion (0–1); y: the building's height in metres / 255.
in vec2 shade;

out vec3 vNormal;
out float vCornerAo;
out float vHeightAboveGround;
out float vBuildingHeight;

void main() {
  vNormal = normal;
  vCornerAo = shade.x;
  vHeightAboveGround = position.z;
  vBuildingHeight = shade.y * 255.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

// The light (occlusion.ts → CityLight) and the appearance's shading split.
uniform vec3 uLightDirection;
uniform float uAmbient;
uniform float uDiffuse;

// The zoom fade, shared with the fill-extrusion layer this replaces.
uniform float uOpacity;

in vec3 vNormal;
in float vCornerAo;
in float vHeightAboveGround;
in float vBuildingHeight;

out vec4 fragColor;

void main() {
  vec3 n = normalize(vNormal);

  vec3 base = vBuildingHeight < uTallM
    ? mix(uLow, uTall, vBuildingHeight / uTallM)
    : mix(uTall, uVeryTall, clamp((vBuildingHeight - uTallM) / (uVeryTallM - uTallM), 0.0, 1.0));

  // surfaceBrightness()
  float sky = 0.5 + 0.5 * n.z;
  float lambert = max(dot(n, uLightDirection), 0.0);
  float brightness = uAmbient * (0.5 + 0.5 * sky) + uDiffuse * lambert;

  // groundOcclusion()
  float ground = ${glslFloat(AO.groundMin)}
    + ${glslFloat(1 - AO.groundMin)} * smoothstep(0.0, ${glslFloat(AO.groundReachM)}, vHeightAboveGround);

  vec3 color = base * brightness * ground * vCornerAo;

  // MapLibre blends custom layers as premultiplied alpha.
  fragColor = vec4(color * uOpacity, uOpacity);
}
`;
