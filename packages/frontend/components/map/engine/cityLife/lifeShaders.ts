/**
 * The city-life shaders, GLSL ES 3.00 (three prepends `#version 300 es`).
 *
 * Positions are NOT uploaded per frame. The simulation streams two states per
 * agent — the previous step and the latest — as instanced attributes, and the
 * vertex shader places each instance between them by `uAlpha`, the fraction
 * of a step the frame is at. So a 20 Hz simulation draws at the display's
 * rate with no per-frame CPU work beyond one uniform.
 *
 * People's legs swing with the distance they moved between the two states
 * (a person waiting at a kerb stands still); everything else is rigid.
 * On 3D terrain each agent stands on the drawn ground (`aGround`, sampled by
 * the renderer the way the buildings are). Lighting is a soft Lambert from the map's own light (`CityLight`, the same
 * sun as the buildings), plus a sky term, so cars and people sit in the same
 * light as the city around them.
 */
import { PART } from './models';

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

export const LIFE_VERTEX_SHADER = `
precision highp float;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uAlpha;
uniform float uTime;
uniform float uStep;
uniform float uIsPerson;
/** Cars: a style length of 1 is this many metres; the model is uModelLength long. */
uniform float uMaxLength;
uniform float uModelLength;

in vec3 position;
in vec3 normal;
in float part;
in vec4 aPrev;
in vec4 aCurr;
in vec4 aStyle;
/** Metres the ground stands above sea level here (3D terrain), else 0. */
in float aGround;

out vec3 vNormal;
out vec3 vColor;

const float PI = 3.141592653589793;

vec3 skinTone(float pick) {
  if (pick < 0.2) return vec3(0.96, 0.84, 0.74);
  if (pick < 0.4) return vec3(0.89, 0.73, 0.60);
  if (pick < 0.6) return vec3(0.76, 0.57, 0.42);
  if (pick < 0.8) return vec3(0.55, 0.39, 0.28);
  return vec3(0.38, 0.27, 0.20);
}

void main() {
  // A slot re-used by a new agent, or one that just appeared: no sweep across the map.
  bool fresh = aPrev.w == 0.0 || distance(aPrev.xy, aCurr.xy) > 40.0;
  vec2 at = fresh ? aCurr.xy : mix(aPrev.xy, aCurr.xy, uAlpha);
  float turn = mod(aCurr.z - aPrev.z + PI, 2.0 * PI) - PI;
  float heading = fresh ? aCurr.z : aPrev.z + turn * uAlpha;
  float scale = mix(aPrev.w, aCurr.w, uAlpha);

  vec3 local = position;
  vec3 n = normal;
  vec3 paint = aStyle.rgb;
  if (uIsPerson > 0.5) {
    float speed = fresh ? 0.0 : distance(aPrev.xy, aCurr.xy) / uStep;
    float gait = clamp(speed / 1.3, 0.0, 1.0);
    float phase = aStyle.a * 6.2831;
    if (part > ${f(PART.legLeft - 0.5)} && part < ${f(PART.legRight + 0.5)}) {
      float side = part < ${f(PART.legLeft + 0.5)} ? 1.0 : -1.0;
      float swing = side * sin(uTime * 2.0 * PI * 1.7 + phase) * 0.42 * gait;
      // Rotate about the hip (x forward, z up).
      vec2 xz = vec2(local.x, local.z - 0.86);
      float c = cos(swing);
      float s = sin(swing);
      local.x = c * xz.x + s * xz.y;
      local.z = -s * xz.x + c * xz.y + 0.86;
    }
    // A slight bob while walking.
    local.z += abs(sin(uTime * PI * 1.7 + phase)) * 0.03 * gait;
    if (part > ${f(PART.skin - 0.5)} && part < ${f(PART.skin + 0.5)}) vColor = skinTone(fract(aStyle.a * 7.31));
    else if (part > ${f(PART.clothes - 0.5)}) vColor = paint;
    else vColor = mix(vec3(0.18, 0.2, 0.25), paint, 0.25);
  } else {
    local.x *= (aStyle.a * uMaxLength) / uModelLength;
    if (part < ${f(PART.paint + 0.5)}) vColor = paint;
    else if (part < ${f(PART.glass + 0.5)}) vColor = mix(paint, vec3(0.2, 0.25, 0.3), 0.78);
    else vColor = vec3(0.13, 0.13, 0.14);
  }
  local *= scale;

  float c = cos(heading);
  float s = sin(heading);
  vec3 world = vec3(at.x + c * local.x - s * local.y, at.y + s * local.x + c * local.y, local.z + aGround);
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

out vec4 fragColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightPosition);
  float direct = clamp(dot(n, l), 0.0, 1.0);
  // Unlit faces keep MapLibre's (1 − intensity); the sky lifts upward faces.
  float light = mix(1.0 - uLightIntensity, 1.0, direct) + 0.08 * max(n.z, 0.0);
  fragColor = vec4(clamp(vColor * light * uLightColor, 0.0, 1.0), 1.0);
}
`;
