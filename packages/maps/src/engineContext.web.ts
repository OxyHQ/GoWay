/**
 * The web engine, published to a `MapView`'s children once its style has
 * loaded. Only the web forks read it.
 */
import { createContext, useContext } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

import type { MapPluginHandle } from './plugin';

export interface WebEngine {
  map: MapLibreMap;
  /** The DOM elements of the markers on this map: a click on one is not a click on the map. */
  markerElements: Set<HTMLElement>;
  /** The plugins attached to this map, consulted for presses, the cursor and errors. */
  plugins: Set<MapPluginHandle<unknown>>;
  /** The element the engine draws into. */
  container: HTMLElement;
}

export const WebEngineContext = createContext<WebEngine | null>(null);

export function useWebEngine(): WebEngine {
  const engine = useContext(WebEngineContext);
  if (!engine) throw new Error('A map component must be rendered inside a <MapView>.');
  return engine;
}
