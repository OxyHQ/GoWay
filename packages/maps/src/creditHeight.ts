/**
 * Where the map's data credit publishes its measured height, so a screen's
 * bottom-right chrome can stand above it however many lines it wraps to
 * (`creditRise.ts`). A screen that floats chrome over the bottom-right
 * provides a shared value; `MapAttribution` writes it, the chrome reads it on
 * the UI thread. Absent, nothing is measured and nothing moves.
 */
import { createContext, useContext } from 'react';
import type { SharedValue } from 'react-native-reanimated';

export const MapCreditHeightContext = createContext<SharedValue<number> | null>(null);

export function useMapCreditHeight(): SharedValue<number> | null {
  return useContext(MapCreditHeightContext);
}
