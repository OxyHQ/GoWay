/**
 * Generate GoWay's own MapLibre glyph ranges from Inter Variable.
 *
 * ```bash
 * bun run --cwd packages/frontend map:glyphs          # write public/map/fonts/**
 * bun run --cwd packages/frontend map:glyphs:check    # fail on drift
 * bun run --cwd packages/frontend map:glyphs --inspect A   # ASCII-art one glyph
 * ```
 *
 * ## Why GoWay generates its own glyphs
 *
 * Until this change the style document pointed `glyphs` at
 * `https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf`. Every label on
 * every GoWay map was a third-party request: a hostname GoWay does not own, an
 * availability GoWay cannot promise, a typeface GoWay did not choose, and a log
 * line on somebody else's server for every user who opens the map. For a
 * product whose entire surface IS a map, that is not a dependency, it is the
 * product being rendered by someone else.
 *
 * These files are the other half of the fix (the tiles are proxied; the sprite
 * is generated beside this one). They are built from the typeface GoWay already
 * ships — Inter is Bloom's `font-bloom-sans`, so map labels and app chrome are
 * now literally the same font at the same weights — and they are committed, so
 * the deploy is the commit and a reviewer can see a typography change happen.
 *
 * ## The licence, measured
 *
 * Read off `node_modules/@oxy.so/bloom/src/fonts/assets/InterVariable.ttf` with
 * fontkit, not off a README:
 *
 *  - `name.license` = *"This Font Software is licensed under the SIL Open Font
 *    License, Version 1.1. This license is available with a FAQ at:
 *    http://scripts.sil.org/OFL"*
 *  - `name.copyright` = *"Copyright 2016 The Inter Project Authors"*
 *  - `OS/2.fsType` = `{noEmbedding: false, viewOnly: false, editable: false,
 *    noSubsetting: false, bitmapOnly: false}` — i.e. installable embedding,
 *    no restriction on subsetting or editing.
 *  - version `4.001`, 2937 glyphs, `unitsPerEm` 2048, axes `opsz` 14..32 and
 *    `wght` 100..900.
 *
 * The OFL permits redistribution of derivative works — which a rasterised SDF
 * atlas is — provided the derivative is not sold on its own and does not use a
 * Reserved Font Name. Inter 4.x declares NO reserved font name (there is no RFN
 * clause in `src/fonts/assets/Inter-OFL.txt`), so the derived stacks may keep
 * the name "Inter".
 *
 * The OFL does require the copyright and licence notice to travel with the
 * derivative. Until this change the repository's `NOTICE` said it "contains no
 * vendored third party source", which stops being true the moment
 * `public/map/fonts/` is committed — `NOTICE` needs an entry for Inter (OFL
 * 1.1) and for the Remix icons the sprite is built from.
 *
 * ## The four numbers that MapLibre does not validate
 *
 * MapLibre's SDF shaders are written against `sdf-glyph-foundry`'s defaults and
 * silently assume them. None of the four is announced in the file:
 *
 *  - **size 24.** The em is rasterised at 24px. `fontScale = size / 24.0` in
 *    `symbol_sdf.fragment.glsl` is that constant.
 *  - **buffer 3.** `GLYPH_PBF_BORDER` in MapLibre is 3; the bitmap is
 *    `(width + 6) * (height + 6)`. Get it wrong and the atlas copy shears.
 *  - **radius 8.** `SDF_PX` in the shader. Halo widths are divided by it.
 *  - **cutoff 0.25.** The fill edge is at `6/8` of full scale, byte 191.
 *
 * The encoding was verified against a real `sdf-glyph-foundry` file rather than
 * assumed — see the measurement quoted in `mapgen/sdf.ts`.
 *
 * ## `top` is relative to the ASCENDER, not the baseline
 *
 * The least obvious thing in the format, and the one that would have produced a
 * map whose labels sit a few pixels too high with no error anywhere. Decoding
 * `Noto Sans Regular/0-255.pbf` from OpenFreeMap gives `top` values that are
 * all NEGATIVE — `A` is -9, `o` is -13, `l` is -8, `space` is -26 — and every
 * one of them is `bitmapTop - 26`, where 26 is FreeType's
 * `size->metrics.ascender` for Noto Sans at 24ppem (`ceil(1069/1000 * 24)`).
 * MapLibre's `getGlyphQuads` then places the bitmap at `-top - GLYPH_PBF_BORDER`
 * below the line origin, which is only correct if the line origin is the
 * ascender line. So:
 *
 *     top = ceil(inkMaxY) - ceil(ascent / unitsPerEm * 24)
 *
 * For Inter that constant is `ceil(1984 / 2048 * 24) = ceil(23.25) = 24`.
 *
 * **Consequence worth knowing:** Noto's constant is 26 and Inter's is 24. A
 * label that mixes an Inter range with a proxied Noto range therefore has two
 * baselines 2px apart in 24px em space (8% of the em). That is inherent to a
 * format that aligns fallbacks by ascender, not a bug here, but it is the
 * reason to keep Inter's coverage as wide as the font allows rather than
 * proxying ranges Inter can actually draw.
 *
 * ## Why exact distance instead of FreeType + a distance transform
 *
 * See `mapgen/sdf.ts`. Short version: there is no native module to build, and
 * measuring distance from the outline instead of from a 1-bit raster removes
 * the half-pixel staircase that shows up the moment MapLibre scales a label up.
 *
 * ## Coverage: a published range is COMPLETE, or it is not published
 *
 * The Worker's fallback is per RANGE and it keys on the file's existence: if
 * `public/map/fonts/Inter Regular/3584-3839.pbf` is there, that file is the
 * answer, and the 153 Thai code points upstream would have served are
 * unreachable. Emitting a range because Inter has ONE code point in it — which
 * is what this script used to do — therefore does not serve a range partially.
 * It closes the fallback on a range Inter cannot draw.
 *
 * So a range is emitted only when the file will hold every code point the
 * fallback would have drawn for it, which is `mapgen/fallback.ts`'s whole
 * subject. Ranges where Inter is already complete are emitted as they were;
 * ranges listed in {@link COMPLETED_RANGES} are emitted with the missing glyphs
 * merged in from the committed fallback pack, re-based onto Inter's ascender so
 * the merged file has one baseline; everything else is left out and proxied
 * whole. Code points above U+FFFF are skipped because MapLibre refuses to
 * request them at all.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSync, type FontkitFont } from 'fontkit';

import { checkTree, formatBytes, writeTree, type EmitTree } from './mapgen/emit';
import {
  assertGlyphConsistent,
  decodeGlyphs,
  encodeGlyphs,
  GLYPH_PBF_BORDER,
  type MapGlyph,
} from './mapgen/glyph-pbf';
import { holesFor, loadFallback, rebaseTop, type LoadedFallback } from './mapgen/fallback';
import { flattenPath, renderSdf, SDF_DEFAULTS, sdfToAscii } from './mapgen/sdf';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The typeface, taken from Bloom rather than vendored again.
 *
 * Reading it out of `node_modules` means the map's letterforms cannot drift
 * away from the app's: a Bloom upgrade that changes Inter changes both, and the
 * `--check` gate turns that into a failing build rather than a map that quietly
 * stops matching its own UI.
 */
