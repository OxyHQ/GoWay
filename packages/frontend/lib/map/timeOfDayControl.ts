/**
 * When the time-of-day scrubber is open, and what time the map is lit for
 * (`docs/MAP_FEATURES.md` → "The time of day").
 *
 * The scrubber is hidden by default and opened on demand — by the sun in the
 * explore screen's top-right stack, or Settings → Map → "Change time…" — and
 * only while the city sky draws: there is no time of day to change without
 * it. Closing it, by any way, goes back to NOW, and so does the sky going
 * away: the map is never lit for another time without the control on screen
 * that says so.
 *
 * Pure, so those rules are a test (`__tests__/timeOfDayControl.test.ts`).
 * `ExploreScreen` runs the reducer; `MapCanvas.web.tsx` reads `litInstant`.
 */

export interface TimeOfDayControlState {
  /** The person asked for the scrubber. */
  open: boolean;
  /** The city sky is drawn (`MapCanvas`'s `onSkyActiveChange`). */
  skyDrawn: boolean;
}

export type TimeOfDayEvent =
  /** The sun button: open, or close again. */
  | { type: 'toggle' }
  /** Settings → Map → "Change time…". */
  | { type: 'open' }
  /** The scrubber's × or Escape. */
  | { type: 'close' }
  /** The sky started or stopped drawing. */
  | { type: 'sky'; drawn: boolean };

export const INITIAL_TIME_OF_DAY: TimeOfDayControlState = { open: false, skyDrawn: false };

export function timeOfDayReducer(
  state: TimeOfDayControlState,
  event: TimeOfDayEvent,
): TimeOfDayControlState {
  switch (event.type) {
    case 'toggle':
      return state.skyDrawn ? { ...state, open: !state.open } : state;
    case 'open':
      return state.skyDrawn && !state.open ? { ...state, open: true } : state;
    case 'close':
      return state.open ? { ...state, open: false } : state;
    case 'sky':
      if (event.drawn === state.skyDrawn) return state;
      // No sky, nothing to set: closed, and so back to now.
      return event.drawn ? { ...state, skyDrawn: true } : { open: false, skyDrawn: false };
  }
}

/** The sun button is in the stack only while there is a sky to set. */
export function timeOfDayButtonShown(state: TimeOfDayControlState): boolean {
  return state.skyDrawn;
}

/**
 * The instant the map is lit for: what the scrubber chose while it is shown,
 * otherwise `null` — now.
 */
export function litInstant(shown: boolean, chosen: Date | null): Date | null {
  return shown ? chosen : null;
}
