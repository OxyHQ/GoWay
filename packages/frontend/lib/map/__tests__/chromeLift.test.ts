/**
 * The bottom chrome (the data credit, "My location") stays above a sheet's
 * LIVE top edge on a phone: visible at load with the sheet at half, riding it
 * while dragged, never climbing into the top bar, fading only as the sheet
 * takes the screen — and untouched where there is no sheet.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHROME_HIDDEN_RATIO, CHROME_MAX_RISE_RATIO, chromeLift } from '@/lib/map/chromeLift';

const H = 844;
const PEEK = 120;

describe('chromeLift', () => {
  test('no sheet, or a sheet at its claim: no lift, fully visible', () => {
    expect(chromeLift({ sheetHeight: 0, claimed: 0, windowHeight: H })).toEqual({
      lift: 0,
      opacity: 1,
    });
    expect(chromeLift({ sheetHeight: PEEK, claimed: PEEK, windowHeight: H })).toEqual({
      lift: 0,
      opacity: 1,
    });
  });

  test('at half (where the explore sheet opens) the chrome clears its top edge, visible', () => {
    const half = Math.round(H * 0.45);
    const { lift, opacity } = chromeLift({ sheetHeight: half, claimed: PEEK, windowHeight: H });
    // Laid out above the claim, lifted the rest of the way: bottom = sheet top.
    expect(PEEK + lift).toBe(half);
    expect(opacity).toBe(1);
  });

  test('rides a drag, stops rising at the cap, fades out by the hidden ratio', () => {
    const at = (h: number) => chromeLift({ sheetHeight: h, claimed: PEEK, windowHeight: H });
    expect(at(300).lift).toBeLessThan(at(350).lift);
    const cap = H * CHROME_MAX_RISE_RATIO;
    expect(at(cap + 100).lift).toBe(cap - PEEK);
    expect(at(cap).opacity).toBe(1);
    expect(at(H * CHROME_HIDDEN_RATIO).opacity).toBe(0);
    const mid = at((cap + H * CHROME_HIDDEN_RATIO) / 2).opacity;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  test('a degenerate window or height lifts nothing', () => {
    expect(chromeLift({ sheetHeight: Number.NaN, claimed: PEEK, windowHeight: H })).toEqual({
      lift: 0,
      opacity: 1,
    });
    expect(chromeLift({ sheetHeight: 400, claimed: PEEK, windowHeight: 0 })).toEqual({
      lift: 0,
      opacity: 1,
    });
  });
});

describe('wired', () => {
  const read = (path: string) =>
    readFileSync(join(import.meta.dir, '..', '..', '..', path), 'utf8');

  test('the explore screen hands the sheet height to the credit and the controls', () => {
    const screen = read('features/explore/ExploreScreen.tsx');
    expect(screen).toContain('animatedHeight={sheetHeight}');
    expect(screen).toContain('<MapChromeLiftContext.Provider');
    expect(screen).toMatch(/chromeLift\(\{ sheetHeight: sheetHeight\.value/);
  });

  test('the credit reads it, and falls back to its own spot without it', () => {
    // The credit is `@goway.to/maps`'s; the lift reaches it through its context.
    const credit = read('../maps/src/MapAttribution.tsx');
    expect(credit).toContain('useMapChromeLift()');
    expect(credit).toContain('<LiftedBox');
    // The box is shared with the scale bar; the fallback lives there.
    expect(read('../maps/src/LiftedBox.tsx')).toMatch(/if \(!lift\) \{/);
  });
});
