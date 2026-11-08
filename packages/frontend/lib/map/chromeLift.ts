/** Measured map-control occupancy. Official attribution uses its own uncapped lift. */
export function chromeLift(input: {
  sheetHeight: number;
  claimed: number;
  /** Largest sheet footprint that leaves the measured controls below top chrome. */
  maximumSheetHeight: number;
}): { lift: number; opacity: number } {
  'worklet';
  const { sheetHeight, claimed, maximumSheetHeight } = input;
  if (!Number.isFinite(sheetHeight)) return { lift: 0, opacity: 0 };
  return {
    lift: Math.max(0, sheetHeight) - Math.max(0, claimed),
    opacity: sheetHeight <= maximumSheetHeight ? 1 : 0,
  };
}
