/**
 * Guided navigation: follows a traveller along the planned route.
 *
 * It does not own a position. The map canvas is the one observer of the
 * device's position (`MapCanvasProps.onUserFix`), and the screen hands the fix
 * here; guidance is arithmetic on it (`guidance.ts`). Starting is a user action
 * that has already asked for the location — nothing here prompts.
 *
 * Leaving the route is not one noisy fix: it takes {@link OFF_ROUTE_FIXES}
 * consecutive fixes beyond the tolerance, and a re-plan is not asked for more
 * than once per {@link REROUTE_COOLDOWN_MS}. The new origin is the fix the
 * device already reported (`rerouteFrom`), so a re-plan never prompts either.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoCoordinate, Route } from '@goway.to/sdk';
import type { NavigationBannerState } from '@oxy.so/bloom/navigation-banner';

import type { UserFix } from '@/lib/map/userPuck';

import { type Guidance, guidanceAt } from './guidance';
import type { RouteStep } from './maneuvers';

/** Consecutive fixes beyond the tolerance before the traveller is off route. */
export const OFF_ROUTE_FIXES = 2;
/** The least time between two re-plans. */
export const REROUTE_COOLDOWN_MS = 8_000;

export interface GuidanceOptions {
  route: Route | null;
  steps: readonly RouteStep[];
  /** The device's position, or `null` while it has none. */
  fix: UserFix | null;
  /** A route request is in flight. */
  routeBusy: boolean;
  rerouteFrom: (coordinate: GeoCoordinate) => void;
}

export interface GuidanceController {
  guiding: boolean;
  start: () => void;
  end: () => void;
  /** `null` until there is a route, steps and a fix. */
  guidance: Guidance | null;
  state: NavigationBannerState;
}

export function useGuidance({
  route,
  steps,
  fix,
  routeBusy,
  rerouteFrom,
}: GuidanceOptions): GuidanceController {
  const [guiding, setGuiding] = useState(false);

  const guidance = useMemo(
    () => (guiding && route && fix ? guidanceAt(route, steps, fix) : null),
    [guiding, route, steps, fix],
  );

  const offRouteFixes = useRef(0);
  const lastReroute = useRef(Number.NEGATIVE_INFINITY);

  // A different route is a different line to be off.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route's identity is the trigger
  useEffect(() => {
    offRouteFixes.current = 0;
  }, [route?.id]);

  useEffect(() => {
    if (!guidance || !fix) return;
    if (!guidance.offRoute || guidance.arrived) {
      offRouteFixes.current = 0;
      return;
    }
    offRouteFixes.current += 1;
    if (offRouteFixes.current < OFF_ROUTE_FIXES || routeBusy) return;
    const now = Date.now();
    if (now - lastReroute.current < REROUTE_COOLDOWN_MS) return;
    lastReroute.current = now;
    rerouteFrom({ latitude: fix.latitude, longitude: fix.longitude });
  }, [guidance, fix, routeBusy, rerouteFrom]);

  const start = useCallback(() => {
    offRouteFixes.current = 0;
    setGuiding(true);
  }, []);
  const end = useCallback(() => setGuiding(false), []);

  // Without a route there is nothing to follow, and a route that comes back
  // later is not a request to guide it.
  if (guiding && !route) setGuiding(false);

  const state: NavigationBannerState = routeBusy
    ? 'rerouting'
    : guidance?.offRoute && !guidance.arrived
      ? 'off-route'
      : 'guiding';

  return { guiding, start, end, guidance, state };
}
