/**
 * `nightFactor` — how much of NIGHT the landmark models are lit for, 0 (day)
 * … 1 (night): the one input of their night look
 * (`components/map/engine/city3d/modelLook.ts`): windows, crowns, lanterns
 * and torches on, a warm floodlight wash on the stone, the sky light blue.
 * That glow is STYLING — the Apple-like night map — not a record of which
 * lights a building really has (`docs/MAP_LANDMARKS.md` → Night).
 *
 * The city sky (`feat/city-sky`) exposes a `nightFactor` with the same name
 * and meaning, derived from the sun over the view; until it lands this is the
 * PLACEHOLDER with that semantics, and the two unify on rebase:
 *
 *  - given the sun's altitude, the night sky's own fade — full day above −1°,
 *    full night below −9° (the sky's `NIGHT_SKY_FADE_DEG`) — and never less
 *    than night on a dark map;
 *  - without one, the appearance alone: the dark map is the night map.
 *
 * The map adapter hands the result to the engine
 * (`City3dHandle.setNightFactor`), which a time-of-day control may override.
 */
import type { MapAppearance } from '../provider';

/** The night sky's fade, sun altitude in degrees: [day ends, night is full]. */
export const NIGHT_FADE_DEG: readonly [number, number] = [-1, -9];

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export function nightFactor(input: {
  appearance: MapAppearance;
  /** The sun's altitude over the view, degrees; absent: decided by appearance alone. */
  sunAltitudeDeg?: number;
}): number {
  if (input.appearance === 'dark') return 1;
  const altitude = input.sunAltitudeDeg;
  if (altitude === undefined || !Number.isFinite(altitude)) return 0;
  return smoothstep(NIGHT_FADE_DEG[0], NIGHT_FADE_DEG[1], altitude);
}
