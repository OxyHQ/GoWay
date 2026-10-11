/**
 * `#rrggbb` → sRGB channels in 0–1, RAW: the city engine writes palette
 * values to the framebuffer unconverted (MapLibre's convention), so no
 * colour-management step may touch them. Shared by the WebGL engine
 * (`cityEngine.ts`) and the TSL materials (`tsl/`).
 */
export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}