export const FONT_FILE = join(
  FRONTEND_ROOT,
  '..',
  '..',
  'node_modules',
  '@oxy.so',
  'bloom',
  'src',
  'fonts',
  'assets',
  'InterVariable.ttf',
);

const OUTPUT_DIR = join(FRONTEND_ROOT, 'public', 'map', 'fonts');

/** The em size the format is defined at. Not a tunable; see the header. */
const SDF_SIZE = 24;

/** MapLibre refuses to request a range above this, so emitting one is dead weight. */
const MAX_CODE_POINT = 0xffff;

/**
 * The weights GoWay's cartography asks for, and the fontstack name each is
 * served under.
 *
 * Four, not nine. Every extra weight is another ~1.4 MB in the repo and another
 * 33 files in the deploy, and the style document only ever names these: Regular
 * for ordinary labels, Medium for the emphasised ones, SemiBold for place
 * names, Bold for the few that carry a halo. `opsz` is pinned at its default
 * 14 — the optical size axis is for display sizes and map labels are never
 * that — so the only axis that moves between stacks is `wght`.
 */
export const GLYPH_FONTSTACKS: readonly { name: string; wght: number }[] = [
  { name: 'Inter Regular', wght: 400 },
  { name: 'Inter Medium', wght: 500 },
  { name: 'Inter SemiBold', wght: 600 },
  { name: 'Inter Bold', wght: 700 },
];

