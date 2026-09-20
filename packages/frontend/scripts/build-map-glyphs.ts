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
 * ## Coverage, and what the Worker does with the gaps
 *
 * Every range where Inter's cmap has at least one BMP code point is emitted;
 * ranges it does not cover are not, and the Worker answers those by proxying
 * upstream Noto through `goway.to`. Codepoints above U+FFFF are skipped because
 * MapLibre refuses to request them at all.
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
const FONT_FILE = join(
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
const OPTICAL_SIZE = 14;

interface StackResult {
  name: string;
  ranges: number[];
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
function coverageByRange(font: FontkitFont): Map<number, number[]> {
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

function buildStack(
  base: FontkitFont,
  stack: { name: string; wght: number },
  tree: EmitTree,
): StackResult {
  const font = base.getVariation({ wght: stack.wght, opsz: OPTICAL_SIZE });
  const ascender = ascenderPixels(font);
  const coverage = coverageByRange(font);
  const ranges = [...coverage.keys()].sort((a, b) => a - b);

  let glyphCount = 0;
  let bytes = 0;

  for (const start of ranges) {
    const range = `${start}-${start + 255}`;
    const glyphs = coverage.get(start)!.map((codePoint) => buildGlyph(font, codePoint, ascender));
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

  return { name: stack.name, ranges, glyphCount, bytes };
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const inspectAt = argv.indexOf('--inspect');

  const base = openSync(FONT_FILE);

  if (inspectAt >= 0) {
    inspect(base, argv[inspectAt + 1] ?? 'A');
    return;
  }

  const tree: EmitTree = new Map();
  const results = GLYPH_FONTSTACKS.map((stack) => buildStack(base, stack, tree));

  const problems: string[] = [];
  await checkAgainstReference(problems);

  // Coverage is a property of the cmap, so it cannot legitimately differ
  // between weights. If it does, `getVariation` returned something other than
  // an instance of the same font and the four stacks are not four weights of
  // one typeface any more.
  const reference = results[0].ranges.join(',');
  for (const result of results.slice(1)) {
    if (result.ranges.join(',') !== reference) {
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
}

await main();
