/**
 * `<UserLocation>`, native — Bloom's location puck at the reader's position,
 * the same component as on the web. Drawn only against a permission ALREADY
 * granted (`locationStore.ts`): a map that renders this never prompts.
 */
import { useSyncExternalStore } from 'react';
import { LocationPuck } from '@oxy.so/bloom/location-puck';

import { userPosition } from './locationStore';
import { Marker } from './Marker';
import type { UserLocationProps } from './types';

export function UserLocation({ visible = true }: UserLocationProps) {
  return visible ? <DrawnUserLocation /> : null;
}

function DrawnUserLocation() {
  const position = useSyncExternalStore(
    userPosition.subscribe,
    userPosition.getSnapshot,
    userPosition.getSnapshot,
  );
  if (!position) return null;
  return (
    <Marker coordinate={position}>
      <LocationPuck state="located" testID="map-user-location" />
    </Marker>
  );
}
