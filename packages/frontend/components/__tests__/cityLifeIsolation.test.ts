/**
 * The city-life simulation is drawn and never read: nothing in the app may
 * import it except the lazy engine chunk (which draws it) — not routing, not
 * search, not a place screen, not an ETA (`docs/MAP_CITY_LIFE.md` → Honesty).
 * The MapLibre adapter may name its TYPES, which are erased.
 *
 * A text scan, like `engine3dChunk.test.ts`: it runs in milliseconds and it
 * fails the moment a feature starts depending on simulated traffic.
 */
import { describe, expect, test } from 'bun:test';
import { SOURCE_FILES } from './sourceScan';

const FOLDER = 'components/map/engine/cityLife/';
const files = SOURCE_FILES;

/** Runtime (non-type) import specifiers, static or dynamic. */
function runtimeSpecifiers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm,
    /^\s*export\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of text.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

describe('city life is drawn, never read', () => {
  test('the scan sees the simulation (a vacuity check)', () => {
    expect(files.some((f) => f.path === `${FOLDER}sim/simulation.ts`)).toBe(true);
  });

  test('only the lazy engine chunk imports it at runtime', () => {
    const offenders = files
      .filter((f) => !f.path.startsWith(FOLDER) && f.path !== 'components/engine3d/lazyChunk.ts')
      .filter((f) => runtimeSpecifiers(f.text).some((s) => /(^|\/)cityLife\//.test(s)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
