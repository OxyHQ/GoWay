/**
 * The city-life shaders, GLSL ES 3.00 (three prepends `#version 300 es`).
 *
 * Positions are NOT uploaded per frame. The simulation streams two states per
 * agent — the previous step and the latest — as instanced attributes, and the
 * vertex shader places each instance between them by `uAlpha`, the fraction
 * of a step the frame is at. So a 20 Hz simulation draws at the display's
 * rate with no per-frame CPU work beyond a few uniforms.
 *
 * ## Level of detail, decided per instance on the GPU
 *
 * Every model is drawn twice — its library near level (≤ 800 triangles for a
 * car, 600 for a person) and its far level (≤ 150) — over the SAME instance
 * buffers. Each instance's anchor is
 * projected and its on-screen size estimated: the centre's pixels per metre
 * (`uPxPerM`) scaled by depth (clip `w` against the centre's, which is
 * `projectionMatrix[3][3]` because the frame is centre-relative). Under
 * {@link LOD_MIN_PX} it collapses in the near mesh and draws in the far one,
 * and vice versa. No CPU sort, no second buffer.
 *
 * ## The look
 *
 * The shared model library's vehicles and people (`../vehicles/`), read with
 * its GLSL (`vehicles/glsl.ts`): the kits' fixed colours, the body in the
 * simulation's soft pastel paint. Matte maquette lighting — a gentle
 * hemisphere fill (sky above, warm ground bounce below) under the map's own
 * sun (`CityLight`, the same as the buildings) — and, drawn by
 * {@link SHADOW_VERTEX_SHADER}, a soft contact-shadow blob under every
 * vehicle and person, so they sit on the street instead of floating over it.
 *
 * People walk by vertex animation: their library frames in a texture
 * (`createAnimationTexture`), read per vertex by `gl_VertexID`, blended from
 * the idle clip to the walk as the distance they moved between the two
 * states grows — so a person waiting at a kerb idles — each at their own
 * phase. On 3D terrain each agent stands on the ground the buildings and
 * trees do (`aGround`).
 */
import { LIBRARY_GLSL } from '../vehicles/glsl';

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

/** An instance is drawn in detail only while it is at least this many CSS pixels long. */
export const LOD_MIN_PX = 22;

/** Interpolation and placement shared by the body and the shadow shaders. */
const PLACE = `
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uAlpha;
/** 0: the near mesh; 1: the far mesh; 2: the shadow (always). */
uniform float uLod;
/** CSS pixels per metre at the view centre. */
uniform float uPxPerM;
/** The model's size for the detail test, metres (a car's length, a person's height). */
uniform float uNearSize;

in vec4 aPrev;
in vec4 aCurr;
in vec4 aStyle;
/** Metres the ground stands above sea level here (3D terrain), else 0. */
in float aGround;

const float PI = 3.141592653589793;

struct Placed {
  vec2 at;
  float heading;
  float scale;
  bool fresh;
};

Placed place() {
  Placed p;
  // A slot re-used by a new agent, or one that just appeared: no sweep across the map.
  p.fresh = aPrev.w == 0.0 || distance(aPrev.xy, aCurr.xy) > 40.0;
  p.at = p.fresh ? aCurr.xy : mix(aPrev.xy, aCurr.xy, uAlpha);
  float turn = mod(aCurr.z - aPrev.z + PI, 2.0 * PI) - PI;
  p.heading = p.fresh ? aCurr.z : aPrev.z + turn * uAlpha;
  p.scale = mix(aPrev.w, aCurr.w, uAlpha);
  if (uLod < 1.5) {
    vec4 anchor = projectionMatrix * modelViewMatrix * vec4(p.at, aGround, 1.0);
    // Pixels per metre here: the centre's, scaled by depth (clip w).
    float px = uPxPerM * projectionMatrix[3][3] / max(anchor.w, 1e-9) * uNearSize;
    // Off screen (past the frustum's sides, or behind the camera) is never
    // near: a pitched view has many agents just below its bottom edge.
    bool onScreen = anchor.w > 0.0 && abs(anchor.x) < anchor.w * 1.15 && abs(anchor.y) < anchor.w * 1.15;
    bool near = onScreen && px >= ${f(LOD_MIN_PX)};
    if (near != (uLod < 0.5)) p.scale = 0.0;
  }
  return p;
}
`;

