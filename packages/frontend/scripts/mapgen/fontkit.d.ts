/**
 * The slice of `fontkit`'s API that GoWay's glyph build uses, typed by hand.
 *
 * ## Why this file and not `@types/fontkit`
 *
 * `fontkit@2` ships no types of its own. The DefinitelyTyped package tracks the
 * v1 API, declares `openSync` as returning a union of eight font classes, and
 * types `getVariation` loosely enough that the one call this build depends on
 * — instancing a variable font at a specific `wght` — type-checks even when it
 * is passed nonsense. Adding a dependency to get a *worse* description of four
 * methods is the wrong trade.
 *
 * Declaring only what is used also documents the contract: if a fontkit upgrade
 * removes `getVariation` or renames `characterSet`, this build stops compiling
 * instead of silently emitting four identical weights.
 *
 * The shapes below were read off the real objects (see the measurements quoted
 * in `build-map-glyphs.ts`), not off the README.
 */
declare module 'fontkit' {
  /** A path command as fontkit emits it: `{ command: 'lineTo', args: [x, y] }`. */
  export interface FontkitPathCommand {
    command: string;
    args: number[];
  }

  export interface FontkitPath {
    commands: FontkitPathCommand[];
  }

  export interface FontkitGlyph {
    /** Glyph index within the font, NOT a code point. 0 is `.notdef`. */
    readonly id: number;
    /** Outline in font units, y-up, origin at the baseline pen position. */
    readonly path: FontkitPath;
    /** Horizontal advance in font units; varies with `wght` through HVAR. */
    readonly advanceWidth: number;
  }

  export interface FontkitVariationAxis {
    name: string;
    min: number;
    default: number;
    max: number;
  }

  export interface FontkitFont {
    readonly postscriptName: string | null;
    readonly familyName: string;
    readonly subfamilyName: string;
    readonly version: string;
    readonly unitsPerEm: number;
    readonly numGlyphs: number;
    /** hhea ascent in font units. Positive, above the baseline. */
    readonly ascent: number;
    readonly descent: number;
    /** Every code point the cmap maps, unsorted and including non-BMP. */
    readonly characterSet: number[];
    readonly variationAxes: Record<string, FontkitVariationAxis>;
    readonly namedVariations: Record<string, Record<string, number>>;
    hasGlyphForCodePoint(codePoint: number): boolean;
    glyphForCodePoint(codePoint: number): FontkitGlyph;
    /** A new font object with the variation axes pinned. Non-mutating. */
    getVariation(settings: Record<string, number>): FontkitFont;
  }

  export function openSync(filename: string): FontkitFont;
}
