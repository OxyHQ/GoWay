/**
 * Hex colours: the ONE parser for every map module — the style's building
 * ramp and ground, the 3D palette, the city engine and its TSL materials, the
 * tree colours, the light, the city-tile decoder and GoWay Live's liveries.
 * There were seven (`docs/MAP_PERFORMANCE.md` → duplication). Pure, and in
 * the first-paint bundle already (through the style), so the lazy chunks and
 * the workers share it without it being hoisted into `__common`.
 *
 * Channels are RAW sRGB: the map's colours go to the framebuffer
 * unconverted (MapLibre's convention), so nothing here colour-manages them.
 */

/** `#rgb` or `#rrggbb` → channels 0–255, or `null` for anything else. */
export function parseHexColour(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (long) {
    const n = Number.parseInt(long[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short)
    return [1, 2, 3].map((i) => Number.parseInt(short[i] + short[i], 16)) as [
      number,
      number,
      number,
    ];
  return null;
}

/** `#rrggbb` → channels 0–1; anything unreadable is `fallback` (white by default, MapLibre's). */
export function hexToRgb(
  value: unknown,
  fallback: readonly [number, number, number] = [1, 1, 1],
): [number, number, number] {
  const parsed = parseHexColour(value);
  return parsed ? [parsed[0] / 255, parsed[1] / 255, parsed[2] / 255] : [...fallback];
}

/** `#rrggbb` → one packed `0xRRGGBB`, or `undefined` for anything else (a tile property). */
export function hexToPacked(value: unknown): number | undefined {
  const parsed = parseHexColour(value);
  return parsed && typeof value === 'string' && value.length === 7
    ? (parsed[0] << 16) | (parsed[1] << 8) | parsed[2]
    : undefined;
}

/** WCAG 2 relative luminance of `#rrggbb` (0 black … 1 white); `NaN` for anything else. */
export function relativeLuminance(hex: string): number {
  const parsed = parseHexColour(hex);
  if (!parsed) return Number.NaN;
  const [r, g, b] = parsed.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, 1 … 21, whichever is lighter. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
