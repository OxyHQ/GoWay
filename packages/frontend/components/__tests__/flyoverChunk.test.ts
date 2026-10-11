/**
 * The flyover and Camera Studio stay in ONE lazy chunk, and out of the entry.
 *
 * Two screens open the feature (`ExploreScreen`'s "Fly the route" and
 * `app/studio.tsx`), and both use `lib/map/camera/`. Expo's web serializer
 * hoists a module reachable from two `import()`-ed chunks into the
 * first-paint `__common` chunk (`components/engine3d/lazyChunk.ts` has the
 * measurement), so both go through `features/flyover/lazy.ts` and nothing
 * else may import the feature's modules statically. A text check, like
 * `engine3dChunk.test.ts`, because it runs in milliseconds; the bundle was
 * measured with `expo export --platform web` (`docs/MAP_CAMERA_STUDIO.md`).
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

/** Static, non-type import specifiers of a file. */
function staticImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm,
  ))
    out.push(m[1]);
  return out;
}

const inFeature = (path: string) =>
  path.startsWith('features/flyover/') ||
  path.startsWith('lib/map/camera/') ||
  path === 'lib/map/tourLink.ts';
const featureSpecifier = /(^@\/features\/flyover\/|^@\/lib\/map\/camera\/|^@\/lib\/map\/tourLink$)/;

describe('the flyover chunk', () => {
  test('the scan sees the feature (a vacuity check)', () => {
    for (const path of [
      'features/flyover/lazy.ts',
      'lib/map/camera/routeFlyover.ts',
      'app/studio.tsx',
    ])
      expect(files.some((f) => f.path === path)).toBe(true);
  });

  test('nothing outside the feature imports it statically', () => {
    const offenders = files
      .filter((f) => !inFeature(f.path))
      .filter((f) => staticImports(f.text).some((spec) => featureSpecifier.test(spec)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('the feature is only ever entered through lazy.ts, by the two screens', () => {
    // The chunk's own header shows the call as usage; it does not import itself.
    const dynamics = files
      .filter((f) => f.path !== 'features/flyover/lazy.ts')
      .filter((f) => /import\(\s*['"]@\/features\/flyover\/[^'"]*['"]\s*\)/.test(f.text))
      .map((f) => ({
        path: f.path,
        targets: [
          ...f.text.matchAll(/import\(\s*['"](@\/features\/flyover\/[^'"]*)['"]\s*\)/g),
        ].map((m) => m[1]),
      }));
    expect(dynamics.map((d) => d.path).sort()).toEqual([
      'app/studio.tsx',
      'features/explore/ExploreScreen.tsx',
    ]);
    for (const d of dynamics) expect(d.targets).toEqual(['@/features/flyover/lazy']);
  });

  test('the feature never reaches three.js or an engine', () => {
    const offenders = files
      .filter((f) => inFeature(f.path))
      .filter((f) =>
        staticImports(f.text).some((spec) =>
          /^(three|maplibre-gl|@maplibre\/)|engine3d|engine\/city3d/.test(spec),
        ),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
