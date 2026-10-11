/**
 * With globe and terrain off, the web map's first paint is what it was.
 *
 * The relief prototype is one lazy chunk (`components/map/reliefLayer.web.ts`)
 * that `MapCanvas.web.tsx` requests only when a flag asks for it. Two ways to
 * break that without any test, type or build failing, both learned on the city
 * layer (`engine3dChunk.test.ts`): a STATIC import of the chunk (it joins the
 * entry bundle), or a module the chunk shares with another lazy chunk (Expo
 * hoists it into the first-paint `__common`). So this pins, from the source:
 *
 *  - the relief adapter is only ever imported dynamically;
 *  - the style fragments (`lib/map/style/relief.ts`) are imported at runtime
 *    only by that adapter and by the native map (a different bundle);
 *  - the city layer follows terrain without importing either of them.
 *
 * The bundle itself was measured with `expo export --platform web`; the
 * numbers are in `docs/MAP_TERRAIN_GLOBE.md`.
 */
import { describe, expect, test } from 'bun:test';
import { SOURCE_FILES } from './sourceScan';

const files = SOURCE_FILES;

function imports(text: string, module: RegExp): { statics: string[]; dynamics: string[] } {
  const statics: string[] = [];
  const dynamics: string[] = [];
  const staticPattern = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm;
  for (const match of text.matchAll(staticPattern))
    if (module.test(match[1])) statics.push(match[0]);
  for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g))
    if (module.test(match[1])) dynamics.push(match[0]);
  return { statics, dynamics };
}

const ADAPTER = /(^|\/)reliefLayer\.web$/;
const FRAGMENTS = /(^|\/)style\/relief$/;

describe('the relief chunk', () => {
  test('the scan sees the relief modules (a vacuity check)', () => {
    for (const path of [
      'components/map/reliefLayer.web.ts',
      'lib/map/style/relief.ts',
      'components/map/MapCanvas.web.tsx',
      'components/map/city3dGround.web.ts',
    ]) {
      expect(files.some((file) => file.path === path)).toBe(true);
    }
  });

  test('the adapter is imported only dynamically, and only by the web map', () => {
    const statics = files.filter((file) => imports(file.text, ADAPTER).statics.length > 0);
    expect(statics.map((file) => file.path)).toEqual([]);
    // (The adapter's own header quotes the `import()` that loads it.)
    const dynamics = files
      .filter((file) => file.path !== 'components/map/reliefLayer.web.ts')
      .filter((file) => imports(file.text, ADAPTER).dynamics.length > 0);
    expect(dynamics.map((file) => file.path)).toEqual(['components/map/MapCanvas.web.tsx']);
  });

  test('the style fragments load with the adapter (or on native), never at first paint', () => {
    const users = files
      .filter((file) => {
        const found = imports(file.text, FRAGMENTS);
        return found.statics.length + found.dynamics.length > 0;
      })
      .map((file) => file.path)
      .sort();
    expect(users).toEqual([
      'components/map/MapCanvas.native.tsx',
      'components/map/reliefLayer.web.ts',
    ]);
  });

  test('the city layer follows terrain without reaching into the relief chunk', () => {
    const bridge = files.find((file) => file.path === 'components/map/city3dGround.web.ts');
    const found = imports(bridge?.text ?? '', /relief/);
    expect([...found.statics, ...found.dynamics]).toEqual([]);
  });
});
