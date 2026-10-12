/**
 * GLSL for the street surfaces and markings (GLSL ES 3.00, `RawShaderMaterial`
 * + `GLSL3`, as the rest of the city engine).
 *
 * - **On the drawn ground.** Each vertex reads its tile's ground grid — the
 *   SAME grid the buildings, trees and city life stand on
 *   (the engine's one `Ground`, `terrainGround.ts`, whose grids are cached and shared) — bilinearly, from a float texture,
 *   so a mesh is lifted on the GPU with no per-vertex work on the CPU. Strips
 *   are cut every few metres (`streetMesher.ts` → `STREET.stepM`) so they bend
 *   with it rather than cutting through a crest.
 * - **No z-fighting.** Coplanar layers (paving, asphalt, tints, paint) are
 *   told apart by a small depth nudge toward the camera per layer, in clip
 *   space (`uDepthBias` × layer × w) — a per-vertex polygon offset — on top of
 *   a few centimetres of lift over the ground.
 * - **Lines never vanish.** A painted line thinner than a pixel is drawn a
 *   pixel wide at proportionally less alpha (`MIN_HALF_PX`), anti-aliased by
 *   its own across-coordinate; arrows and letters are SDF (`streetAtlas.ts`).
 * - **The same light as the ground.** Unlit, like the basemap they cover; under
 *   the city sky, lit and hazed exactly as the sky's ground pass lights the
 *   basemap (`skyShaders.ts`: sun × shadow + sky, `^1/2.2`, then haze), so the
 *   streets take the buildings' shadows.
 * - **Day and night** are two palettes blended by `uNightFactor`.
 */
import { GROUND } from '../city3d/terrainGround';
import { ATLAS_SIZE, SDF_EDGE } from './streetAtlas';

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/** Lift over the ground, metres: above the terrain mesh's own interpolation error at street zooms. */
export const STREET_LIFT_M = 0.06;
/** Half a line's drawn width never goes under this many device pixels. */
export const MIN_HALF_PX = 0.6;

const GROUND_GLSL = `
uniform highp sampler2D uGround;
uniform float uGrounded;
uniform float uTileSize;
uniform float uDepthBias;
const float GRID = ${f(GROUND.grid)};

// The tile's ground grid (row-major from the north-west corner), bilinear.
float groundAt(vec2 p) {
  if (uGrounded < 0.5) return 0.0;
  vec2 uv = clamp(vec2(p.x, -p.y) / uTileSize, 0.0, 1.0) * (GRID - 1.0);
  vec2 cell = min(floor(uv), vec2(GRID - 2.0));
  vec2 t = uv - cell;
  ivec2 i = ivec2(cell);
  float a = texelFetch(uGround, i, 0).r;
  float b = texelFetch(uGround, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uGround, i + ivec2(0, 1), 0).r;
  float d = texelFetch(uGround, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
`;

/** The vertex half both meshes share: place on the ground, set the sky varyings. */
const PLACE_GLSL = (sky: boolean) => `
${sky ? 'uniform mat4 uShadowMatrix;\nuniform float uMetresPerMercator;\nout vec3 vWorld;\nout vec4 vShadow;' : ''}
vec4 place(vec3 p, float layer) {
  vec4 local = vec4(p.xy, p.z + groundAt(p.xy) + ${f(STREET_LIFT_M)}, 1.0);
  ${
    sky
      ? `vec4 world = modelMatrix * local;
  vWorld = vec3(world.x, -world.y, world.z) * uMetresPerMercator;
  vShadow = uShadowMatrix * world;`
      : ''
  }
  vec4 clip = projectionMatrix * modelViewMatrix * local;
  clip.z -= (layer + 1.0) * uDepthBias * clip.w;
  return clip;
}
`;

/** The fragment half both share: palette blend, then (sky) light and haze. */
const SHADE_GLSL = (sky: boolean, glsl: string) => `
// The sky's GLSL declares the night factor with its light; unlit, it is ours.
${sky ? glsl : 'uniform float uNightFactor;'}
${sky ? 'in vec3 vWorld;\nin vec4 vShadow;' : ''}
vec3 shade(vec3 day, vec3 night) {
  vec3 albedo = mix(day, night, clamp(uNightFactor, 0.0, 1.0));
  ${
    sky
      ? `vec3 light = uSunColor * max(uSunDir.z, 0.0) * sunVisibility(vShadow) + uSkyAmbient;
  vec3 color = albedo * pow(light, vec3(${f(1 / 2.2)}));
  vec3 toFragment = vWorld - uCamera;
  float d = length(toFragment);
  vec3 dir = toFragment / max(d, 1e-3);
  vec3 T = hazeTransmittance(max(uCamera.z - uGroundZ, 1.0), dir.z, d);
  return color * T + skyColor(vec3(dir.xy, 0.0)) * (1.0 - T);`
      : 'return albedo;'
  }
}
`;

