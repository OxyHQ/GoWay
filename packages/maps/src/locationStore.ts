/**
 * The reader's location permission and position, as external stores.
 *
 * `<UserLocation>` reads both through `useSyncExternalStore`, so the dot
 * appears the moment a permission is granted — by `useUserLocation().locate()`
 * on a tap, or because it already was — with no effect anywhere.
 *
 * The permission is READ (`getForegroundPermissionsAsync`, which never
 * prompts) when the first `<UserLocation>` subscribes, and settled by
 * `useUserLocation` whenever it asks. Nothing here can show a prompt.
 *
 * The position is watched only while something subscribes AND the permission
 * is granted, and it is kept in memory only: no store, cache or history.
 */
import * as Location from 'expo-location';

import { isDrawableCoordinate, reportMapDefect } from './shared';
import type { GeoCoordinate } from './types';

export type PermissionState = 'unknown' | 'granted' | 'denied';

type Listener = () => void;

function createPermissionStore() {
  let state: PermissionState = 'unknown';
  let reading = false;
  const listeners = new Set<Listener>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const settle = (next: PermissionState) => {
    if (next === state) return;
    state = next;
    notify();
  };

  const read = () => {
    if (reading || state !== 'unknown') return;
    reading = true;
    Location.getForegroundPermissionsAsync()
      .then((permission) => settle(permission.granted ? 'granted' : 'denied'))
      .catch(() => settle('denied'))
      .finally(() => {
        reading = false;
      });
  };

  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      read();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): PermissionState {
      return state;
    },
    /** What `useUserLocation` learned by asking. */
    settle,
  };
}

/** The one permission store; the platform's permission is one per app. */
export const locationPermission = createPermissionStore();

function createPositionStore() {
  let position: GeoCoordinate | null = null;
  let watcher: Location.LocationSubscription | null = null;
  let starting = false;
  let unsubscribePermission: (() => void) | null = null;
  const listeners = new Set<Listener>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const stop = () => {
    watcher?.remove();
    watcher = null;
    if (position !== null) {
      position = null;
      notify();
    }
  };

  const start = () => {
    if (watcher || starting || locationPermission.getSnapshot() !== 'granted') return;
    starting = true;
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, distanceInterval: 10 },
      (fix) => {
        const next = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
        // A fix with no usable position is "no dot", not "no map".
        if (!isDrawableCoordinate(next)) {
          reportMapDefect('userLocation', 'Skipped a location fix with a non-drawable coordinate.');
          return;
        }
        position = next;
        notify();
      },
    )
      .then((subscription) => {
        if (listeners.size === 0) subscription.remove();
        else watcher = subscription;
      })
      .catch(() => {
        // No fix available is not a map failure; the dot simply does not appear.
      })
      .finally(() => {
        starting = false;
      });
  };

  const onPermission = () => {
    if (locationPermission.getSnapshot() === 'granted') start();
    else stop();
  };

  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribePermission = locationPermission.subscribe(onPermission);
        onPermission();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribePermission?.();
          unsubscribePermission = null;
          stop();
        }
      };
    },
    getSnapshot(): GeoCoordinate | null {
      return position;
    },
  };
}

/** The reader's position while a `<UserLocation>` is drawn, in memory only. */
export const userPosition = createPositionStore();
