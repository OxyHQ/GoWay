/**
 * The live lift a screen with a bottom sheet hands the map's own bottom chrome
 * — the data credit (`MapAttribution`) — so it stays above the sheet's CURRENT
 * top edge rather than only above its resting claim.
 *
 * Optional by design: a map with no provider lays the credit out against
 * Bloom's bottom edge
 * exactly as before. A provider can move the credit; nothing can hide it but
 * the sheet itself covering the map.
 */
import { createContext, useContext } from 'react';
import type { SharedValue } from 'react-native-reanimated';

export interface MapChromeLift {
  /** px to translate up, on the UI thread. */
  lift: SharedValue<number>;
  /** 0 … 1, on the UI thread. */
  opacity: SharedValue<number>;
  /**
   * px the screen keeps for its own controls at the bottom-right ("My
   * location"), which a full-width piece of map chrome — the time-of-day
   * scrubber — leaves free so the two never overlap.
   */
  rightClearance: number;
}

export const MapChromeLiftContext = createContext<MapChromeLift | null>(null);

export function useMapChromeLift(): MapChromeLift | null {
  return useContext(MapChromeLiftContext);
}
