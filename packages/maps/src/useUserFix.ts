/**
 * The reader's position as the map draws it — coordinate, ± accuracy and
 * course — for an app that needs it beyond the dot (guided navigation).
 *
 * Reading it starts the same single watcher `<UserLocation>` uses, and only
 * against a permission ALREADY granted (`locationStore.ts`); it never prompts.
 * `null` until there is a fix. Kept in memory only: do not store it.
 *
 * `enabled` (default `true`) is whether to watch at all: a screen that shows
 * the position only after the reader asked for it passes `false` until then,
 * and nothing is watched.
 */
import { useSyncExternalStore } from 'react';

import { userPosition } from './locationStore';
import type { UserFix } from './puckPaint';

const NO_SUBSCRIPTION = () => () => {};
const NOTHING = () => null;

export function useUserFix(enabled = true): UserFix | null {
  return useSyncExternalStore(
    enabled ? userPosition.subscribe : NO_SUBSCRIPTION,
    enabled ? userPosition.getSnapshot : NOTHING,
    enabled ? userPosition.getSnapshot : NOTHING,
  );
}
