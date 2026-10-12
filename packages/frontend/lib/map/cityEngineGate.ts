/**
 * When the map fetches and attaches the 3D city's engine (`MapCanvas.web.tsx`).
 *
 * The 3D city is on for everyone, but its chunk (three.js and the engine,
 * ~1.4 MB gz), its workers and its GPU memory are wanted only near the
 * buildings or with the horizon on screen: a visit that stays on a flat
 * country or region pays nothing for them. Once wanted, the engine stays
 * for the session. Pure, so the rule is a test (`__tests__/cityEngineGate.test.ts`).
 */

/**
 * One and a half zooms before the buildings start fading in (15.5,
 * `BUILDINGS_3D_FADE`) and where landmarks start loading, so the chunk is in
 * by the time anything of it shows.
 */
export const CITY_ENGINE_MIN_ZOOM = 14;

/** Tilted at least this far, the horizon — and the city's sky — can show at any zoom. */
export const CITY_ENGINE_MIN_PITCH = 45;

/**
 * Whether a camera wants the 3D city's engine: close to the buildings, or
 * tilted towards the sky. Measured: opening goway.to at its default view (z11,
 * flat) with the city on by default fetched three.js, the mesh and simulation
 * workers and +33 MB of JS heap for a view that draws none of it.
 */
export function cityEngineWanted(camera: { zoom: number; pitch: number }): boolean {
  return camera.zoom >= CITY_ENGINE_MIN_ZOOM || camera.pitch >= CITY_ENGINE_MIN_PITCH;
}
