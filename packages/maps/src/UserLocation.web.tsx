/**
 * `<UserLocation>`, web — Bloom's location puck at the reader's position.
 *
 * Drawn only against a permission ALREADY granted (`locationStore.ts`): a map
 * that renders this never prompts. Ask with `useUserLocation()` from the
 * reader's own tap.
 */
import { useSyncExternalStore } from 'react';

import { userPosition } from './locationStore';
import { Marker } from './Marker.web';
import { UserPuck } from './UserPuck';
import type { UserLocationProps } from './types';

export function UserLocation({ visible = true }: UserLocationProps) {
  return visible ? <DrawnUserLocation /> : null;
}

function DrawnUserLocation() {
  const fix = useSyncExternalStore(
    userPosition.subscribe,
    userPosition.getSnapshot,
    userPosition.getSnapshot,
  );
  if (!fix) return null;
  return (
    <Marker coordinate={fix}>
      <UserPuck fix={fix} />
    </Marker>
  );
}