export const LIFE_VERTEX_SHADER = `
precision highp float;
precision highp sampler2D;

uniform float uTime;
uniform float uStep;
uniform float uIsPerson;
uniform float uIsTaxi;
uniform vec3 uTaxiDoors;
/** A taxi's door panels: the band of its flanks between these heights, m. */
uniform vec2 uDoorBand;
/** Cars: a style length of 1 is this many metres; the model is uModelLength long. */
uniform float uMaxLength;
uniform float uModelLength;
/** People, near level: the frames, and the clips as (first, count, fps). */
uniform sampler2D uFrames;
uniform float uAnimated;
uniform vec3 uMoveClip;
uniform vec3 uIdleClip;

in vec3 position;
in vec3 normal;
in vec3 color;
in float paint;
${PLACE}
${LIBRARY_GLSL}

out vec3 vNormal;
out vec3 vColor;
out float vGloss;

void main() {
  Placed p = place();
  vec3 g = position;
  if (uAnimated > 0.5) {
    // Walking (or wheeling) at the pace they move between the two states;
    // a person waiting at a kerb idles. Each has their own phase.
    float speed = p.fresh ? 0.0 : distance(aPrev.xy, aCurr.xy) / uStep;
    float gait = smoothstep(0.15, 0.6, speed);
    float t = uTime + aStyle.a * 10.0;
    vec3 move = libraryPose(uFrames, uMoveClip, t * clamp(speed / 1.3, 0.75, 1.25));
    vec3 idle = libraryPose(uFrames, uIdleClip, t);
    g = mix(idle, move, gait);
  }
  vec3 local = libraryFrame(g);
  vec3 n = libraryFrame(normal);
  vec3 tint = aStyle.rgb;
  vGloss = paint;
  if (uIsPerson < 0.5) {
    local.x *= (aStyle.a * uMaxLength) / uModelLength;
    // A taxi's doors: the flanks between the sills and the waist.
    if (uIsTaxi > 0.5 && paint > 0.5 && abs(n.y) > 0.55 && local.z > uDoorBand.x && local.z < uDoorBand.y) {
      tint = uTaxiDoors;
    }
  }
  vColor = libraryColour(color, paint, tint);
  local *= p.scale;

  float c = cos(p.heading);
  float s = sin(p.heading);
  vec3 world = vec3(p.at.x + c * local.x - s * local.y, p.at.y + s * local.x + c * local.y, local.z + aGround);
  vNormal = vec3(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

export const LIFE_FRAGMENT_SHADER = `
precision highp float;

uniform vec3 uLightPosition;
uniform float uLightIntensity;
uniform vec3 uLightColor;

in vec3 vNormal;
in vec3 vColor;
in float vGloss;

out vec4 fragColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightPosition);
  // Wrapped diffuse: a soft terminator, no hard dark side (matte maquette).
  float direct = clamp((dot(n, l) + 0.35) / 1.35, 0.0, 1.0);
  // Hemisphere fill: cool sky from above, a warm bounce from the street.
  vec3 sky = vec3(0.92, 0.95, 1.0);
  vec3 ground = vec3(0.78, 0.74, 0.70);
  vec3 fill = mix(ground, sky, n.z * 0.5 + 0.5);
  vec3 lit = vColor * (fill * (0.5 + 0.2 * (1.0 - uLightIntensity)) + uLightColor * direct * 0.55);
  // Paint catches a little sky at grazing angles.
  if (vGloss > 0.5) lit += vec3(0.04) * pow(max(n.z, 0.0), 4.0);
  fragColor = vec4(clamp(lit, 0.0, 1.0), 1.0);
}
`;

/** The soft contact shadow: one quad per agent, a radial blob, premultiplied. */
export const SHADOW_VERTEX_SHADER = `
precision highp float;

uniform float uMaxLength;
uniform float uModelLength;
/** The model's footprint half-extents, metres. */
uniform vec2 uHalfSize;
uniform float uIsPerson;

in vec3 position;
${PLACE}

out vec2 vUv;

void main() {
  Placed p = place();
  float lengthScale = uIsPerson > 0.5 ? 1.0 : (aStyle.a * uMaxLength) / uModelLength;
  // A little larger than the footprint, so the blob's soft edge shows round it.
  vec2 local = position.xy * uHalfSize * vec2(lengthScale * 1.12, 1.3) * p.scale;
  vUv = position.xy;
  float c = cos(p.heading);
  float s = sin(p.heading);
  vec3 world = vec3(p.at.x + c * local.x - s * local.y, p.at.y + s * local.x + c * local.y, aGround + 0.04);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

export const SHADOW_FRAGMENT_SHADER = `
precision highp float;

uniform float uShadowStrength;

in vec2 vUv;

out vec4 fragColor;

void main() {
  // A superellipse falloff: a rounded rectangle for a car, a disc for a person.
  vec2 q = abs(vUv);
  float d = pow(pow(q.x, 3.0) + pow(q.y, 3.0), 1.0 / 3.0);
  float a = uShadowStrength * (1.0 - smoothstep(0.3, 1.0, d));
  fragColor = vec4(0.0, 0.0, 0.0, a);
}
`;