/** Inter's `opsz` default. Pinned explicitly so the output cannot move with fontkit. */
export const OPTICAL_SIZE = 14;

/**
 * Which upstream fontstack answers for one of ours when a range is not emitted.
 *
 * This MUST equal `UPSTREAM_FONTSTACK` in `worker/index.js`, and it is
 * duplicated rather than imported for the reason that file already gives: a
 * Worker bundle and this build share no module graph, and `worker/index.js` is
 * untyped JavaScript. `worker/__tests__/mapProxy.test.js` asserts the two are
 * the same object, so the duplication cannot drift silently.
 *
 * It matters here and not only there because it decides what "complete" means:
 * `Inter SemiBold` falls back to `Noto Sans Bold`, so its holes are Noto Sans
 * BOLD's code points, not Regular's. `UPSTREAM_GLYPH_TEMPLATE` is the other
 * half of the same duplication — `wrangler.toml`'s `MAP_GLYPH_UPSTREAM` — and
 * the build refuses to run against a fallback manifest fetched from anywhere
 * else, because "complete" measured against a font nobody serves is not a
 * measurement of anything.
 */
export const UPSTREAM_GLYPH_TEMPLATE = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

export const UPSTREAM_FONTSTACK: Readonly<Record<string, string>> = {
  'Inter Regular': 'Noto Sans Regular',
  'Inter Medium': 'Noto Sans Regular',
  'Inter SemiBold': 'Noto Sans Bold',
  'Inter Bold': 'Noto Sans Bold',
};

/**
 * The ranges GoWay completes locally instead of handing to the fallback whole.
 *
 * Every range is one of two things now: complete and ours, or absent and
 * upstream's. This list is where that choice is made for the ranges Inter
 * ALMOST covers, and it is a cartographic decision rather than a technical one.
 *
 * These six are the scripts GoWay's own labels are set in — Latin Extended-A
 * and -B, IPA, the combining marks and Greek, Cyrillic, the punctuation and
 * currency block, the letterlike symbols and arrows (`№`, `™`, `℮`). Inter
 * draws 97% of them; the handful it misses would otherwise cost the whole
 * range. Handing `256-511` to the fallback over U+0149 and U+01C4 — a
 * deprecated letter and a digraph that OSM spells as two characters — would put
 * the `ń` of *Gdańsk* in Noto and the rest of the word in Inter, which is a
 * worse map than the one the hole was in.
 *
 * Everything not here and not already complete is left to the fallback: Thai,
 * Armenian and Hebrew, the box-drawing and dingbat blocks, Glagolitic, the
 * phonetic extensions. Inter had between one and eighty-one glyphs in each,
 * which is not a typeface's coverage of a script, and the files were shutting
 * the fallback out of hundreds of code points to keep them.
 *
 * Adding one costs whatever the pack costs; `map:glyphs:fallback` re-fetches
 * the glyphs and prints the size.
 */
export const COMPLETED_RANGES: readonly number[] = [0x0100, 0x0200, 0x0300, 0x0400, 0x2000, 0x2100];

