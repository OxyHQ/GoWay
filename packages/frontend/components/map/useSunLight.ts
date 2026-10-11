/**
 * `useSunLight` — the buildings' sun light, as state both map adapters read.
 *
 * Shared, so the forks cannot disagree about WHEN the light changes; each fork
 * only says HOW it reaches its engine (web: `map.setLight`, native: `<Map
 * light>`). The policy — the triggers, the clock, the dedupe, the fallback —
 * is `lib/map/sunLight.ts`, and this hook is the React wiring around it:
 *
 *  - The initial light is computed from the camera the map OPENS on, in the
 *    `useState` initialiser, so native's very first render already carries the
 *    sun light instead of flashing the style's static one.
 *  - `settle(centre)` is what an adapter calls when the camera comes to rest.
 *    It is stable for the component's life, so it can sit inside an engine
 *    listener without re-creating the map.
 *  - A {@link SUN_LIGHT_REFRESH_MS} interval re-reads the clock for a map left
 *    open. It is the one timer, it is cleared on unmount, and it reads the
 *    last settled centre from a ref — never the device's position.
 *
 * `light` is `null` when GoWay does not own the loaded style document (the
 * `openfreemap` escape hatch or a style-URL override, see
 * `lib/map/provider.ts` → `resolveOwnsStyleDocument`). The adapters then leave
 * the document's own light alone, and no timer runs.
 *
 * PRIVACY: the centre is the viewport's, held in a ref while the map is
 * mounted, and handed to nothing but a pure function. No permission, no
 * location API, no storage. See `lib/map/sunLight.ts`.
 */
import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type MapAppearance, resolveOwnsStyleDocument } from '@/lib/map/provider';
import { buildingsLightAt, nextBuildingsLight, SUN_LIGHT_REFRESH_MS } from '@/lib/map/sunLight';

import { isDrawableCoordinate } from './shared';
import type { GeoCoordinate } from './types';

export interface SunLight {
  /** The light to apply, or `null` to leave the style document's own alone. */
  light: LightSpecification | null;
  /** Report the centre of a camera that has come to rest. Stable identity. */
  settle: (centre: GeoCoordinate) => void;
}

export function useSunLight(appearance: MapAppearance, initialCentre: GeoCoordinate): SunLight {
  // Read once: which document is loaded is configuration (environment
  // variables inlined at build time), not something that changes under a
  // mounted map.
  const [enabled] = useState(resolveOwnsStyleDocument);
  const centre = useRef<GeoCoordinate>(initialCentre);
  const appearanceRef = useRef(appearance);

  const [light, setLight] = useState<LightSpecification | null>(() =>
    enabled ? buildingsLightAt(appearance, initialCentre, new Date()) : null,
  );

  const recompute = useCallback(() => {
    if (!enabled) return;
    const next = buildingsLightAt(appearanceRef.current, centre.current, new Date());
    // `nextBuildingsLight` hands back `previous` itself when nothing changed,
    // which is what lets React skip the render — and the engine call behind it.
    setLight((previous) => nextBuildingsLight(previous, next));
  }, [enabled]);

  // A theme change re-derives the intensity at once rather than at the next
  // settle or tick.
  useEffect(() => {
    appearanceRef.current = appearance;
    recompute();
  }, [appearance, recompute]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(recompute, SUN_LIGHT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, recompute]);

  const settle = useCallback(
    (next: GeoCoordinate) => {
      // The adapters only ever pass the engine's own centre, but the seam's
      // rule is that nothing crosses it unchecked; an undrawable centre keeps
      // the last good one rather than dropping to the fallback light.
      if (!isDrawableCoordinate(next)) return;
      centre.current = { latitude: next.latitude, longitude: next.longitude };
      recompute();
    },
    [recompute],
  );

  return { light, settle };
}
