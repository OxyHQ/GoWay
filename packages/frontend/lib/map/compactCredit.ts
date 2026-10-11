/**
 * When the map's data credit is spelled out and when it is folded into an ⓘ
 * button — the OSMF Attribution Guidelines' compact form
 * (https://osmfoundation.org/wiki/Licence/Attribution_Guidelines): the credit
 * is VISIBLE when the map loads, and may collapse once the reader has had it —
 * after {@link CREDIT_AUTO_COLLAPSE_MS}, or at their first interaction with
 * the map (pan, zoom, rotate, tap) — into a control in the same corner that
 * shows it again.
 *
 * Pure, so "visible at load, collapsed only by those triggers" is a test
 * (`__tests__/compactCredit.test.ts`). The hook that runs it is
 * `components/map/useCompactCredit.ts`; `MapCanvas` (both forks) feeds it and
 * renders `MapAttribution` from it, with no prop to turn the credit off.
 */

/** How long the credit stays spelled out after the map has loaded. */
export const CREDIT_AUTO_COLLAPSE_MS = 5000;

export type CreditEvent =
  /** {@link CREDIT_AUTO_COLLAPSE_MS} have passed since the map loaded. */
  | { type: 'elapsed' }
  /** The reader moved or tapped the map (never a move the app made). */
  | { type: 'mapInteraction' }
  /** The reader pressed the ⓘ (or the credit's own collapse control). */
  | { type: 'toggle' };

export interface CreditState {
  expanded: boolean;
  /**
   * Still in the opening period, where the timer may fold it. Once the reader
   * has pressed the control or touched the map, only they decide.
   */
  auto: boolean;
}

export const INITIAL_CREDIT_STATE: CreditState = { expanded: true, auto: true };

export function creditReducer(state: CreditState, event: CreditEvent): CreditState {
  switch (event.type) {
    case 'elapsed':
      // A credit the reader opened themselves is not folded under them.
      return state.auto ? { expanded: false, auto: false } : state;
    case 'mapInteraction':
      // Back to the map: the credit gets out of the way (and stays reachable).
      return state.expanded || state.auto ? { expanded: false, auto: false } : state;
    case 'toggle':
      return { expanded: !state.expanded, auto: false };
  }
}
