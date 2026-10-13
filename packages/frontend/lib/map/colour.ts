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

// ---------------------------------------------------------------------------
// OKLab: the space the style engine derives one palette from another in
// (`lib/map/style/themes.ts`). Perceptually even, so "half-way to night" and
// "the same lightness without its hue" mean what they say, which a mix in
// sRGB does not (it greys and darkens in the middle).
// ---------------------------------------------------------------------------

/** A CSS colour as a palette or a Bloom token writes it: channels 0–255 and an alpha. */
export interface CssColour {
  rgb: [number, number, number];
  alpha: number;
}

/**
 * `#rrggbb`/`#rgb`, `rgb(r g b)`/`rgb(r,g,b)` or `rgba(r,g,b,a)` — the
 * notations the palettes and Bloom's resolved tokens use; `null` otherwise.
 */
export function parseCssColour(value: unknown): CssColour | null {
  const hex = parseHexColour(value);
  if (hex) return { rgb: hex, alpha: 1 };
  if (typeof value !== 'string') return null;
  const match =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
      value.trim(),
    );
  if (!match) return null;
  const channel = (raw: string) => Math.max(0, Math.min(255, Math.round(Number(raw))));
  const alpha = match[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(match[4])));
  return { rgb: [channel(match[1]), channel(match[2]), channel(match[3])], alpha };
}

/** `#rrggbb` when opaque, `rgba(r,g,b,a)` otherwise — the two forms the style documents carry. */
export function formatCssColour(colour: CssColour): string {
  const [r, g, b] = colour.rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  if (colour.alpha >= 1) {
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  return `rgba(${r},${g},${b},${Number(colour.alpha.toFixed(3))})`;
}

/** OKLab `[L, a, b]`, L in 0–1. */
export type Oklab = [number, number, number];

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** sRGB channels 0–255 → OKLab. */
export function rgbToOklab(rgb: readonly [number, number, number]): Oklab {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → sRGB channels 0–255, clipped into the gamut. */
export function oklabToRgb([L, a, b]: Oklab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** OKLCh `[L, C, h°]` of a colour's channels. */
export function rgbToOklch(rgb: readonly [number, number, number]): [number, number, number] {
  const [L, a, b] = rgbToOklab(rgb);
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return [L, Math.hypot(a, b), hue < 0 ? hue + 360 : hue];
}

/** OKLCh → sRGB channels, clipped into the gamut. */
export function oklchToRgb([L, C, h]: readonly [number, number, number]): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  return oklabToRgb([L, C * Math.cos(rad), C * Math.sin(rad)]);
}

/**
 * Re-colour a CSS colour through an OKLCh function, keeping its alpha (an
 * `rgba()` halo stays translucent). A value that is not a colour is returned
 * unchanged.
 */
export function mapColour(
  value: string,
  fn: (lch: [number, number, number]) => readonly [number, number, number],
): string {
  const parsed = parseCssColour(value);
  if (!parsed) return value;
  return formatCssColour({ rgb: oklchToRgb(fn(rgbToOklch(parsed.rgb))), alpha: parsed.alpha });
}

/** Mix two CSS colours in OKLab, `t` of the way from `a` to `b` (alpha mixed linearly). */
export function mixColours(a: string, b: string, t: number): string {
  const ca = parseCssColour(a);
  const cb = parseCssColour(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const la = rgbToOklab(ca.rgb);
  const lb = rgbToOklab(cb.rgb);
  const mixed: Oklab = [
    la[0] + (lb[0] - la[0]) * t,
    la[1] + (lb[1] - la[1]) * t,
    la[2] + (lb[2] - la[2]) * t,
  ];
  return formatCssColour({ rgb: oklabToRgb(mixed), alpha: ca.alpha + (cb.alpha - ca.alpha) * t });
}

/** A translucent colour composited over an opaque ground, as the eye finally sees it: `#rrggbb`. */
export function flattenColour(value: string, ground: string): string {
  const top = parseCssColour(value);
  const under = parseCssColour(ground);
  if (!top || !under) return value;
  const rgb: [number, number, number] = [
    top.rgb[0] * top.alpha + under.rgb[0] * (1 - top.alpha),
    top.rgb[1] * top.alpha + under.rgb[1] * (1 - top.alpha),
    top.rgb[2] * top.alpha + under.rgb[2] * (1 - top.alpha),
  ];
  return formatCssColour({ rgb, alpha: 1 });
}

/**
 * Walk `ink` along its own OKLab lightness axis — hue held, chroma kept where
 * the gamut allows — until it clears `ratio` against every (opaque) ground:
 * darker on a light ground, lighter on a dark one. It is the method
 * `palette.ts` applied by hand to POI type, as a function, so a DERIVED
 * palette keeps the same accessibility floor. The ink comes back unchanged
 * (made opaque) when it already clears.
 */
export function ensureContrast(ink: string, grounds: readonly string[], ratio: number): string {
  const parsed = parseCssColour(ink);
  if (!parsed) return ink;
  const clears = (hex: string) => grounds.every((ground) => contrastRatio(hex, ground) >= ratio);
  const start = formatCssColour({ rgb: parsed.rgb, alpha: 1 });
  if (clears(start)) return start;
  const [L, C, h] = rgbToOklch(parsed.rgb);
  const groundL =
    grounds.reduce(
      (sum, ground) => sum + rgbToOklab(parseHexColour(ground) ?? [128, 128, 128])[0],
      0,
    ) / Math.max(1, grounds.length);
  const direction = groundL > 0.6 ? -1 : 1;
  for (let step = 1; step <= 100; step += 1) {
    const next = Math.max(0, Math.min(1, L + direction * step * 0.01));
    const candidate = formatCssColour({ rgb: oklchToRgb([next, C, h]), alpha: 1 });
    if (clears(candidate)) return candidate;
  }
  return direction < 0 ? '#000000' : '#ffffff';
}
