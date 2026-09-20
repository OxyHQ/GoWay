/**
 * What the Worker's fallback would have drawn — measured, and filled in.
 *
 * ## The hole this module exists to close
 *
 * MapLibre asks for glyphs in fixed 256-codepoint range files, and it asks for
 * ONE file per range. `worker/index.js` answers `/map/fonts/{stack}/{range}.pbf`
 * from the committed assets when the file exists and proxies upstream Noto when
 * it does not — an ALL-OR-NOTHING choice, made per range, on the file's
 * existence alone.
 *
 * So a range file that exists but is incomplete is not a partially-served
 * range. It is a range where the fallback can never fire. The build used to
 * emit a file for any range where Inter's cmap had at least ONE code point in
 * it, which made `Inter Regular/3584-3839.pbf` a 599-byte file holding a single
 * glyph — and made every one of the 153 Thai code points upstream serves
 * unreachable, permanently, with no request, no 404 and nothing in any log. The
 * committed tree was 33 ranges of which only a handful were whole.
 *
 * Nothing at request time can repair that: by the time MapLibre has the file it
 * has stopped asking. The decision has to be made where the file is written.
 *
 * ## The rule
 *
 * **A published range is complete, or it is not published.**
 *
 * "Complete" is measured against the fallback and not against Unicode, because
 * the fallback is what the alternative actually is. A code point that upstream
 * cannot draw either is not a hole: dropping a range over it would trade a
 * glyph nobody can draw for a whole range set in the wrong typeface. So:
 *
 *     holes(stack, range) = upstreamCoverage(stack, range)
 *                         − interCoverage(range)
 *                         − unrenderable
 *
 * and a range with holes is either FILLED from the fallback (this module) or
 * left out of the tree entirely, in which case the Worker proxies all 256 code
 * points of it and the label renders whole in one typeface.
 *
 * ## Two committed artefacts, both fetched by `map:glyphs:fallback`
 *
 *  - `fallback/coverage.json` — which code points each upstream stack serves,
 *    per range, plus the ascender its `top` values are measured from. This is
 *    what makes "hole" a measurement rather than a guess, and it is why the
 *    normal build needs no network.
 *  - `fallback/<upstream stack>/<range>.pbf` — the glyphs themselves, for the
 *    ranges GoWay chooses to complete locally rather than hand over whole. Only
 *    the code points Inter lacks are kept, so the pack is tens of kilobytes
 *    rather than the megabytes a mirror of upstream would be.
 *
 * ## `top` is re-based on the way in
 *
 * `top` is measured DOWN FROM THE ASCENDER, not up from the baseline (see the
 * header of `build-map-glyphs.ts`), and the ascender is a property of the font:
 * 26px for Noto Sans at 24ppem, 24px for Inter. A Noto glyph copied into an
 * Inter file unchanged therefore sits 2px — 8% of the em — below its
 * neighbours. {@link rebaseTop} moves it onto Inter's ascender, so a merged
 * range has ONE baseline.
 *
 * That is also the part of the old comment in `build-map-glyphs.ts` that this
 * change makes obsolete in the good direction: mixing an Inter range with a
 * proxied Noto range still costs 2px, but a merged range no longer does.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeGlyphs, type MapGlyph } from './glyph-pbf';

/** Where the committed fallback artefacts live, relative to `scripts/`. */
export const FALLBACK_DIR = join('mapgen', 'fixtures', 'fallback');

/** `fallback/coverage.json`. */
export const COVERAGE_FILE = 'coverage.json';

export interface FallbackStack {
  /**
   * The pixel ascender this stack's `top` values are measured from.
   *
   * Read off the stack's own blank glyph rather than assumed: a whitespace
   * glyph carries no bitmap and its `top` is exactly `-ascender`, which is how
   * 26 was established for Noto Sans in the first place.
   */
  ascender: number;
  /** Range name (`"0-255"`) -> the code points upstream serves in it. */
  ranges: Record<string, string>;
}

export interface FallbackCoverage {
  /** The template the glyphs came from. Must equal the Worker's `MAP_GLYPH_UPSTREAM`. */
  source: string;
  /** When, so a reviewer can tell a stale manifest from a fresh one. */
  fetched: string;
  stacks: Record<string, FallbackStack>;
}

/**
 * Code points that are never a hole, however much of them a font has a glyph for.
 *
 * Upstream's generator walks the font's cmap, and Noto's cmap maps the C0
 * controls: `Noto Sans Regular/0-255.pbf` carries glyphs for U+0001..U+001F.
 * Counting those as holes would have condemned the Latin-1 range — the one
 * range Inter covers outright — to being served by the fallback over 31 code
 * points that cannot appear in a place name.
 *
 * `Default_Ignorable_Code_Point` is the same argument with a specification
 * behind it: U+00AD SOFT HYPHEN, the joiners, the variation selectors. Unicode
 * says a renderer should show nothing for them, so a font that has an outline
 * for one is not drawing something we are failing to draw.
 */
