/**
 * `useSunLight` — the buildings' sun light, as state both map adapters read.
 *
 * Shared, so the forks cannot disagree about WHEN the light changes; each fork
 * only says HOW it reaches its engine (web: `map.setLight`, native: `<Map
 * light>`). The policy — the triggers, the clock, the dedupe, the fallback,
 * and which centre the light is computed over — is `lib/map/sunLight.ts`
 * (`advanceSunLight`), and this hook is the React wiring around it:
 *
 *  - The initial light is computed from the camera the map OPENS on, in the
 *    `useState` initialiser, so native's very first render already carries the
 *    sun light instead of flashing the style's static one.
 *  - `engine` / `start` name the map engine currently mounted and the camera
 *    it was BUILT at. When the adapter rebuilds its engine (web: an appearance
 *    change or a retry; native: a retry), the tracker restarts at that camera
 *    instead of keeping a centre settled on the engine that was thrown away.
 *    See `SunLightState` for the defect that rule exists to prevent.
 *  - `settle(centre)` is what an adapter calls when the camera comes to rest.
 *    It is stable for the component's life, so it can sit inside an engine
 *    listener without re-creating the map.
 *  - A {@link SUN_LIGHT_REFRESH_MS} interval re-reads the clock for a map left
 *    open. It is the one timer, it is cleared on unmount, and it reads the
 *    last settled centre — never the device's position.
 *
 * `light` is `null` when GoWay does not own the loaded style document (the
 * `openfreemap` escape hatch or a style-URL override, see
 * `lib/map/provider.ts` → `resolveOwnsStyleDocument`). The adapters then leave
 * the document's own light alone, and no timer runs.
 *
 * PRIVACY: the centre is the viewport's, held in React state while the map is
 * mounted, and handed to nothing but pure functions. No permission, no
 * location API, no storage. See `lib/map/sunLight.ts`.
 */
import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type MapAppearance, resolveOwnsStyleDocument } from '@/lib/map/provider';
import {
  advanceSunLight,
  initialSunLight,
  SUN_LIGHT_REFRESH_MS,
  type SunLightEvent,
} from '@/lib/map/sunLight';

import type { GeoCoordinate } from './types';

export interface SunLight {
  /** The light to apply, or `null` to leave the style document's own alone. */
  light: LightSpecification | null;
  /** Report the centre of a camera that has come to rest. Stable identity. */
  settle: (centre: GeoCoordinate) => void;
}

/**
 * @param appearance - the user's theme; decides only the intensity.
 * @param engine     - identity of the engine currently mounted. Must change
 *                     whenever the adapter builds a new one.
 * @param start      - the camera centre that engine was built at.
 */
export function useSunLight(
  appearance: MapAppearance,
  engine: string,
  start: GeoCoordinate,
): SunLight {
  // Read once: which document is loaded is configuration (environment
  // variables inlined at build time), not something that changes under a
  // mounted map.
  const [enabled] = useState(resolveOwnsStyleDocument);
  const [state, setState] = useState(() => initialSunLight(appearance, engine, start, new Date()));
  const appearanceRef = useRef(appearance);

  const dispatch = useCallback(
    (event: SunLightEvent) => {
      if (!enabled) return;
      // `advanceSunLight` hands back the previous state itself when nothing
      // changed, which is what lets React skip the render — and the engine
      // call behind it.
      setState((previous) => advanceSunLight(previous, event, appearanceRef.current, new Date()));
    },
    [enabled],
  );

  // A new engine restarts the tracker at its starting camera; a theme change
  // re-derives the intensity at once rather than at the next settle or tick.
  // Both are one event: the tracker tells the two apart by the engine id.
  //
  // `start` is read when `engine` changes and not otherwise — it is the camera
  // the engine was BUILT at, and the adapters' `initialViewport` is initial by
  // contract, so re-firing on a new object identity would only recompute.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `start` is only meaningful together with a new `engine`; see above
  useEffect(() => {
    appearanceRef.current = appearance;
    dispatch({ type: 'engine', engine, start });
  }, [appearance, engine, dispatch]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => dispatch({ type: 'tick' }), SUN_LIGHT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, dispatch]);

  const settle = useCallback(
    (centre: GeoCoordinate) => dispatch({ type: 'settle', centre }),
    [dispatch],
  );

  return { light: enabled ? state.light : null, settle };
}
