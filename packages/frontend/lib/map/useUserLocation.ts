/**
 * Contextual, non-persisted device location.
 *
 * GoWay's privacy rule (AGENTS.md → Privacy, issue #2 → "Location privacy",
 * issue #7 → "Privacy UX") is two statements that this hook is the enforcement
 * point for:
 *
 *  1. **Opening the map never asks.** Nothing here runs on mount. The
 *     permission is not even READ until the user invokes a location-dependent
 *     action, so there is no code path from "app cold-started" to a system
 *     prompt. `MapCanvas` correspondingly refuses to show the location dot
 *     unless permission is already granted.
 *  2. **The coordinate is transient.** It lives in React state for the life of
 *     the screen and is written to no store, no cache, no query key, no
 *     AsyncStorage and no backend table. There is deliberately no "last known
 *     location" to restore: a location history is exactly the artefact the rule
 *     forbids, and the cheapest way not to have one is not to have a writer.
 */
import { useCallback, useRef, useState } from 'react';
import * as Location from 'expo-location';

import type { GeoCoordinate } from '@/components/map/types';

export type LocationPermissionStatus =
  /** Not asked yet in this session — and not asked ON OUR BEHALF at mount. */
  | 'unknown'
  | 'granted'
  | 'denied';

export type LocationErrorReason = 'denied' | 'unavailable' | 'timeout';

export interface UserLocationState {
  status: LocationPermissionStatus;
  /** Last fix, for this screen only. Never persisted. */
  coordinate: GeoCoordinate | null;
  isLocating: boolean;
  error: LocationErrorReason | null;
}

export interface UserLocationApi extends UserLocationState {
  /**
   * Ask (if needed) and locate, in that order, as one user-initiated action.
   *
   * Resolves `null` when the user declines or no fix is available — callers
   * render the decline as a normal, non-blocking outcome rather than a failure
   * of the app.
   */
  locate: () => Promise<GeoCoordinate | null>;
  /** Drop the fix from memory (e.g. when leaving a directions flow). */
  forget: () => void;
}

/** How long to wait for a fix before giving the user their UI back. */
const FIX_TIMEOUT_MS = 12_000;

export function useUserLocation(): UserLocationApi {
  const [state, setState] = useState<UserLocationState>({
    status: 'unknown',
    coordinate: null,
    isLocating: false,
    error: null,
  });

  // Coalesce concurrent taps onto one permission prompt + one fix.
  const inFlight = useRef<Promise<GeoCoordinate | null> | null>(null);

  const locate = useCallback(async (): Promise<GeoCoordinate | null> => {
    if (inFlight.current) return inFlight.current;

    const run = (async (): Promise<GeoCoordinate | null> => {
      setState((prev) => ({ ...prev, isLocating: true, error: null }));
      try {
        // Read first: `getForegroundPermissionsAsync` never prompts, so an
        // already-granted user is not re-asked, and a previously-denied one is
        // not re-prompted on every tap on platforms that would allow it.
        let permission = await Location.getForegroundPermissionsAsync();
        if (!permission.granted && permission.canAskAgain) {
          permission = await Location.requestForegroundPermissionsAsync();
        }

        if (!permission.granted) {
          setState({
            status: 'denied',
            coordinate: null,
            isLocating: false,
            error: 'denied',
          });
          return null;
        }

        const position = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          FIX_TIMEOUT_MS,
        );

        if (!position) {
          setState((prev) => ({
            ...prev,
            status: 'granted',
            isLocating: false,
            error: 'timeout',
          }));
          return null;
        }

        const coordinate: GeoCoordinate = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        setState({ status: 'granted', coordinate, isLocating: false, error: null });
        return coordinate;
      } catch {
        // A thrown error here is "the device could not produce a fix" —
        // services off, web geolocation blocked, no provider. It is not a
        // permission decision, so the status is left alone.
        setState((prev) => ({ ...prev, isLocating: false, error: 'unavailable' }));
        return null;
      } finally {
        inFlight.current = null;
      }
    })();

    inFlight.current = run;
    return run;
  }, []);

  const forget = useCallback(() => {
    setState((prev) => ({ ...prev, coordinate: null, error: null }));
  }, []);

  return { ...state, locate, forget };
}

/** Resolve `null` instead of hanging forever on a device that never fixes. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