export function surfaceShaders(sky: { glsl: string } | null): {
  vertexShader: string;
  fragmentShader: string;
} {
  return {
    vertexShader: `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
// material, shade, depth layer, —
in vec4 attr;
out float vMaterial;
out float vShade;
${GROUND_GLSL}
${PLACE_GLSL(sky !== null)}
void main() {
  vMaterial = attr.x;
  vShade = attr.y / 255.0;
  gl_Position = place(position, attr.z);
}
`,
    fragmentShader: `
precision highp float;
precision highp sampler2DShadow;
uniform vec3 uSurfaceDay[4];
uniform vec3 uSurfaceNight[4];
uniform float uFade;
in float vMaterial;
in float vShade;
out vec4 fragColor;
${SHADE_GLSL(sky !== null, sky?.glsl ?? '')}
void main() {
  // Fading in with zoom: a screen door, so depth stays exact.
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (noise >= uFade) discard;
  int m = int(vMaterial + 0.5);
  fragColor = vec4(shade(uSurfaceDay[m], uSurfaceNight[m]) * vShade, 1.0);
}
`,
  };
}

export function markingShaders(sky: { glsl: string } | null): {
  vertexShader: string;
  fragmentShader: string;
} {
  return {
    vertexShader: `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
// Device pixels per metre at the screen centre.
uniform float uPxPerM;
in vec3 position;
in vec2 offset;
in vec2 uv;
// colour, mode (0 flat, 1 line, 2 sdf), depth layer, —
in vec4 attr;
out float vColour;
out float vMode;
out vec2 vUv;
out float vHalfPx;
out float vCoverage;
${GROUND_GLSL}
${PLACE_GLSL(sky !== null)}
void main() {
  vColour = attr.x;
  vMode = attr.y;
  vUv = uv;
  vHalfPx = 1.0;
  vCoverage = 1.0;
  vec3 p = position;
  if (attr.y > 0.5 && attr.y < 1.5) {
    // A line: as wide as recorded, or a pixel and fainter; padded a pixel for its edge.
    vec4 anchor = projectionMatrix * modelViewMatrix * vec4(p.xy, p.z, 1.0);
    float pxPerM = uPxPerM * projectionMatrix[3][3] / max(anchor.w, 1e-9);
    float halfPx = length(offset) * pxPerM;
    float widen = max(1.0, ${f(MIN_HALF_PX)} / max(halfPx, 1e-6));
    vHalfPx = halfPx * widen;
    vCoverage = 1.0 / widen;
    float pad = (vHalfPx + 1.0) / vHalfPx;
    p.xy += offset * widen * pad;
    vUv = vec2(uv.x * pad, 0.0);
  }
  gl_Position = place(p, attr.z);
}
`,
    fragmentShader: `
precision highp float;
precision highp sampler2DShadow;
uniform sampler2D uAtlas;
uniform vec3 uPaintDay[5];
uniform vec3 uPaintNight[5];
uniform float uFade;
// Arrows, words and names (full detail only) fade in with it.
uniform float uDetail;
in float vColour;
in float vMode;
in vec2 vUv;
in float vHalfPx;
in float vCoverage;
out vec4 fragColor;
${SHADE_GLSL(sky !== null, sky?.glsl ?? '')}
void main() {
  float alpha;
  if (vMode < 0.5) {
    alpha = 0.85;
  } else if (vMode < 1.5) {
    alpha = clamp((1.0 - abs(vUv.x)) * vHalfPx + 0.5, 0.0, 1.0) * vCoverage;
  } else {
    float d = texture(uAtlas, vUv / ${f(ATLAS_SIZE)}).r;
    float w = max(fwidth(d) * 0.7, 1.0 / 255.0);
    alpha = smoothstep(${f(SDF_EDGE)} - w, ${f(SDF_EDGE)} + w, d) * uDetail;
  }
  alpha *= uFade * 0.92;
  if (alpha <= 0.002) discard;
  int c = int(vColour + 0.5);
  fragColor = vec4(shade(uPaintDay[c], uPaintNight[c]) * alpha, alpha);
}
`,
  };
}
