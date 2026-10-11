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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SCANNED = ['app', 'components', 'features', 'lib'];
const FOLDER = 'components/map/engine/cityLife/';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') out.push(...sources(path));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir))).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

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
