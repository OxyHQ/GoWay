/**
 * The device's position while the map follows it — what the location puck draws.
 *
 * It READS the permission and never requests it: opening the map must not be
 * able to prompt (AGENTS.md → Privacy). `useUserLocation().locate()` is the only
 * thing that asks, and only on a user action; this starts drawing once that has
 * been granted. The fix is transient React state: no store, no cache, no
 * history, and it is gone the moment `enabled` turns false.
 */
import { useEffect, useState } from 'react';
import * as Location from 'expo-location';

import { isDrawableCoordinate, reportMapDefect } from '@/components/map/shared';

import { usableHeading, type UserFix } from './userPuck';

/** A fix this much further away than the last is worth redrawing. */
const DISTANCE_INTERVAL_M = 10;

export function useUserFix(enabled: boolean): UserFix | null {
  const [fix, setFix] = useState<UserFix | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let watcher: Location.LocationSubscription | null = null;

    (async () => {
      const permission = await Location.getForegroundPermissionsAsync();
      if (cancelled || !permission.granted) return;
      const subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: DISTANCE_INTERVAL_M },
        ({ coords }) => {
          if (cancelled) return;
          const position = { latitude: coords.latitude, longitude: coords.longitude };
          // A fix with no usable position is "no dot", not "no app".
          if (!isDrawableCoordinate(position)) {
            reportMapDefect(
              'userLocation',
              'Skipped a location fix with a non-drawable coordinate.',
            );
            return;
          }
          setFix({
            ...position,
            accuracy: coords.accuracy ?? null,
            heading: usableHeading(coords.heading),
          });
        },
      );
      if (cancelled) subscription.remove();
      else watcher = subscription;
    })().catch(() => {
      // No fix available is not a map failure; the puck simply does not appear.
    });

    return () => {
      cancelled = true;
      watcher?.remove();
      setFix(null);
    };
  }, [enabled]);

  // Off means no position, whatever the last fix was.
  return enabled ? fix : null;
}
