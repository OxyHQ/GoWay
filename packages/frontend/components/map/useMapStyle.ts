/**
 * Which style document a map draws: the style and the light, resolved for
 * this map (`docs/MAP_STYLES.md`). Both map adapters call it; neither reasons
 * about styles itself.
 *
 * In order:
 *
 *  1. What the screen passes. The embed passes its `style=` and `light=`
 *     (the embedder decides, never the visitor's device); `appearance` alone
 *     is the older spelling of a day or night light.
 *  2. Otherwise this device's choices (`mapFeatureStore`): the style from the
 *     layers picker, and the light from Settings → Map → Light — the app's
 *     theme (the default), the real sun over the map, or always day or night.
 *
 * Following the sun reads the sun's altitude over the settled camera — every
 * settle, and every five minutes — and changes the answer only when the light
 * does: dawn, day, dusk, night, a handful of times a day.
 */
import { useTheme } from '@oxy.so/bloom/theme';
import { useCallback, useEffect, useRef, useState } from 'react';

import { sunPosition } from '@/lib/map/sun';
import { useMapFeatures } from '@/lib/map/useMapFeatures';
import {
  lightPresetFromSun,
  type MapStyleRequest,
  type MapStyleSelection,
  resolveMapStyleRequest,
} from '@/lib/map/style/catalogue';

import type { GeoCoordinate } from './types';

export type { MapStyleRequest };

/** How often a sun-following map re-reads the sun when nobody moves it. */
export const SUN_STYLE_REFRESH_MS = 5 * 60_000;

export interface MapStyleState {
  selection: MapStyleSelection;
  /** Report the centre of a camera that has come to rest. Stable identity. */
  settle: (centre: GeoCoordinate) => void;
}

export function useMapStyle(request: MapStyleRequest, start: GeoCoordinate): MapStyleState {
  const themeDark = useTheme().isDark;
  const { style, light } = useMapFeatures();
  const { style: askedStyle, lightPreset: askedPreset, appearance: askedAppearance } = request;
  const followsSun = !askedPreset && !askedAppearance && light === 'sun';
  const centre = useRef(start);
  // The sun over the settled camera, kept only when the light it gives
  // changes, so a settle that does not change the light renders nothing.
  // Read once at mount from the opening camera (cheap, and pure).
  const [sun, setSun] = useState(() => sunPosition(new Date(), start.latitude, start.longitude));
  const decide = useCallback(
    (next: { altitudeDeg: number; azimuthDeg: number } | null) =>
      resolveMapStyleRequest(
        { style: askedStyle, lightPreset: askedPreset, appearance: askedAppearance },
        { style, light },
        themeDark,
        next,
      ),
    [askedStyle, askedPreset, askedAppearance, style, light, themeDark],
  );

  const refresh = useCallback(() => {
    const { latitude, longitude } = centre.current;
    const next = sunPosition(new Date(), latitude, longitude);
    setSun((previous) => {
      const a = lightPresetFromSun(previous);
      const b = lightPresetFromSun(next);
      return a.preset === b.preset && a.sunUp === b.sunUp ? previous : next;
    });
  }, []);

  // While the map follows the sun: re-read it now (the reading from mount may
  // be old by the time Sun is chosen) and every five minutes.
  useEffect(() => {
    if (!followsSun) return;
    const soon = setTimeout(refresh, 0);
    const timer = setInterval(refresh, SUN_STYLE_REFRESH_MS);
    return () => {
      clearTimeout(soon);
      clearInterval(timer);
    };
  }, [followsSun, refresh]);

  const settle = useCallback(
    (next: GeoCoordinate) => {
      centre.current = next;
      if (followsSun) refresh();
    },
    [followsSun, refresh],
  );

  const selection = decide(followsSun ? sun : null);
  return { selection, settle };
}
