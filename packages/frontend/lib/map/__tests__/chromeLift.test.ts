/**
 * The bottom chrome (the data credit, "My location") stays above a sheet's
 * LIVE top edge on a phone: visible at load with the sheet at half, riding it
 * while dragged, never climbing into the top bar, fading only as the sheet
 * takes the screen — and untouched where there is no sheet.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromeLift } from '@/lib/map/chromeLift';

describe('measured control occupancy', () => {
  test('last fitting footprint remains visible; one pixel of overlap removes the target', () => {
    expect(chromeLift({ sheetHeight: 300, claimed: 120, maximumSheetHeight: 300 })).toEqual({
      lift: 180,
      opacity: 1,
    });
    expect(chromeLift({ sheetHeight: 301, claimed: 120, maximumSheetHeight: 300 })).toEqual({
      lift: 181,
      opacity: 0,
    });
  });
  test('downward drag follows the panel and restores controls when room returns', () => {
    expect(chromeLift({ sheetHeight: 200, claimed: 380, maximumSheetHeight: 300 })).toEqual({
      lift: -180,
      opacity: 1,
    });
  });
  test('no available room or invalid footprint cannot expose an invisible target', () => {
    expect(chromeLift({ sheetHeight: 120, claimed: 120, maximumSheetHeight: -1 }).opacity).toBe(0);
    expect(chromeLift({ sheetHeight: NaN, claimed: 120, maximumSheetHeight: 300 }).opacity).toBe(0);
  });
});

describe('wired', () => {
  const read = (path: string) =>
    readFileSync(join(import.meta.dir, '..', '..', '..', path), 'utf8');

  test('the explore screen hands the sheet height to the credit and the controls', () => {
    const screen = read('features/explore/ExploreScreen.tsx');
    expect(screen).toContain('animatedHeight={sheetHeight}');
    expect(screen).toContain('<MapChromeLiftContext.Provider');
    expect(screen).toMatch(/chromeLift\(\{\s*sheetHeight: sheetHeight\.value/);
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
