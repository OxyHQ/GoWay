/**
 * Every committed glyph range is COMPLETE, and MapLibre's own reader says so.
 *
 * ## The defect
 *
 * `public/map/fonts/Inter Regular/3584-3839.pbf` was 599 bytes: one glyph, in a
 * range that holds 153 Thai code points upstream serves. It existed because the
 * build emitted a file for any range Inter's cmap touched AT ALL, and it was
 * fatal because `worker/index.js` decides between the asset and the upstream
 * proxy on the file's EXISTENCE. A short file is not a partial answer — it is
 * the whole answer, and MapLibre draws nothing for the code points it omits
 * without a 404, a warning or a log line anywhere.
 *
 * ## What is asserted, and with whose reader
 *
 * The parse is MapLibre's own `parseGlyphPbf` — the function `GlyphManager`
 * runs on the bytes this repository serves — not the decoder in `mapgen/`,
 * which shares an author with the encoder and could therefore agree with it
 * about a format the engine cannot read. It is reached by looking its alias up
 * in the dev bundle's export list rather than by hard-coding the minified name,
 * so a MapLibre upgrade that renames the alias keeps working and one that
 * removes the function fails loudly.
 *
 * Completeness is measured against `mapgen/fixtures/fallback/coverage.json`:
 * what upstream would have drawn, minus what the file draws, minus the code
 * points nothing renders (controls, default-ignorables). That is the only
 * definition that means anything here — a code point upstream cannot draw
 * either is not a hole, and dropping a range over one would set a whole script
 * in the wrong typeface to fix nothing.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { UPSTREAM_FONTSTACK, GLYPH_FONTSTACKS } from '@/scripts/build-map-glyphs';
import { decodeGlyphs, encodeGlyphs } from '@/scripts/mapgen/glyph-pbf';
import {
  COVERAGE_FILE,
  FALLBACK_DIR,
  decodeRuns,
  holesFor,
  isRenderable,
  rebaseTop,
  type FallbackCoverage,
} from '@/scripts/mapgen/fallback';

const FRONTEND_ROOT = resolve(dirname(import.meta.dir), '..');
const FONTS_DIR = join(FRONTEND_ROOT, 'public', 'map', 'fonts');
const FALLBACK = join(FRONTEND_ROOT, 'scripts', FALLBACK_DIR);

interface ParsedGlyph {
  id: number;
  bitmap: { width: number; height: number; data: Uint8Array };
  metrics: { width: number; height: number; left: number; top: number; advance: number };
}

/** MapLibre's `parseGlyphPbf`, found by name in the dev bundle's export list. */
async function maplibreParser(): Promise<(data: Uint8Array) => ParsedGlyph[]> {
  const require = createRequire(import.meta.url);
  const bundle = require.resolve('maplibre-gl/dist/maplibre-gl-shared-dev.mjs');
  const source = await readFile(bundle, 'utf8');
  const alias = /\bparseGlyphPbf as (\w+)\b/.exec(source);
  expect(alias, 'maplibre-gl no longer exports parseGlyphPbf from its shared bundle').not.toBeNull();
  const module = (await import(bundle)) as Record<string, unknown>;
  const parse = module[alias![1]];
  expect(typeof parse).toBe('function');
  return parse as (data: Uint8Array) => ParsedGlyph[];
}

async function committedRanges(): Promise<{ stack: string; range: string; bytes: Uint8Array }[]> {
  const files: { stack: string; range: string; bytes: Uint8Array }[] = [];
  for (const stack of await readdir(FONTS_DIR)) {
    for (const file of await readdir(join(FONTS_DIR, stack))) {
      if (!file.endsWith('.pbf')) continue;
      files.push({
        stack,
        range: file.slice(0, -'.pbf'.length),
        bytes: new Uint8Array(await readFile(join(FONTS_DIR, stack, file))),
      });
    }
  }
  return files;
}

