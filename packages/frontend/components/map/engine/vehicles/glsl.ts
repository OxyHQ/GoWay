/**
 * GLSL ES 3.00 for drawing model-library geometry (`library.ts`) in a map
 * renderer's own shader — the frame change, the colours and the people's
 * vertex animation — so every consumer reads the asset profile the same way.
 * Plain strings, no three.js: a shader module may import it freely.
 *
 * A consumer declares the attributes `position`, `normal`, `color`, `paint`
 * and, for an animated person, `uniform highp sampler2D` holding
 * `createAnimationTexture`'s frames, then splices {@link LIBRARY_GLSL} in.
 */
export const LIBRARY_GLSL = `
/** glTF (+Y up, front +Z, +X left) to a map's local frame (x forward, y left, z up). */
vec3 libraryFrame(vec3 g) {
  return vec3(g.z, g.x, g.y);
}

vec3 librarySrgb(vec3 linear) {
  vec3 lo = linear * 12.92;
  vec3 hi = 1.055 * pow(max(linear, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), linear));
}

/**
 * A vertex's sRGB colour: on the tintable body the paint, shaded by the
 * kit's ramp (the vertex colour is that shade, grey); elsewhere its own.
 */
vec3 libraryColour(vec3 color, float paint, vec3 paintSrgb) {
  vec3 own = librarySrgb(color);
  return paint > 0.5 ? paintSrgb * own : own;
}

/**
 * A clip's pose for this vertex at time t seconds, from a vertex-animation
 * texture (one row per frame, one texel per vertex). clip is the
 * manifest's (first frame, frame count, frames per second); consecutive
 * frames are blended, and the loop wraps.
 */
vec3 libraryPose(highp sampler2D frames, vec3 clip, float t) {
  float f = max(t, 0.0) * clip.z;
  float i0 = mod(floor(f), clip.y);
  float i1 = mod(i0 + 1.0, clip.y);
  vec3 a = texelFetch(frames, ivec2(gl_VertexID, int(clip.x + i0)), 0).xyz;
  vec3 b = texelFetch(frames, ivec2(gl_VertexID, int(clip.x + i1)), 0).xyz;
  return mix(a, b, fract(f));
}
`;
