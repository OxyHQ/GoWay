/**
 * Re-measure the Worker's glyph fallback, and take the glyphs GoWay merges.
 *
 * ```bash
 * bun run --cwd packages/frontend map:glyphs:fallback   # needs the network
 * bun run --cwd packages/frontend map:glyphs            # offline, uses the result
 * ```
 *
 * ## Why this is a separate command
 *
 * `map:glyphs` must be offline and deterministic: it runs in CI as
 * `map:glyphs:check` and its job is to prove the committed tree is exactly what
 * the generator produces. A build that fetched from `tiles.openfreemap.org`
 * would be a build whose output depends on somebody else's deploy, which is the
 * opposite of what committing the output is for.
 *
 * So the network step is this one, it is run by a person, and what it writes is
 * committed and reviewable:
 *
 *  - `mapgen/fixtures/fallback/coverage.json` — which code points each upstream
 *    fontstack serves, per range, and the ascender its `top` values are
 *    measured from. This is what turns "is this range complete?" into a
 *    measurement; see `mapgen/fallback.ts`.
 *  - `mapgen/fixtures/fallback/<stack>/<range>.pbf` — only the glyphs Inter
 *    lacks, and only for the ranges `COMPLETED_RANGES` says GoWay completes
 *    locally. Tens of kilobytes, not a mirror.
 *
 * ## When to run it
 *
 * Three occasions, and the build says so when it is one of them:
 *
 *  - Bloom ships a new Inter and its coverage moves (the build reports a range
 *    the manifest has never measured);
 *  - `COMPLETED_RANGES` gains an entry (the build reports a pack that could not
 *    complete a range);
 *  - upstream changes what it serves, which is the one nothing here can detect
 *    on its own. It is also the least urgent: a manifest that is behind
 *    upstream can only make GoWay publish a range with a hole in it if upstream
 *    ADDED code points to a range Inter partly covers.
 *
 * ## Licence
 *
 * The bytes fetched here are SDF rasterisations of the Noto fonts, produced by
 * Mapbox's `sdf-glyph-foundry` and served by OpenFreeMap. Noto is under the SIL
 * Open Font License 1.1, and unlike the ground-truth fixture beside it these
 * glyphs ARE served to browsers — they are merged into `public/map/fonts/`. See
 * `NOTICE`, which records the licence and the measurement behind it.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSync } from 'fontkit';

import {
  FONT_FILE,
  GLYPH_FONTSTACKS,
  OPTICAL_SIZE,
  UPSTREAM_FONTSTACK,
  UPSTREAM_GLYPH_TEMPLATE,
  COMPLETED_RANGES,
  coverageByRange,
} from './build-map-glyphs';
import { formatBytes } from './mapgen/emit';
import { decodeGlyphs, encodeGlyphs, type MapGlyph } from './mapgen/glyph-pbf';
import {
  COVERAGE_FILE,
  FALLBACK_DIR,
  ascenderOf,
  encodeRuns,
  isRenderable,
  type FallbackCoverage,
  type FallbackStack,
} from './mapgen/fallback';

const SCRIPTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = join(SCRIPTS_ROOT, FALLBACK_DIR);

async function fetchRange(stack: string, range: string): Promise<MapGlyph[] | undefined> {
  const url = UPSTREAM_GLYPH_TEMPLATE.replace('{fontstack}', encodeURIComponent(stack)).replace(
    '{range}',
    range,
  );
  const response = await fetch(url);
  // A 404 is upstream saying it has nothing for that range, which is a real
  // measurement (an empty coverage entry) and not a failure. Anything else is.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return decodeGlyphs(bytes).flatMap((one) => one.glyphs);
}

async function main(): Promise<void> {
  const base = openSync(FONT_FILE);
  const inter = coverageByRange(base.getVariation({ wght: GLYPH_FONTSTACKS[0].wght, opsz: OPTICAL_SIZE }));
  const ranges = [...inter.keys()].sort((a, b) => a - b);
  const upstreamStacks = [...new Set(Object.values(UPSTREAM_FONTSTACK))];

  const coverage: FallbackCoverage = {
    source: UPSTREAM_GLYPH_TEMPLATE,
    fetched: new Date().toISOString().slice(0, 10),
    stacks: {},
  };

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  let packBytes = 0;
  let packFiles = 0;

  for (const stackName of upstreamStacks) {
    const stack: FallbackStack = { ascender: 0, ranges: {} };
    let ascender: number | undefined;

    for (const start of ranges) {
      const range = `${start}-${start + 255}`;
      const glyphs = await fetchRange(stackName, range);
      if (!glyphs) continue;

      stack.ranges[range] = encodeRuns(glyphs.map((glyph) => glyph.id));
      ascender ??= ascenderOf(glyphs);

      if (!COMPLETED_RANGES.includes(start)) continue;

      // Only the holes travel. A copy of upstream's whole range would be
      // megabytes of bytes GoWay already has a better glyph for.
      const covered = new Set(inter.get(start)!);
      const fill = glyphs.filter((glyph) => !covered.has(glyph.id) && isRenderable(glyph.id));
      if (fill.length === 0) continue;

      fill.sort((a, b) => a.id - b.id);
      const encoded = encodeGlyphs([{ name: stackName, range, glyphs: fill }]);
      const target = join(OUTPUT_DIR, stackName, `${range}.pbf`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, encoded);
      packBytes += encoded.length;
      packFiles += 1;
      console.log(`fallback: ${stackName} ${range} — ${fill.length} glyph(s), ${formatBytes(encoded.length)}`);
    }

    if (ascender === undefined) {
      throw new Error(
        `${stackName}: no blank glyph anywhere in the fetched ranges, so the ascender its \`top\` values are measured from cannot be read`,
      );
    }
    stack.ascender = ascender;
    coverage.stacks[stackName] = stack;
    console.log(`fallback: ${stackName} — ${Object.keys(stack.ranges).length} ranges, ascender ${ascender}px`);
  }

  const manifest = `${JSON.stringify(coverage, null, 2)}\n`;
  await writeFile(join(OUTPUT_DIR, COVERAGE_FILE), manifest);
  console.log(
    `fallback: ${formatBytes(manifest.length)} manifest, ${packFiles} pack file(s), ${formatBytes(packBytes)}`,
  );
  console.log('fallback: now run `bun run map:glyphs` and commit both.');
}

await main();
