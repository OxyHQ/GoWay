/**
 * GLSL ES 3.00 for drawing model-library geometry (`library.ts`) in a map
 * renderer's own shader — the frame change and the colours —
 * so every consumer reads the asset profile the same way.
 * Plain strings, no three.js: a shader module may import it freely.
 *
 * A consumer declares the attributes `position`, `normal`, `color` and
 * `paint`, then splices {@link LIBRARY_GLSL} in.
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
`;