interface StackResult {
  name: string;
  ranges: number[];
  /** Every range this weight's cmap touches, published or not. Compared across weights. */
  covers: string;
  glyphCount: number;
  bytes: number;
}

/**
 * The ascender offset `top` is measured from, in whole pixels.
 *
 * `FT_PIX_CEIL(FT_MulFix(face->ascender, y_scale))` — FreeType rounds the
 * ascender UP to a whole pixel, and reproducing that rounding is what makes our
 * `top` values comparable with an upstream generator's.
 */
function ascenderPixels(font: FontkitFont): number {
  return Math.ceil((font.ascent / font.unitsPerEm) * SDF_SIZE);
}

/** Render one code point in one already-instanced font. */
function buildGlyph(font: FontkitFont, codePoint: number, ascender: number): MapGlyph {
  const glyph = font.glyphForCodePoint(codePoint);
  const scale = SDF_SIZE / font.unitsPerEm;
  const advance = Math.round(glyph.advanceWidth * scale);

  const contours = flattenPath(glyph.path.commands, (x, y) => [x * scale, y * scale]);
  const image = renderSdf(contours, {
    buffer: GLYPH_PBF_BORDER,
    radius: SDF_DEFAULTS.radius,
    cutoff: SDF_DEFAULTS.cutoff,
    // TrueType outlines are nonzero-wound: a counter is a contour running the
    // other way, and even-odd would punch holes in overlapping strokes that
    // the designer intended to merge.
    fillRule: 'nonzero',
  });

  if (image === null) {
    // Whitespace. Still needs its advance, still must carry no bitmap.
    return { id: codePoint, width: 0, height: 0, left: 0, top: -ascender, advance };
  }

  return {
    id: codePoint,
    bitmap: image.data,
    width: image.width,
    height: image.height,
    left: image.left,
    top: image.top - ascender,
    advance,
  };
}

/** Code points Inter covers, grouped into 256-wide ranges, both sorted. */
export function coverageByRange(font: FontkitFont): Map<number, number[]> {
  const byRange = new Map<number, number[]>();
  for (const codePoint of font.characterSet) {
    if (codePoint > MAX_CODE_POINT || codePoint < 0) continue;
    if (!font.hasGlyphForCodePoint(codePoint)) continue;
    const start = Math.floor(codePoint / 256) * 256;
    const bucket = byRange.get(start);
    if (bucket) bucket.push(codePoint);
    else byRange.set(start, [codePoint]);
  }
  for (const bucket of byRange.values()) bucket.sort((a, b) => a - b);
  return byRange;
}

/** Glyphs merged into one of our stacks' ranges, and the ascender they came with. */
interface Fill {
  ascender: number;
  glyphs: MapGlyph[];
}

interface RangePlan {
  /** Range starts that will be emitted, in order. */
  published: number[];
  /** Range starts left to the fallback, with why. */
  proxied: { start: number; reason: string }[];
  /** `"<our stack>/<range>"` -> what to merge into it. */
  fill: Map<string, Fill>;
}

/**
 * Decide, once for all four weights, which ranges are emitted and what goes in.
 *
 * Once for all four deliberately. Inter's cmap is a property of the typeface
 * and not of a weight, but the FALLBACK is per weight — `Inter SemiBold` falls
 * back to `Noto Sans Bold` — so a per-weight decision could publish a range for
 * two of the four stacks and not the others. Four weights of one typeface that
 * disagree about which code points exist is a label that changes its spelling
 * when it is emphasised, so the hole set is the UNION across the upstream
 * stacks and a range is published only if every weight can be completed.
 */