const coverage = JSON.parse(
  await readFile(join(FALLBACK, COVERAGE_FILE), 'utf8'),
) as FallbackCoverage;
const files = await committedRanges();

describe('the committed glyph tree', () => {
  test('there is one, and it covers all four weights', () => {
    expect(files.length).toBeGreaterThan(0);
    const stacks = new Set(files.map((file) => file.stack));
    expect([...stacks].sort()).toEqual(GLYPH_FONTSTACKS.map((stack) => stack.name).sort());
  });

  test('MapLibre parses every file, and every bitmap is the size it claims', async () => {
    const parse = await maplibreParser();
    for (const file of files) {
      const glyphs = parse(file.bytes);
      expect(glyphs.length, `${file.stack}/${file.range} parsed to nothing`).toBeGreaterThan(0);
      for (const glyph of glyphs) {
        // MapLibre does not check this and does not throw on a bitmap one byte
        // short — it shears every row after the missing one. `AlphaImage` is
        // where the claim and the bytes meet.
        expect(glyph.bitmap.width).toBe(glyph.metrics.width + 6);
        expect(glyph.bitmap.height).toBe(glyph.metrics.height + 6);
        expect(glyph.bitmap.data.length).toBe(glyph.bitmap.width * glyph.bitmap.height);
      }
    }
  });

  test('no published range has a hole the fallback would have filled', () => {
    for (const file of files) {
      const upstream = UPSTREAM_FONTSTACK[file.stack];
      const stack = coverage.stacks[upstream];
      expect(stack, `${file.stack} has no fallback fontstack`).toBeDefined();

      const ids = new Set(
        decodeGlyphs(file.bytes).flatMap((one) => one.glyphs.map((glyph) => glyph.id)),
      );
      const holes = holesFor(stack, file.range, ids);
      expect(holes, `${file.range} was never measured against ${upstream}`).toBeDefined();
      expect(
        [...holes!].map((codePoint) => codePoint.toString(16)),
        `${file.stack}/${file.range} is published with holes — the Worker cannot fall back on a range whose file exists`,
      ).toEqual([]);
    }
  });

  test('the four weights publish exactly the same ranges', () => {
    // Coverage is a property of the cmap, not of a weight, and the fallback
    // decision is made once for all four. If it were not, a label would change
    // its spelling when it was emphasised.
    const byStack = new Map<string, string[]>();
    for (const file of files) {
      const list = byStack.get(file.stack) ?? [];
      list.push(file.range);
      byStack.set(file.stack, list);
    }
    const sets = [...byStack.values()].map((list) => list.sort().join(','));
    expect(new Set(sets).size).toBe(1);
  });

  test('the range that started this is gone, and the Worker can answer it', () => {
    // U+0E00–U+0E7F is Thai. Inter has one code point in that range and
    // upstream has 153, so the file has to be ABSENT for the proxy to run.
    expect(files.some((file) => file.range === '3584-3839')).toBe(false);
    expect(decodeRuns(coverage.stacks['Noto Sans Regular'].ranges['3584-3839']).size).toBeGreaterThan(100);

    // And the ranges Inter really does own are still served from goway.to.
    for (const range of ['0-255', '256-511', '1024-1279', '8192-8447']) {
      expect(files.filter((file) => file.range === range)).toHaveLength(4);
    }
  });

  test('the merged glyphs sit on Inter\'s baseline, not Noto\'s', async () => {
    // `top` is measured DOWN FROM THE ASCENDER, which is 26px for Noto at
    // 24ppem and 24px for Inter. Copied across unchanged, a filled glyph would
    // sit 2px low — 8% of the em — inside a word set in Inter.
    const upstreamName = UPSTREAM_FONTSTACK['Inter Regular'];
    const pack = decodeGlyphs(
      new Uint8Array(await readFile(join(FALLBACK, upstreamName, '256-511.pbf'))),
    ).flatMap((one) => one.glyphs);
    expect(pack.length).toBeGreaterThan(0);

    const published = new Map(
      decodeGlyphs(
        new Uint8Array(await readFile(join(FONTS_DIR, 'Inter Regular', '256-511.pbf'))),
      )
        .flatMap((one) => one.glyphs)
        .map((glyph) => [glyph.id, glyph]),
    );

    const shift = coverage.stacks[upstreamName].ascender - 24;
    expect(shift).toBe(2);
    for (const glyph of pack) {
      const merged = published.get(glyph.id);
      expect(merged, `U+${glyph.id.toString(16)} was not merged in`).toBeDefined();
      expect(merged!.top).toBe(glyph.top + shift);
      // Nothing else about a glyph depends on the baseline.
      expect(merged!.advance).toBe(glyph.advance);
      expect(merged!.width).toBe(glyph.width);
    }
  });
});

