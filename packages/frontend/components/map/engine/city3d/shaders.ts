/**
 * GLSL helpers for the city engine's materials that are still GLSL — the
 * city sky's (`skyShaders.ts`, `osmShaders.ts` → `OSM_BASE_GLSL`, the
 * detailed look). The buildings and trees without the sky are TSL now
 * (`tsl/`, `docs/MAP_NATIVE_3D.md` → Phase 2); this file shrinks as the rest
 * of the materials follow.
 */

/** A number as a GLSL float literal (`1` → `1.0`), which GLSL ES insists on. */
export function glslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite GLSL float: ${value}`);
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}
