/**
 * Gates on the logo's data.
 *
 * `artwork.ts` is 53 kB of machine-written path data that no reviewer will read
 * and no type checker can judge, and it is consumed by two pipelines that share
 * no build step: `react-native-svg` inside the app, and a CSS variable on the
 * web. So the properties that make it a LOGO rather than a blob of numbers are
 * asserted here instead of trusted.
 *
 * This file imports `artwork.ts` and nothing else from the app. That is
 * deliberate — reaching one module further would pull in `react-native-svg`,
 * whose Flow-typed sources Bun cannot parse (see the note in
 * `components/map/__tests__/nanCoordinates.test.ts`), and the data would stop
 * being testable at all.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GOWAY_INK,
  GOWAY_MARK,
  GOWAY_PATHS,
  GOWAY_WORDMARK,
  aspectRatio,
} from '../artwork';

const GLOBAL_CSS = join(import.meta.dir, '..', '..', '..', 'global.css');

describe('brand ink', () => {
  /**
   * The one assertion that stops the two spellings of GoWay's blue drifting.
   *
   * React Native cannot read a CSS variable and Tailwind cannot read a TS
   * constant, so `global.css` and `GOWAY_INK` each hold a copy. A copy nobody
   * checks is a copy that diverges — and it diverges INVISIBLY, because each
   * side keeps rendering its own colour perfectly and the two only ever meet in
   * a screenshot.
   */
  test('global.css declares exactly the artwork colours', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf8');
    expect(css).toContain(`--color-brand-goway: ${GOWAY_INK.outline};`);
    expect(css).toContain(`--color-brand-goway-tint: ${GOWAY_INK.go};`);
  });

  /**
   * AGENTS.md: never restate a token Bloom already defines. `--primary` is
   * Bloom's, written at runtime by `BloomThemeProvider` from the user's chosen
   * theme; redefining it here would make the logo follow the theme AND repaint
   * every Bloom control in the app.
   */
  test('the brand blue is never assigned to a Bloom token', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf8');
    for (const bloomToken of ['--primary', '--ring', '--accent', '--foreground']) {
      for (const hex of Object.values(GOWAY_INK)) {
        expect(css).not.toContain(`${bloomToken}: ${hex}`);
      }
    }
  });

  test('every path is painted with one of the three inks', () => {
    for (const path of GOWAY_PATHS) {
      expect(GOWAY_INK[path.ink]).toBeDefined();
    }
  });
});

describe('artwork geometry', () => {
  test('the wordmark is cropped to its ink, not to the export canvas', () => {
    // The delivered file was `0 0 1820.25 1530.75` around ink that occupied
    // 1404.59 x 887.91 of it — 42% vertical and 23% horizontal dead space that
    // every `<img>` would have inherited as invisible padding.
    expect(GOWAY_WORDMARK.viewBox).toBe('0 0 1404.59 887.9');
    expect(aspectRatio(GOWAY_WORDMARK)).toBeCloseTo(1.582, 3);
  });

  test('the mark is a crop of the wordmark, never a second drawing', () => {
    // Identity, not equality: the mark's paths must BE wordmark paths, so the
    // two can never be revised apart.
    for (const path of GOWAY_MARK.paths) {
      expect(GOWAY_PATHS).toContain(path);
    }
    expect(GOWAY_MARK.paths.map((path) => path.part)).toEqual(['g', 'g']);
    // Near-square, which is what makes it usable as an icon at all.
    expect(aspectRatio(GOWAY_MARK)).toBeCloseTo(0.98, 2);
  });

  test('draw order puts every outline before its fill', () => {
    // "G" and "O" overlap horizontally, so O's outline sits under G's fill;
    // re-sorting this array by ink or by part changes the artwork.
    const firstFill = GOWAY_PATHS.findIndex((path) => path.layer === 'fill');
    expect(firstFill).toBeGreaterThan(0);
    for (const path of GOWAY_PATHS.slice(0, firstFill)) {
      expect(path.layer).toBe('outline');
    }
  });

  test('path data carries no coordinate finer than 2 decimal places', () => {
    // The precision was measured, not chosen: 2 dp renders indistinguishably
    // from the original and 0 dp destroys the wordmark. Anything finer is bytes
    // in every bundle for a difference no display can show.
    for (const path of GOWAY_PATHS) {
      expect(path.d).not.toMatch(/\.\d{3}/);
    }
  });
});