function planRanges(base: FontkitFont, fallback: LoadedFallback, problems: string[]): RangePlan {
  const font = base.getVariation({ wght: GLYPH_FONTSTACKS[0].wght, opsz: OPTICAL_SIZE });
  const coverage = coverageByRange(font);
  const upstreamStacks = [...new Set(Object.values(UPSTREAM_FONTSTACK))];

  const plan: RangePlan = { published: [], proxied: [], fill: new Map() };

  for (const start of [...coverage.keys()].sort((a, b) => a - b)) {
    const range = `${start}-${start + 255}`;
    const covered = new Set(coverage.get(start)!);

    const holes = new Set<number>();
    let unmeasured: string | undefined;
    for (const upstream of upstreamStacks) {
      const stack = fallback.coverage.stacks[upstream];
      const found = stack ? holesFor(stack, range, covered) : undefined;
      if (!found) {
        unmeasured = upstream;
        break;
      }
      for (const codePoint of found) holes.add(codePoint);
    }

    if (unmeasured !== undefined) {
      // Never "assume it is fine": an unmeasured range is one where the build
      // cannot promise the fallback is reachable, and the fallback IS reachable
      // as long as the file is absent. So the safe answer is to leave it out
      // and say what would make it measurable.
      plan.proxied.push({
        start,
        reason: `not in the fallback manifest for "${unmeasured}" — run \`bun run map:glyphs:fallback\``,
      });
      continue;
    }

    if (holes.size === 0) {
      plan.published.push(start);
      continue;
    }

    if (!COMPLETED_RANGES.includes(start)) {
      plan.proxied.push({ start, reason: `${holes.size} code point(s) the fallback draws and Inter does not` });
      continue;
    }

    const fills = new Map<string, Fill>();
    let missing: number | undefined;
    for (const stack of GLYPH_FONTSTACKS) {
      const upstream = UPSTREAM_FONTSTACK[stack.name];
      const pack = fallback.glyphs.get(`${upstream}/${range}`) ?? [];
      const ascender = fallback.coverage.stacks[upstream].ascender;
      const byId = new Map(pack.map((glyph) => [glyph.id, glyph]));
      const glyphs: MapGlyph[] = [];
      for (const codePoint of holes) {
        const glyph = byId.get(codePoint);
        if (!glyph) {
          missing = codePoint;
          break;
        }
        glyphs.push(glyph);
      }
      if (missing !== undefined) break;
      fills.set(`${stack.name}/${range}`, { ascender, glyphs });
    }

    if (missing !== undefined) {
      // The pack is short. Emitting anyway would put the hole back, so the
      // range goes to the fallback and the message names the code point.
      problems.push(
        `${range}: the fallback pack is missing U+${missing.toString(16).toUpperCase().padStart(4, '0')} — re-run \`bun run map:glyphs:fallback\``,
      );
      plan.proxied.push({ start, reason: 'the fallback pack could not complete it' });
      continue;
    }

    for (const [key, value] of fills) plan.fill.set(key, value);
    plan.published.push(start);
  }

  return plan;
}