export function isRenderable(codePoint: number): boolean {
  const character = String.fromCodePoint(codePoint);
  if (/\p{Cc}/u.test(character)) return false;
  if (/\p{Default_Ignorable_Code_Point}/u.test(character)) return false;
  return true;
}

/**
 * `"20-7e,a0,ff"` — sorted code points as inclusive hex runs.
 *
 * A run-length spelling rather than a JSON array because the manifest holds
 * some eight thousand code points and a reviewer should be able to read a diff
 * of it: a font upgrade that adds one glyph should show up as one changed run,
 * not as a re-indented array.
 */
export function encodeRuns(codePoints: Iterable<number>): string {
  const sorted = [...codePoints].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = -1;
  let previous = -2;
  const flush = () => {
    if (start < 0) return;
    runs.push(start === previous ? start.toString(16) : `${start.toString(16)}-${previous.toString(16)}`);
  };
  for (const codePoint of sorted) {
    if (codePoint === previous) continue;
    if (codePoint !== previous + 1) {
      flush();
      start = codePoint;
    }
    previous = codePoint;
  }
  flush();
  return runs.join(',');
}

/** The inverse of {@link encodeRuns}. Throws on anything it cannot read. */
export function decodeRuns(runs: string): Set<number> {
  const codePoints = new Set<number>();
  if (runs.length === 0) return codePoints;
  for (const run of runs.split(',')) {
    const [from, to] = run.split('-');
    const start = Number.parseInt(from, 16);
    const end = to === undefined ? start : Number.parseInt(to, 16);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
      throw new Error(`fallback coverage: "${run}" is not a code point run`);
    }
    for (let codePoint = start; codePoint <= end; codePoint += 1) codePoints.add(codePoint);
  }
  return codePoints;
}

/**
 * The ascender a decoded stack's `top` values are measured from.
 *
 * A blank glyph — space, no-break space, the en/em spaces — has no bitmap and
 * no ink, so its `top` is the offset itself and nothing else. Returns
 * `undefined` for a range with no blank glyph in it, which is most of them;
 * the manifest records the value found in the range that has one.
 */
export function ascenderOf(glyphs: readonly MapGlyph[]): number | undefined {
  for (const glyph of glyphs) {
    if (glyph.width === 0 && glyph.height === 0 && glyph.bitmap === undefined) return -glyph.top;
  }
  return undefined;
}

/**
 * The same glyph, measured from a different ascender.
 *
 * `top = ink - ascender`, so moving between two fonts' ascenders is a shift of
 * the difference. Nothing else about the glyph changes: the bitmap, the ink
 * box and the advance are all baseline-independent.
 */
export function rebaseTop(glyph: MapGlyph, from: number, to: number): MapGlyph {
  if (from === to) return glyph;
  return { ...glyph, top: glyph.top + from - to };
}

export interface LoadedFallback {
  coverage: FallbackCoverage;
  /** `"<stack>/<range>"` -> the glyphs committed for it. */
  glyphs: Map<string, MapGlyph[]>;
}

/** Read the committed manifest and fill pack. Offline, and required by the build. */
export async function loadFallback(root: string): Promise<LoadedFallback> {
  const dir = join(root, FALLBACK_DIR);
  const coverage = JSON.parse(await readFile(join(dir, COVERAGE_FILE), 'utf8')) as FallbackCoverage;

  const glyphs = new Map<string, MapGlyph[]>();
  for (const stack of Object.keys(coverage.stacks)) {
    const stackDir = join(dir, stack);
    const files = await readdir(stackDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    for (const file of files) {
      if (!file.endsWith('.pbf')) continue;
      const decoded = decodeGlyphs(new Uint8Array(await readFile(join(stackDir, file))));
      glyphs.set(`${stack}/${file.slice(0, -'.pbf'.length)}`, decoded.flatMap((one) => one.glyphs));
    }
  }

  return { coverage, glyphs };
}

/**
 * The code points upstream would draw for a range and Inter does not.
 *
 * `undefined` — rather than an empty set — when the manifest has never seen the
 * range. The two are opposites and the caller must not confuse them: an
 * unmeasured range is one the build cannot promise anything about, so it is not
 * published, and the message says to refresh the manifest.
 */
export function holesFor(
  stack: FallbackStack,
  range: string,
  covered: ReadonlySet<number>,
): Set<number> | undefined {
  const runs = stack.ranges[range];
  if (runs === undefined) return undefined;
  const holes = new Set<number>();
  for (const codePoint of decodeRuns(runs)) {
    if (covered.has(codePoint)) continue;
    if (!isRenderable(codePoint)) continue;
    holes.add(codePoint);
  }
  return holes;
}
