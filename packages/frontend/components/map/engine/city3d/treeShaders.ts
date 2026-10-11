/**
 * The instanced-tree shader, as GLSL ES 3.00 source strings.
 *
 * Every tree is ONE instance of a shared unit tree (`treeGeometry.ts`); its
 * whole placement happens here, in the vertex shader, from four 16-bit
 * numbers per tree (`trees.ts` → `TreeInstances`): position in tile units,
 * a seed, and kind + height. Turning, sizing and tinting thousands of trees
 * therefore costs the CPU nothing per frame — the technique both reference
 * projects use for their crowds of small things (Procedural Tokyo's birds,
 * Valdrada's street trees).
 *
 * The look is a maquette's: matte, soft, no highlight. Lit like the buildings
 * (`shaders.ts`) — MapLibre's `fill-extrusion` formula under the map's own
 * light, so trees and buildings agree about the sun — with a gentle occlusion
 * that darkens a canopy's underside and lightens its crown, and a faint
 * contact shadow on the ground under each tree. A few tint and size variants
 * come from the seed, so a wood is not a field of clones.
 */
import { AO } from './occlusion';
import { glslFloat } from './shaders';
import { DITHER_DISCARD_GLSL, DITHER_GLSL } from './transitions';
import { CANOPY, SHADOW, SHADOW_RADIUS, STEM } from './treeGeometry';
import { KIND_CONIFER, KIND_PALM, KIND_WOOD } from './trees';

/** How dark the contact shadow is at its centre (alpha over the ground). */
export const TREE_SHADOW_ALPHA = 0.22;

/**
 * The height below which trees are not drawn, metres, at a zoom: the tallest
 * trees show first as the map zooms in, all of them from zoom 18 (the
 * exploretrees / Apple Maps rule, eased: trees grow in over 3 m, never pop).
 * Mirrored by `uTreeMinHeight` in the vertex shader; tested.
 */
export function treeMinHeightM(zoom: number): number {
  return Math.max(0, Math.min(1, (18 - zoom) / 2.5)) * 10;
}

export const TREE_VERTEX_SHADER = `
precision highp float;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
// Metres per stored x/y unit of this tile.
uniform float uUnitM;
// Trees shorter than this are not drawn (treeMinHeightM).
uniform float uTreeMinHeight;

in vec3 position;
in vec3 normal;
// 0 trunk, 1 canopy, 2 contact shadow (treeGeometry.ts).
in float part;
// x, y (tile units, y southward), seed, kind × 256 + height in half metres.
in vec4 aTree;
// On 3D terrain: the ground under the tree, metres (terrainGround.ts, via
// cityMeshes.ts → groundTileFor). Read only while uGrounded is set.
in float aGround;
uniform float uGrounded;

out vec3 vNormal;
out float vPart;
out float vHeight;
out float vCrown;
out float vRadial;
out vec3 vTint;
out float vConifer;

void main() {
  float seed = aTree.z / 65536.0;
  float kind = floor(aTree.w / 256.0);
  float height = (aTree.w - kind * 256.0) * 0.5;
  float conifer = mod(floor(kind / ${glslFloat(KIND_CONIFER)}), 2.0);
  float palm = mod(floor(kind / ${glslFloat(KIND_PALM)}), 2.0);
  float wood = mod(kind, ${glslFloat(KIND_WOOD * 2)});
  float yaw = seed * 6.2831853;
  // Canopies vary in width as well as height.
  float width = 0.86 + 0.3 * fract(seed * 7.31);
  float c = cos(yaw);
  float s = sin(yaw);
  vec3 p = position;
  vec3 n = normal;
  if (part > ${glslFloat(CANOPY - 0.5)} && part < ${glslFloat(CANOPY + 0.5)}) {
    p.xy *= width;
    n.xy /= width;
  }
  // A slight curve: the trunk leans away from vertical toward its top, and
  // the canopy rides on it. Palms lean more.
  if (part < ${glslFloat(CANOPY + 0.5)}) {
    float lean = (palm > 0.5 ? 0.12 : 0.04) * (0.4 + 0.6 * fract(seed * 3.17));
    float t = min(1.0, position.z / ${glslFloat(STEM.top)});
    p.x += lean * t * t;
  }
  // Shorter than the zoom's threshold: shrink away over 3 m, then vanish.
  float grow = smoothstep(uTreeMinHeight - 1.5, uTreeMinHeight + 1.5, height);
  vec3 local = vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z) * height * grow;
  vNormal = vec3(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
  vPart = part;
  vHeight = local.z;
  // 0 at the canopy's foot, 1 at its top: the gentle top-lit gradient.
  vCrown = clamp((position.z - 0.2) / 0.8, 0.0, 1.0);
  vRadial = length(position.xy) / ${glslFloat(SHADOW_RADIUS)};
  // A few tint variants: lighter or darker, a touch warmer or cooler; woods a
  // shade deeper than park trees.
  float shade = (wood > 0.5 ? 0.92 : 1.0) * (0.9 + 0.2 * fract(seed * 13.7));
  float warmth = fract(seed * 5.31) - 0.5;
  vTint = shade * vec3(1.0 + 0.04 * warmth, 1.0 + 0.02 * warmth, 1.0 - 0.05 * warmth);
  vConifer = conifer + 2.0 * palm;
  vec3 base = vec3(aTree.x * uUnitM, -aTree.y * uUnitM, uGrounded > 0.5 ? aGround : 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(base + local, 1.0);
}
`;