function buildStack(
  base: FontkitFont,
  stack: { name: string; wght: number },
  plan: RangePlan,
  tree: EmitTree,
): StackResult {
  const font = base.getVariation({ wght: stack.wght, opsz: OPTICAL_SIZE });
  const ascender = ascenderPixels(font);
  const coverage = coverageByRange(font);
  const ranges = plan.published;

  let glyphCount = 0;
  let bytes = 0;

  for (const start of ranges) {
    const range = `${start}-${start + 255}`;
    const covered = coverage.get(start);
    if (!covered) {
      // The plan is made once, from the first weight's cmap. A weight whose
      // cmap disagrees is not a weight of this typeface, and carrying on would
      // emit a range with nothing in it.
      throw new Error(`${stack.name}: has no code points in ${range}, which ${GLYPH_FONTSTACKS[0].name} does`);
    }
    const glyphs = covered.map((codePoint) => buildGlyph(font, codePoint, ascender));

    // The fallback's glyphs, moved onto Inter's ascender. Without the re-base
    // they would sit 2px low — `top` is measured down from the ascender and
    // Noto's is 26 where Inter's is 24 — which is a merged range with two
    // baselines in it.
    const fill = plan.fill.get(`${stack.name}/${range}`);
    if (fill) {
      for (const glyph of fill.glyphs) glyphs.push(rebaseTop(glyph, fill.ascender, ascender));
      // Sorted because the round-trip check below compares the encoded order
      // against a sorted copy, and because a file in code-point order is a file
      // a reader can scan.
      glyphs.sort((a, b) => a.id - b.id);
    }

    for (const glyph of glyphs) assertGlyphConsistent(glyph, `${stack.name} ${range}`);

    const encoded = encodeGlyphs([{ name: stack.name, range, glyphs }]);

    // Round-trip every file. The encoder and the decoder are both ours, so a
    // matching pair proves internal consistency rather than correctness — but
    // the same decoder reads OpenFreeMap's `sdf-glyph-foundry` output (see
    // `--check`), and a decoder that reads the reference implementation AND
    // reproduces our own bytes leaves nowhere for a field-number bug to hide.
    const decoded = decodeGlyphs(encoded);
    if (decoded.length !== 1 || decoded[0].name !== stack.name || decoded[0].range !== range) {
      throw new Error(`${stack.name} ${range}: round-trip lost the fontstack header`);
    }
    if (decoded[0].glyphs.length !== glyphs.length) {
      throw new Error(
        `${stack.name} ${range}: round-trip returned ${decoded[0].glyphs.length} glyphs, encoded ${glyphs.length}`,
      );
    }
    const sorted = [...glyphs].sort((a, b) => a.id - b.id);
    for (let i = 0; i < sorted.length; i += 1) {
      const before = sorted[i];
      const after = decoded[0].glyphs[i];
      if (
        before.id !== after.id ||
        before.width !== after.width ||
        before.height !== after.height ||
        before.left !== after.left ||
        before.top !== after.top ||
        before.advance !== after.advance
      ) {
        throw new Error(`${stack.name} ${range}: glyph ${before.id} metrics changed across the round trip`);
      }
      const bitmapBefore = before.bitmap;
      const bitmapAfter = after.bitmap;
      if ((bitmapBefore === undefined) !== (bitmapAfter === undefined)) {
        throw new Error(`${stack.name} ${range}: glyph ${before.id} gained or lost its bitmap`);
      }
      if (bitmapBefore && bitmapAfter) {
        if (bitmapBefore.length !== bitmapAfter.length) {
          throw new Error(`${stack.name} ${range}: glyph ${before.id} bitmap length changed`);
        }
        for (let b = 0; b < bitmapBefore.length; b += 1) {
          if (bitmapBefore[b] !== bitmapAfter[b]) {
            throw new Error(`${stack.name} ${range}: glyph ${before.id} bitmap byte ${b} changed`);
          }
        }
      }
    }

    tree.set(`${stack.name}/${range}.pbf`, encoded);
    glyphCount += glyphs.length;
    bytes += encoded.length;
  }

  return {
    name: stack.name,
    ranges,
    covers: [...coverage.keys()].sort((a, b) => a - b).join(','),
    glyphCount,
    bytes,
  };
}

/**
 * Prove the decoder against a file this repo did not produce.
 *
 * Reads the upstream Noto range fetched into `scripts/mapgen/fixtures/`. It is
 * a fixture rather than a live fetch so `--check` stays offline and
 * deterministic; the URL it came from is recorded beside it.
 */
