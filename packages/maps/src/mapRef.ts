/**
 * `useMap()` — the nearest `MapView`'s handle, for chrome laid over a map
 * (a "locate me" button, a re-frame) to call from its own event handlers.
 */
import { createContext, useContext } from 'react';

import type { MapViewRef } from './types';

export const MapRefContext = createContext<MapViewRef | null>(null);

/** The enclosing `MapView`'s handle. Throws outside one: there is no map to move. */
export function useMap(): MapViewRef {
  const handle = useContext(MapRefContext);
  if (!handle) throw new Error('useMap() must be called inside a <MapView>.');
  return handle;
}
