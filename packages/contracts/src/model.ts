/**
 * Where a 3D model stands on the map — phase 1 of `docs/SDK_MAP_MODELS.md`.
 *
 * Only the PLACEMENT is here, because it is the only part of a model that
 * phase 1 needs and that is also wire data later (a place's model, phase 4,
 * travels as `{ asset, placement }`). The asset descriptor, the catalogue and
 * its route are phase 2 and deliberately absent: a contract added before the
 * route that serves it is a promise with nothing behind it.
 *
 * ## Frames (the note's "Frames and conventions", restated where it binds)
 *
 *  - The asset is glTF: right-handed metres, +Y up, front facing +Z, origin at
 *    the base centre. `position` is where that origin stands.
 *  - `orientation` is intrinsic yaw–pitch–roll in local East-North-Up:
 *    `heading` about up, clockwise from north (as `MapViewport.bearing`), then
 *    `pitch` about the model's right axis (nose up is positive), then `roll`
 *    about its forward axis (right side down is positive).
 *  - `altitude` is metres above the DRAWN ground: the 3D terrain where the web
 *    map draws one (docs/MAP_TERRAIN_GLOBE.md), the Mercator plane elsewhere.
 *    `'ground'` is the only reference; `'sea'` and `'ellipsoid'` are phase 5.
 *
 * ## The NaN gate
 *
 * A map receives placements from feature code and, later, from the API. Every
 * one goes through {@link parseModelPlacement} before it reaches a renderer,
 * so a non-finite number or an out-of-range angle costs that model alone —
 * never the canvas (the same rule `drawableMarkers` enforces for pins).
 */

import { z } from 'zod';

import { longitudeSchema } from './geo';

/** Only `'ground'` until GoWay has a DEM (see the header). */
export const MODEL_ALTITUDE_REFERENCES = ['ground'] as const;
export type ModelAltitudeReference = (typeof MODEL_ALTITUDE_REFERENCES)[number];

/** Lowest and highest altitude a placement may ask for, in metres. */
export const MIN_MODEL_ALTITUDE_METERS = -500;
export const MAX_MODEL_ALTITUDE_METERS = 10_000;

/**
 * The widest latitude Web Mercator can draw (`atan(sinh(π))`). A model past it
 * cannot stand where it says: the renderer would clamp its anchor to the edge
 * of the map while sizing it at the real latitude (PR #123 review). The same
 * bound the tour link and the viewport link use.
 */
export const MAX_MODEL_LATITUDE = 85.051129;

/** Largest uniform scale. An asset is authored in metres; 1000× is a city block from a brick. */
export const MAX_MODEL_SCALE = 1_000;

export const modelPlacementSchema = z.object({
  /**
   * The model's origin. GoWay's object spelling, never a positional pair, and
   * within the latitudes the map can draw.
   */
  position: z.object({
    latitude: z.number().min(-MAX_MODEL_LATITUDE).max(MAX_MODEL_LATITUDE),
    longitude: longitudeSchema,
  }),
  altitude: z
    .object({
      meters: z.number().min(MIN_MODEL_ALTITUDE_METERS).max(MAX_MODEL_ALTITUDE_METERS),
      reference: z.enum(MODEL_ALTITUDE_REFERENCES),
    })
    .default({ meters: 0, reference: 'ground' }),
  /** Degrees; see the header for the order and the axes. */
  orientation: z
    .object({
      heading: z.number().min(0).lt(360).default(0),
      pitch: z.number().min(-90).max(90).default(0),
      roll: z.number().min(-180).max(180).default(0),
    })
    .default({ heading: 0, pitch: 0, roll: 0 }),
  /** Uniform; the asset is authored in metres. */
  scale: z.number().positive().max(MAX_MODEL_SCALE).default(1),
});

/** A placement with every default applied — what a renderer draws. */
export type ModelPlacement = z.infer<typeof modelPlacementSchema>;
/** A placement as a caller writes it: altitude, orientation and scale optional. */
export type ModelPlacementInput = z.input<typeof modelPlacementSchema>;

/**
 * A placement a renderer can draw, or `null`.
 *
 * Never throws, whatever it is handed: `null` is "draw this model's fallback
 * marker instead", which is a truthful outcome, while a throw out of a render
 * path is a blank map. A heading is NOT wrapped into `[0, 360)` here — a caller
 * computing one should normalise it, and a contract that silently folded 720
 * into 0 would hide the arithmetic slip that produced it.
 */
export function parseModelPlacement(input: unknown): ModelPlacement | null {
  const parsed = modelPlacementSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