async function checkAgainstReference(problems: string[]): Promise<void> {
  const fixture = join(FRONTEND_ROOT, 'scripts', 'mapgen', 'fixtures', 'noto-sans-regular-0-255.pbf');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(fixture));
  } catch {
    problems.push(`reference fixture ${fixture} is missing — see mapgen/fixtures/README for how to refetch it`);
    return;
  }

  const stacks = decodeGlyphs(bytes);
  if (stacks.length !== 1) {
    problems.push(`reference fixture decoded to ${stacks.length} fontstacks, expected 1`);
    return;
  }
  const stack = stacks[0];
  if (stack.range !== '0-255') problems.push(`reference fixture range is "${stack.range}", expected "0-255"`);
  if (!stack.name.startsWith('Noto Sans Regular')) {
    problems.push(`reference fixture stack is "${stack.name}", expected it to start with "Noto Sans Regular"`);
  }
  if (stack.glyphs.length < 200) {
    problems.push(`reference fixture decoded only ${stack.glyphs.length} glyphs — the wire format read wrong`);
  }
  for (const glyph of stack.glyphs) {
    assertGlyphConsistent(glyph, 'reference fixture');
  }

  // The gradient measurement the SDF encoding rests on. `l` is a plain vertical
  // stem, so its middle row crosses one straight edge and the step per pixel is
  // exactly 255/radius. If this ever stops being ~32, our encoding and
  // upstream's have diverged and every halo width in the style is wrong.
  const stem = stack.glyphs.find((glyph) => glyph.id === 0x6c);
  if (!stem?.bitmap) {
    problems.push('reference fixture has no bitmap for U+006C, so the encoding cannot be re-measured');
    return;
  }
  const columns = stem.width + 2 * GLYPH_PBF_BORDER;
  const row = Math.floor((stem.height + 2 * GLYPH_PBF_BORDER) / 2);
  const step = stem.bitmap[row * columns + 2] - stem.bitmap[row * columns + 1];
  const expected = 255 / SDF_DEFAULTS.radius;
  if (Math.abs(step - expected) > 1) {
    problems.push(
      `reference fixture's SDF gradient is ${step}/px, expected ~${expected.toFixed(2)} (255 / radius ${SDF_DEFAULTS.radius})`,
    );
  }
}

function inspect(base: FontkitFont, spec: string): void {
  const codePoint = spec.length === 1 ? spec.codePointAt(0)! : Number.parseInt(spec, 10);
  if (!Number.isFinite(codePoint)) throw new Error(`--inspect wants a character or a code point, got "${spec}"`);

  for (const stack of GLYPH_FONTSTACKS) {
    const font = base.getVariation({ wght: stack.wght, opsz: OPTICAL_SIZE });
    if (!font.hasGlyphForCodePoint(codePoint)) {
      console.log(`${stack.name}: U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} not covered`);
      continue;
    }
    const glyph = buildGlyph(font, codePoint, ascenderPixels(font));
    console.log(
      `\n${stack.name}  U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}  ` +
        `${glyph.width}x${glyph.height}  left=${glyph.left} top=${glyph.top} advance=${glyph.advance}` +
        `  bitmap=${glyph.bitmap?.length ?? 0}B`,
    );
    if (glyph.bitmap) {
      console.log(sdfToAscii(glyph.width, glyph.height, GLYPH_PBF_BORDER, glyph.bitmap));
    }
  }
}

/**
 * The gate: nothing in the tree may be a range with a hole in it.
 *
 * A post-condition rather than a restatement of the plan. `planRanges` decides
 * what SHOULD be complete; this decodes the bytes that were actually produced
 * and asks the same question of them, so a merge that silently dropped a fill
 * glyph — a bad re-base, a fill keyed on the wrong stack, an encoder that lost
 * the tail of a message — fails the build instead of shipping the exact defect
 * the plan exists to prevent.
 *
 * It is also the check that means something to a reader: an incomplete range
 * file is invisible in production. MapLibre asks once, gets a file, and draws
 * nothing for every code point that file omits. There is no 404 to notice.
 */
