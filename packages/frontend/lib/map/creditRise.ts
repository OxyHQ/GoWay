/**
 * How much room the map's data credit takes at the bottom-right, and how far
 * the chrome floating above it — "My location", the location notice, the
 * time-of-day scrubber — must rise when the credit is taller than one line.
 *
 * The chrome is laid out {@link MAP_CREDIT_CLEARANCE} above the bottom edge:
 * room for the credit FOLDED, or spelled out on one line. Spelled out on a
 * phone it wraps — the sources, the official building data while it is drawn,
 * and the simulation's label while traffic is (`docs/MAP_CITY_LIFE.md` →
 * Honesty) — so the credit measures itself (`MapAttribution`, through
 * `components/map/creditHeight.ts`) and the chrome rises by
 * {@link creditRise} of that height: the two never overlap, whatever the
 * credit says. Folded, the rise is zero and nothing moves.
 *
 * A worklet, so the UI thread runs exactly what `__tests__/creditRise.test.ts`
 * checks.
 */

/** Between the credit and the edge below it. */
export const CREDIT_GAP = 4;

/** Between the top of the credit and the chrome above it. */
export const CREDIT_BREATHING = 8;

/**
 * How much of the bottom-right the credit occupies above the bottom edge: its
 * gap, one caption line on its plate, and room to breathe. Bottom-right chrome
 * a screen floats there starts above it, plus {@link creditRise}.
 */
export const MAP_CREDIT_CLEARANCE = 36;

/** px the chrome above the credit rises for a credit plate this tall. */
export function creditRise(plateHeight: number): number {
  'worklet';
  if (!(plateHeight > 0)) return 0;
  return Math.max(0, CREDIT_GAP + plateHeight + CREDIT_BREATHING - MAP_CREDIT_CLEARANCE);
}
