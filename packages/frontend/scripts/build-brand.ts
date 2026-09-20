/**
 * Write GoWay's logo out as static SVG files, and fail on drift.
 *
 * ```bash
 * bun run --cwd packages/frontend brand          # write public/brand/*.svg
 * bun run --cwd packages/frontend brand:check    # fail if they are out of date
 * ```
 *
 * ## Why files exist at all when the app inlines the logo
 *
 * `components/brand/` draws the logo from geometry, so nothing in the app
 * fetches it (see the note there for why). But three consumers can only ever
 * take a URL, and none of them is optional:
 *
 *  - **The favicon.** `<link rel="icon">` takes an href, and an SVG favicon is
 *    the one that stays sharp in a 16px tab slot on a 2x display — see the
 *    honest limit recorded on `GOWAY_MARK`.
 *  - **Anyone embedding the map.** A partner putting `/frame` in their page
 *    will want the mark in their own docs, their own README, their own
 *    attribution line. `https://goway.to/brand/goway-wordmark.svg` is an answer
 *    they can paste; "clone the repo and read a TypeScript module" is not.
 *  - **Everything that is not this app.** Slides, a press page, the backend's
 *    error pages, the next Oxy product that links to GoWay.
 *
 * Which is exactly why this is generated and gated rather than hand-kept. Two
 * copies of a logo drift, silently and visibly — the file on the website stops
 * matching the one in the product and nobody notices until somebody puts them
 * side by side. `artwork.ts` is the master; these are its output; CI runs
 * `--check` and a stale file fails the build.
 *
 * The check is a byte comparison of the whole document, not of the path data,
 * so a changed `viewBox`, a changed colour or a changed `aria-label` fails it
 * too.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOWAY_INK,
  GOWAY_MARK,
  GOWAY_WORDMARK,
  type GowayArtwork,
} from '../components/brand/artwork';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(HERE, '..', 'public', 'brand');

/**
 * Serialise one artwork to a standalone SVG document.
 *
 * `role="img"` plus `aria-label` rather than a `<title>` element: a `<title>`
 * in an `<img src="…svg">` is not exposed at all (the image is opaque to the
 * embedding document), while both survive an inline paste, so the pair is the
 * one that works in every way this file is used.
 */
function render(artwork: GowayArtwork, label: string): string {
  const paths = artwork.paths
    .map((path) => `<path fill="${GOWAY_INK[path.ink]}" d="${path.d}"/>`)
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${artwork.viewBox}" ` +
    `role="img" aria-label="${label}">${paths}</svg>\n`
  );
}

const OUTPUTS: { file: string; body: string }[] = [
  { file: 'goway-wordmark.svg', body: render(GOWAY_WORDMARK, 'GoWay') },
  { file: 'goway-mark.svg', body: render(GOWAY_MARK, 'GoWay') },
];

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const problems: string[] = [];

  if (checkOnly) {
    for (const { file, body } of OUTPUTS) {
      const path = join(OUTPUT_DIR, file);
      let committed: string;
      try {
        committed = await readFile(path, 'utf8');
      } catch {
        problems.push(`public/brand/${file} is missing — run \`bun run brand\``);
        continue;
      }
      if (committed !== body) {
        problems.push(
          `public/brand/${file} is out of date — run \`bun run brand\` and commit the result`,
        );
      }
    }

    if (problems.length > 0) {
      console.error(`\nbrand: ${problems.length} problem(s)\n`);
      for (const problem of problems) console.error(`  • ${problem}`);
      console.error('');
      process.exit(1);
    }

    const bytes = OUTPUTS.reduce((total, output) => total + output.body.length, 0);
    console.log(`brand: OK — ${OUTPUTS.length} files in step with artwork.ts (${bytes} bytes)`);
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const { file, body } of OUTPUTS) {
    await writeFile(join(OUTPUT_DIR, file), body, 'utf8');
    console.log(`brand: wrote public/brand/${file} (${body.length} bytes)`);
  }
}

await main();
