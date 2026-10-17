/**
 * The map's whole zoom level, published to its children. `<Markers>` clusters
 * by it; it changes only when the camera crosses a level, so a pan re-renders
 * nothing.
 */
import { createContext, useContext } from 'react';

export const ZoomLevelContext = createContext(0);

export function useZoomLevel(): number {
  return useContext(ZoomLevelContext);
}
