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

  test('the flag module imports nothing', () => {
    const flag = files.find((f) => f.path === 'lib/map/liveFlag.ts');
    expect(staticImports(flag?.text ?? '')).toEqual([]);
  });
});