export const TREE_FRAGMENT_SHADER = `
precision highp float;

uniform vec3 uCrown;
uniform vec3 uConifer;
uniform vec3 uTrunk;
uniform vec3 uLightPosition;
uniform float uLightIntensity;
uniform vec3 uLightColor;
uniform float uOpacity;

in vec3 vNormal;
in float vPart;
in float vHeight;
in float vCrown;
in float vRadial;
in vec3 vTint;
in float vConifer;

out vec4 fragColor;

${DITHER_GLSL}
void main() {
  ${DITHER_DISCARD_GLSL}
  // The contact shadow: premultiplied black, fading to nothing at its rim.
  if (vPart > ${glslFloat(SHADOW - 0.5)}) {
    float alpha = ${glslFloat(TREE_SHADOW_ALPHA)} * (1.0 - smoothstep(0.15, 1.0, vRadial));
    fragColor = vec4(vec3(0.0), alpha * uOpacity);
    return;
  }
  vec3 n = normalize(vNormal);
  bool isCanopy = vPart > ${glslFloat(CANOPY - 0.5)};
  // vConifer: 0 broadleaf, 1 conifer, 2 palm (a lighter, warmer green).
  vec3 canopyColour = vConifer > 1.5
    ? uCrown * vec3(1.06, 1.05, 0.86)
    : vConifer > 0.5 ? uConifer : uCrown;
  vec3 base = isCanopy ? canopyColour * vTint : uTrunk;

  // extrusionDirectional() — MapLibre's fill-extrusion lighting.
  float luminance = dot(base, vec3(0.2126, 0.7152, 0.0722));
  float d = clamp(dot(n, uLightPosition), 0.0, 1.0);
  float directional = mix(1.0 - uLightIntensity, max(1.0 - luminance + uLightIntensity, 1.0), d);

  // Soft occlusion: a canopy's underside sees less sky and its crown more; a
  // trunk is mostly in its canopy's shade, darkest at the ground.
  float occlusion = isCanopy
    ? mix(${glslFloat(AO.groundMin + 0.1)}, 1.0, smoothstep(-0.6, 0.55, n.z)) * mix(0.9, 1.05, vCrown)
    : ${glslFloat(AO.groundMin)} + 0.2 * smoothstep(0.0, 3.0, vHeight);
  directional *= occlusion;

  vec3 color = clamp(
    (base + 0.03) * directional * uLightColor,
    mix(vec3(0.0), vec3(0.3), vec3(1.0) - uLightColor),
    vec3(1.0)
  );
  fragColor = vec4(color * uOpacity, uOpacity);
}
`;
