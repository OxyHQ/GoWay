/**
 * GoWay Live adds nothing to first paint with its flag off.
 *
 * The layer is three lazy pieces — the feature (`features/live`: the socket
 * client, the store, the panel), the MapLibre adapter (`liveLayer.web.ts`)
 * and the 3D pass (in the three.js chunk) — and each is reachable only
 * through an `import()` that runs when the flag is on. The trap this guards
 * is Expo's: a module reachable from two `import()`-ed chunks is hoisted into
 * the first-paint `__common` chunk (`~/Oxy/docs/build-and-runtime-traps.md`),
 * and a STATIC import from anything in the entry graph puts a module in the
 * entry outright. So:
 *
 *  - `socket.io-client` and `@goway.to/sdk/live` (the live protocol, kept out
 *    of the SDK's main entry for exactly this) are imported only inside
 *    `features/live`;
 *  - nothing outside `features/live` imports it, except the ONE dynamic
 *    `import()` in `ExploreScreen.tsx`;
 *  - `liveLayer.web.ts` is reached only by `import()` from `MapCanvas.web.tsx`,
 *    and shares no runtime module with `features/live` beyond what the entry
 *    already has (it receives the palette as data).
 *
 * The bundle itself was measured with `expo export --platform web`; the
 * numbers are in `docs/MAP_LIVE.md`.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SCANNED = ['app', 'components', 'features', 'lib'];

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

function staticImports(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm,
    /^\s*export\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm,
  ]) {
    for (const match of text.matchAll(pattern)) found.push(match[1] ?? '');
  }
  return found;
}

function dynamicImports(text: string): string[] {
  return [...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? '');
}

const inFeature = (path: string) => path.startsWith('features/live/');

describe('the live chunk', () => {
  test('the scan sees the feature (a vacuity check)', () => {
    for (const path of [
      'features/live/LiveHost.tsx',
      'components/map/liveLayer.web.ts',
      'lib/map/liveFlag.ts',
    ])
      expect(files.some((f) => f.path === path)).toBe(true);
  });

  test('socket.io-client is only ever import()ed — @oxy.so/core already lazy-loads it', () => {
    // A STATIC import from a second lazy chunk would make it shared, and Expo
    // hoists a shared module into the first-paint `__common` chunk (measured:
    // +54 KB with the flag off, before this was an import()).
    const statics = files
      .filter((f) => staticImports(f.text).some((spec) => spec === 'socket.io-client'))
      .map((f) => f.path);
    expect(statics).toEqual([]);
    const dynamics = files
      .filter((f) => dynamicImports(f.text).includes('socket.io-client'))
      .map((f) => f.path);
    expect(dynamics).toEqual(['features/live/liveClient.ts']);
  });

  test('the socket client and the live protocol are imported only inside features/live', () => {
    const offenders = files
      .filter((f) => !inFeature(f.path))
      .filter((f) =>
        staticImports(f.text).some((spec) =>
          /^(socket\.io-client|@goway\.to\/sdk\/live)$/.test(spec),
        ),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('nothing outside the feature reaches it, except one import() in ExploreScreen', () => {
    const statics = files
      .filter((f) => !inFeature(f.path))
      .filter((f) => staticImports(f.text).some((spec) => spec.includes('features/live')))
      .map((f) => f.path);
    expect(statics).toEqual([]);
    const dynamics = files
      .filter((f) => !inFeature(f.path))
      .filter((f) => dynamicImports(f.text).some((spec) => spec.includes('features/live')))
      .map((f) => f.path);
    expect(dynamics).toEqual(['features/explore/ExploreScreen.tsx']);
  });

  test('the adapter is reached only by import() from MapCanvas.web.tsx, and imports nothing of the feature', () => {
    const statics = files.filter((f) =>
      staticImports(f.text).some((spec) => /liveLayer\.web$/.test(spec)),
    );
    expect(statics.map((f) => f.path)).toEqual([]);
    // The adapter's own header shows the call as usage; it does not import itself.
    const dynamics = files
      .filter((f) => f.path !== 'components/map/liveLayer.web.ts')
      .filter((f) => dynamicImports(f.text).some((spec) => /liveLayer\.web$/.test(spec)));
    expect(dynamics.map((f) => f.path)).toEqual(['components/map/MapCanvas.web.tsx']);
    const adapter = files.find((f) => f.path === 'components/map/liveLayer.web.ts');
    expect(staticImports(adapter?.text ?? '').filter((spec) => spec.includes('features/'))).toEqual(
      [],
    );
  });

  test('the live HTTP client is only ever import()ed — two lazy chunks share it', () => {
    // The live chunk (its availability check and shape cache) and the settings
    // dialog (its own chunk) all use it; a static import from either would
    // hoist it into `__common` (measured: +272 B there before both were import()s).
    const statics = files
      .filter((f) => staticImports(f.text).some((spec) => /lib\/live\/client$/.test(spec)))
      .map((f) => f.path);
    expect(statics).toEqual([]);
    const dynamics = files
      .filter((f) => dynamicImports(f.text).some((spec) => /lib\/live\/client$/.test(spec)))
      .map((f) => f.path)
      .sort();
    expect(dynamics).toEqual([
      'features/explore/MapSettingsModal.tsx',
      'features/live/LiveHost.tsx',
      'features/live/shapeCache.ts',
    ]);
  });

  test('the flag module and the coverage channel import nothing', () => {
    for (const path of ['lib/map/liveFlag.ts', 'lib/live/coverage.ts']) {
      const file = files.find((f) => f.path === path);
      expect(file).toBeDefined();
      expect(staticImports(file?.text ?? '')).toEqual([]);
    }
  });
});
