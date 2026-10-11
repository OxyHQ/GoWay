/**
 * The compact credit's state for one map (`lib/map/compactCredit.ts`): spelled
 * out from the moment the map has loaded, folded after five seconds or at the
 * reader's first pan, zoom or tap, and opened again from its ⓘ.
 *
 * `MapCanvas` (both forks) owns it: it calls `noteInteraction` from the
 * engine's USER-sourced moves and taps only — a camera the app moved is not
 * the reader having seen the credit — and renders `MapAttribution` from
 * `expanded`/`toggle`. `noteInteraction` is cheap to call on every frame of a
 * drag (see below).
 */
import { useCallback, useEffect, useReducer } from 'react';

import {
  CREDIT_AUTO_COLLAPSE_MS,
  creditReducer,
  INITIAL_CREDIT_STATE,
} from '@/lib/map/compactCredit';

export interface CompactCredit {
  expanded: boolean;
  toggle: () => void;
  noteInteraction: () => void;
}

export function useCompactCredit(loaded: boolean): CompactCredit {
  const [state, dispatch] = useReducer(creditReducer, INITIAL_CREDIT_STATE);

  // The five seconds run from the map being DRAWN, not from the component
  // mounting: a slow style must not spend the reader's time with the credit.
  useEffect(() => {
    if (!loaded || !state.auto) return undefined;
    const timer = setTimeout(() => dispatch({ type: 'elapsed' }), CREDIT_AUTO_COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [loaded, state.auto]);

  const toggle = useCallback(() => dispatch({ type: 'toggle' }), []);
  // Once folded, the reducer returns the SAME state for an interaction, and
  // React bails out of it without rendering — so every frame of a drag is free.
  const noteInteraction = useCallback(() => dispatch({ type: 'mapInteraction' }), []);

  return { expanded: state.expanded, toggle, noteInteraction };
}
