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
 *
 * ## Failing usefully
 *
 * `locate()` resolves `null` for four DIFFERENT reasons, and the difference is
 * the whole product: "you declined", "your browser will not even ask any more",
 * "this page is not https" and "the device could not get a fix" need four
 * different sentences and three different next steps. The reason is therefore
 * part of the state (`error`), alongside whether asking again could plausibly
 * prompt (`canAskAgain`) — a caller that shows a spinner and then nothing is
 * the bug this hook exists to make impossible to write by accident.
 *
 * ## Web, where `expo-location` is not enough
 *
 * Two web behaviours are corrected here rather than reported as-is:
 *
 *  - **A non-secure context.** `navigator.geolocation` EXISTS on an `http://`
 *    page; it just fails every call with `PERMISSION_DENIED` without ever
 *    prompting. Reported verbatim that is "the user declined", which is a lie
 *    about a person who was never asked — and it sends them to look for a
 *    permission they never set. `window.isSecureContext` is the reliable
 *    signal, and it is checked BEFORE anything touches the permission.
 *  - **A durable block.** `expo-location`'s web backend answers `canAskAgain:
 *    true` unconditionally, including for an origin the browser has blocked, so
 *    "ask again" silently resolves to the same denial forever. The Permissions
 *    API knows the truth, so it is consulted directly.
 */
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';

import type { GeoCoordinate } from '@/components/map/types';

export type LocationPermissionStatus =
  /** Not asked yet in this session — and not asked ON OUR BEHALF at mount. */
  | 'unknown'
  | 'granted'
  | 'denied';

export type LocationErrorReason =
  /** The user was asked and said no (or the browser has blocked this origin). */
  | 'denied'
  /** Permission is fine; no position came back. Services off, no provider. */
  | 'unavailable'
  /** Permission is fine; nothing answered within {@link FIX_TIMEOUT_MS}. */
  | 'timeout'
  /**
   * Web only, and NOT a permission decision: the page is not a secure context,
   * so the browser refuses geolocation without prompting. Unrecoverable by
   * retrying — only by loading the same app over https.
   */
  | 'insecureContext';

export interface UserLocationState {
  status: LocationPermissionStatus;
  /** Last fix, for this screen only. Never persisted. */
  coordinate: GeoCoordinate | null;
  isLocating: boolean;
  error: LocationErrorReason | null;
  /**
   * Whether invoking {@link UserLocationApi.locate} again could still produce a
   * system prompt. `false` means the answer is durable and the only way back is
   * the platform's own permission control — so an "allow location" button would
   * be a button that does nothing.
   */
  canAskAgain: boolean;
}

export interface UserLocationApi extends UserLocationState {
  /**
   * Ask (if needed) and locate, in that order, as one user-initiated action.
   *
   * Resolves `null` when the user declines or no fix is available. A caller
   * that ignores the `null` MUST still react to {@link UserLocationState.error},
   * which is set before this resolves: every failure here is silent otherwise.
   */
  locate: () => Promise<GeoCoordinate | null>;
  /** Drop the fix from memory (e.g. when leaving a directions flow). */
  forget: () => void;
}

/** How long to wait for a fix before giving the user their UI back. */
const FIX_TIMEOUT_MS = 12_000;

const INITIAL: UserLocationState = {
  status: 'unknown',
  coordinate: null,
  isLocating: false,
  error: null,
  canAskAgain: true,
};

export function useUserLocation(): UserLocationApi {
  const [state, setState] = useState<UserLocationState>(INITIAL);

  // Coalesce concurrent taps onto one permission prompt + one fix.
  const inFlight = useRef<Promise<GeoCoordinate | null> | null>(null);

  const locate = useCallback(async (): Promise<GeoCoordinate | null> => {
    if (inFlight.current) return inFlight.current;

    const run = (async (): Promise<GeoCoordinate | null> => {
      setState((prev) => ({ ...prev, isLocating: true, error: null }));
      try {
        // Before the permission, not after it: an http:// page never reaches a
        // prompt, so attributing the failure to the user would be wrong AND
        // would point them at a setting that is not the problem.
        if (isInsecureWebContext()) {
          setState({
            status: 'unknown',
            coordinate: null,
            isLocating: false,
            error: 'insecureContext',
            canAskAgain: false,
          });
          return null;
        }

        // The browser's own record of this origin, which `expo-location` does
        // not surface. `denied` here means no prompt will appear, whatever we
        // call next.
        if ((await webPermissionState()) === 'denied') {
          setState({
            status: 'denied',
            coordinate: null,
            isLocating: false,
            error: 'denied',
            canAskAgain: false,
          });
          return null;
        }

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
            canAskAgain: await canAskAgainAfterDenial(permission.canAskAgain),
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
            canAskAgain: true,
          }));
          return null;
        }

        const coordinate: GeoCoordinate = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        setState({ status: 'granted', coordinate, isLocating: false, error: null, canAskAgain: true });
        return coordinate;
      } catch (error) {
        // Web rejects with a `GeolocationPositionError`, which still separates
        // "you declined" from "the device has no position" from "it timed out".
        // Collapsing all three into one sentence is how a user ends up told to
        // check a permission that was never the problem.
        const reason = reasonForThrown(error);
        const canAskAgain = reason === 'denied' ? await canAskAgainAfterDenial(true) : true;
        setState((prev) => ({
          ...prev,
          status: reason === 'denied' ? 'denied' : prev.status,
          isLocating: false,
          error: reason,
          canAskAgain,
        }));
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

/**
 * `true` on a web page the browser will not give geolocation to at all.
 *
 * Checked rather than inferred: the failure an insecure origin produces is
 * indistinguishable, at the call site, from a user pressing "Block".
 */
function isInsecureWebContext(): boolean {
  if (Platform.OS !== 'web') return false;
  if (typeof window === 'undefined') return false;
  // `undefined` (an old browser that has no such property) is NOT a failure —
  // only an explicit `false` is.
  return window.isSecureContext === false;
}

/**
 * The browser's durable answer for this origin, or `'unknown'` off web and
 * wherever the Permissions API is absent (older Safari, some webviews).
 *
 * Deliberately never PROMPTS: `query()` is a read, which is what makes it safe
 * to call on the way into a user-initiated action.
 */
async function webPermissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  if (Platform.OS !== 'web') return 'unknown';
  try {
    const permissions = globalThis.navigator?.permissions;
    if (!permissions?.query) return 'unknown';
    const status = await permissions.query({ name: 'geolocation' as PermissionName });
    return status.state === 'granted' || status.state === 'denied' || status.state === 'prompt'
      ? status.state
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * After a decline, whether a further tap could still reach a prompt.
 *
 * On native the platform's own `canAskAgain` is the answer. On web it is
 * hard-coded `true` by `expo-location`, so the Permissions API is re-read: a
 * decline the browser has turned into a block for this origin flips to `denied`
 * immediately, and offering "Try again" for that would be offering a button
 * that provably does nothing.
 */
async function canAskAgainAfterDenial(platformAnswer: boolean): Promise<boolean> {
  if (Platform.OS !== 'web') return platformAnswer;
  const state = await webPermissionState();
  // `'unknown'` (no Permissions API) keeps the optimistic answer: a browser
  // that cannot tell us should not have us telling the user it is hopeless.
  return state !== 'denied';
}

/** A thrown geolocation failure, mapped onto the reason a user can act on. */
function reasonForThrown(error: unknown): LocationErrorReason {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number') {
    // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT — the W3C codes,
    // written out because `GeolocationPositionError` is a web-only global and
    // this module also runs on native.
    if (code === 1) return 'denied';
    if (code === 3) return 'timeout';
    return 'unavailable';
  }
  return 'unavailable';
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