function assertNoHoles(
  fallback: LoadedFallback,
  tree: EmitTree,
  problems: string[],
): void {
  for (const [path, bytes] of tree) {
    const slash = path.lastIndexOf('/');
    const name = path.slice(0, slash);
    const range = path.slice(slash + 1, -'.pbf'.length);

    const upstream = UPSTREAM_FONTSTACK[name];
    const stack = upstream ? fallback.coverage.stacks[upstream] : undefined;
    if (!stack) {
      problems.push(`${path}: "${name}" has no fallback fontstack, so its completeness cannot be measured`);
      continue;
    }

    const ids = new Set(decodeGlyphs(bytes).flatMap((one) => one.glyphs.map((glyph) => glyph.id)));
    const holes = holesFor(stack, range, ids);
    if (!holes) {
      problems.push(`${path}: published a range the fallback manifest has never measured`);
      continue;
    }
    if (holes.size > 0) {
      const shown = [...holes]
        .slice(0, 4)
        .map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`)
        .join(' ');
      problems.push(
        `${path}: ${holes.size} code point(s) the fallback draws and this file does not (${shown}${holes.size > 4 ? ' …' : ''}) — a range file that exists is the ONLY answer MapLibre gets`,
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const inspectAt = argv.indexOf('--inspect');

  const base = openSync(FONT_FILE);

  if (inspectAt >= 0) {
    inspect(base, argv[inspectAt + 1] ?? 'A');
    return;
  }

  const problems: string[] = [];
  const fallback = await loadFallback(join(FRONTEND_ROOT, 'scripts'));
  if (fallback.coverage.source !== UPSTREAM_GLYPH_TEMPLATE) {
    // The manifest describes ONE upstream. If the Worker is proxying a
    // different one, "complete" was measured against a font nobody serves.
    problems.push(
      `the fallback manifest was fetched from ${fallback.coverage.source}, but the Worker proxies ${UPSTREAM_GLYPH_TEMPLATE}`,
    );
  }

  const plan = planRanges(base, fallback, problems);

  const tree: EmitTree = new Map();
  const results = GLYPH_FONTSTACKS.map((stack) => buildStack(base, stack, plan, tree));

  await checkAgainstReference(problems);
  assertNoHoles(fallback, tree, problems);

  // Coverage is a property of the cmap, so it cannot legitimately differ
  // between weights. If it does, `getVariation` returned something other than
  // an instance of the same font and the four stacks are not four weights of
  // one typeface any more. Compared on what each weight's cmap COVERS rather
  // than on what was published: the publish decision is made once for all four
  // (see `planRanges`), so comparing that would be comparing a value to itself.
  const reference = results[0].covers;
  for (const result of results.slice(1)) {
    if (result.covers !== reference) {
      problems.push(`${result.name} covers different ranges than ${results[0].name}`);
    }
  }

  if (checkOnly) {
    await checkTree(OUTPUT_DIR, tree, problems);
  }

  if (problems.length > 0) {
    console.error(`\nmap glyphs: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error('');
    process.exit(1);
  }

  const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);

  if (!checkOnly) await writeTree(OUTPUT_DIR, tree);

  for (const result of results) {
    console.log(
      `map glyphs: ${result.name} — ${result.ranges.length} ranges, ${result.glyphCount} glyphs, ${formatBytes(result.bytes)}`,
    );
  }
  console.log(
    `map glyphs: ${checkOnly ? 'OK — ' : ''}${results.length} fontstacks, ${tree.size} files, ${formatBytes(totalBytes)} total`,
  );
  console.log(`map glyphs: ranges ${results[0].ranges.map((start) => `${start}-${start + 255}`).join(' ')}`);
  if (plan.proxied.length > 0) {
    console.log(
      `map glyphs: ${plan.proxied.length} range(s) left to the fallback — ${plan.proxied
        .map(({ start, reason }) => `${start}-${start + 255} (${reason})`)
        .join(', ')}`,
    );
  }
}

// Guarded so the constants above can be imported — `worker/__tests__` checks
// this script's copy of the fallback mapping against the Worker's, and
// `scripts/refresh-map-fallback.ts` builds the pack from the same coverage.
if (import.meta.main) await main();