describe('the gate itself', () => {
  test('fails on a range with one glyph taken out of it', async () => {
    // A gate that cannot fail is a comment. This is the 599-byte Thai file's
    // shape, rebuilt from a range that is currently whole: drop one code point
    // and the measurement has to notice.
    const file = files.find((one) => one.stack === 'Inter Regular' && one.range === '256-511')!;
    const glyphs = decodeGlyphs(file.bytes).flatMap((one) => one.glyphs);
    const dropped = glyphs[10].id;

    const kept = new Set(glyphs.filter((glyph) => glyph.id !== dropped).map((glyph) => glyph.id));
    const stack = coverage.stacks[UPSTREAM_FONTSTACK['Inter Regular']];
    expect([...holesFor(stack, '256-511', kept)!]).toEqual([dropped]);

    // And the truncated file is still perfectly valid protobuf, which is the
    // whole problem: nothing downstream of here would have objected.
    const truncated = encodeGlyphs([
      { name: 'Inter Regular', range: '256-511', glyphs: glyphs.filter((g) => g.id !== dropped) },
    ]);
    const parse = await maplibreParser();
    expect(parse(truncated).length).toBe(glyphs.length - 1);
  });

  test('a code point nothing renders is not a hole', () => {
    // U+00AD SOFT HYPHEN and the C0 controls are in Noto's cmap, so upstream
    // serves glyphs for them. Counting those as holes would have condemned
    // 0-255 — the one range Inter covers outright — to the fallback.
    expect(isRenderable(0x00ad)).toBe(false);
    expect(isRenderable(0x0007)).toBe(false);
    expect(isRenderable(0x200d)).toBe(false);
    expect(isRenderable(0x0041)).toBe(true);
    expect(isRenderable(0x0e01)).toBe(true);

    const latin = decodeRuns(coverage.stacks['Noto Sans Regular'].ranges['0-255']);
    expect(latin.has(0x00ad)).toBe(true);
    const published = new Set(
      decodeGlyphs(files.find((f) => f.stack === 'Inter Regular' && f.range === '0-255')!.bytes)
        .flatMap((one) => one.glyphs)
        .map((glyph) => glyph.id),
    );
    expect(published.has(0x00ad)).toBe(false);
    expect([...holesFor(coverage.stacks['Noto Sans Regular'], '0-255', published)!]).toEqual([]);
  });

  test('an unmeasured range is a hole, not an absence of one', () => {
    // The distinction the build turns on: `undefined` means "cannot promise
    // anything about this range", which must NOT be read as "no holes".
    expect(holesFor(coverage.stacks['Noto Sans Regular'], '1114112-1114367', new Set())).toBeUndefined();
  });

  test('rebaseTop is a pure shift and nothing else', () => {
    const glyph = { id: 65, width: 8, height: 10, left: 1, top: -9, advance: 9 };
    expect(rebaseTop(glyph, 26, 24)).toEqual({ ...glyph, top: -7 });
    expect(rebaseTop(glyph, 24, 24)).toBe(glyph);
  });
});
