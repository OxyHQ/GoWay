/**
 * The city-3D trees' colours, derived from the cartographic palette — never a
 * colour of their own.
 *
 * A canopy is the palette's PARK colour (`CartographyPalette.park`, the fill
 * the same park is drawn with on the ground), desaturated into a soft matte
 * sage and shifted so it reads as a volume standing on that fill: darker on
 * the light map, lighter on the dark one (whose park fill is already deep).
 * Conifers are the same, cooler and deeper. Trunks are the palette's BUILDING
 * colour, darker: the clay of the city they stand in. So a palette change
 * re-colours the trees with everything else, and nothing here restates a
 * colour.
 *
 * Pure, and outside the engine folder on purpose: the MapLibre adapter imports
 * it at runtime, and the engine folder is type-only to the adapter (see
 * `components/__tests__/engine3dChunk.test.ts`).
 */
import type { CartographyPalette } from '@/lib/map/style/palette';

type Hsl = [number, number, number];

function hexToHsl(hex: string): Hsl {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex([h, s, l]: Hsl): string {
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Canopy, conifer and trunk colours for a palette (`#rrggbb`). */
export function treeColours(palette: CartographyPalette): {
  crown: string;
  conifer: string;
  trunk: string;
} {
  const [h, s, l] = hexToHsl(palette.park);
  const dark = palette.appearance === 'dark';
  // A soft, matte sage: the park's hue, much less saturated, a step darker
  // than the ground on the light map and a step lighter on the dark one.
  const crown: Hsl = dark
    ? [h, clamp01(s * 0.55), clamp01(l * 1.45 + 0.03)]
    : [h, clamp01(s * 0.62), clamp01(l * 0.86)];
  // Conifers: cooler (toward blue-green) and deeper.
  const conifer: Hsl = [(h + 25 / 360) % 1, crown[1] * 0.9, crown[2] * (dark ? 0.85 : 0.86)];
  // Trunks: the buildings' own clay, darker, so the trees belong to the city.
  const [bh, bs, bl] = hexToHsl(palette.building);
  const trunk: Hsl = [bh, clamp01(bs * 0.3), clamp01(bl * (dark ? 0.75 : 0.55))];
  return { crown: hslToHex(crown), conifer: hslToHex(conifer), trunk: hslToHex(trunk) };
}
