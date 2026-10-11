/**
 * three.js stays in ONE lazy chunk.
 *
 * Expo hoists a module reachable from two `import()`-ed chunks into the
 * first-paint `__common` chunk (see `components/engine3d/lazyChunk.ts`). When
 * the city-3D engine first imported `three` from its own lazy chunk beside
 * Street 3D's, that moved 834 KB of renderer onto every page load — with the
 * feature switched OFF. Nothing failed: the build, the types and every test
 * were green, and the only signal was a file size in an export log.
 *
 * So this reads the source tree and pins the shape that prevents it:
 *
 *  - only the two engine modules import `three` or `@sparkjsdev/spark` at
 *    runtime (`import type` is erased and allowed anywhere);
 *  - nothing reaches either engine except `engine3d/lazyChunk.ts`, and the
 *    MapLibre adapter imports the city engine's folder for types only;
 *  - `lazyChunk.ts` is only ever imported dynamically.
 *
 * A text check rather than a bundle check because it runs in milliseconds in
 * `bun test`; the bundle itself was measured with `expo export --platform web`
 * and the numbers are in `docs/MAP_3D_CITY.md`.
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

/** Runtime (non-type) imports of a module, static or dynamic. */
function runtimeImports(text: string, module: RegExp): string[] {
  const found: string[] = [];
  const statics = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const exportsFrom = /^\s*export\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const dynamics = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [statics, exportsFrom, dynamics]) {
    for (const match of text.matchAll(pattern))
      if (module.test(match[1])) found.push(match[0].trim());
  }
  return found;
}

const ENGINES = [
  'components/street3d/engine/sparkEngine.ts',
  'components/map/engine/city3d/cityEngine.ts',
];
const CHUNK = 'components/engine3d/lazyChunk.ts';

describe('the three.js chunk', () => {
  test('the scan sees the engines (a vacuity check)', () => {
    for (const engine of [...ENGINES, CHUNK])
      expect(files.some((f) => f.path === engine)).toBe(true);
  });

  test('only the engines import three.js or Spark at runtime', () => {
    const offenders = files
      .filter((f) => !ENGINES.includes(f.path))
      .filter((f) => runtimeImports(f.text, /^(three|@sparkjsdev\/spark)(\/|$)/).length > 0)
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('only lazyChunk.ts reaches the engines at runtime', () => {
    const offenders = files
      .filter((f) => f.path !== CHUNK)
      .filter((f) => runtimeImports(f.text, /(sparkEngine|city3d\/cityEngine)$/).length > 0)
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('the MapLibre adapter imports the city engine folder type-only', () => {
    // Anything it imported at runtime from there would be shared with the
    // engine chunk and hoisted into `__common` too: measured, `occlusion.ts`
    // was, until the adapter stopped importing its defaults.
    const adapter = files.find((f) => f.path === 'components/map/city3dLayer.web.ts');
    expect(adapter).toBeDefined();
    expect(runtimeImports(adapter?.text ?? '', /engine\/city3d\//)).toEqual([]);
  });

  test('lazyChunk.ts is only ever imported dynamically', () => {
    const statics = files.filter((f) =>
      /^\s*import\s+(?!type\b)[^;]*?from\s+['"][^'"]*engine3d\/lazyChunk['"]/m.test(f.text),
    );
    expect(statics.map((f) => f.path)).toEqual([]);
    // The chunk's own header shows the call as usage; it does not import itself.
    const dynamics = files
      .filter((f) => f.path !== CHUNK)
      .filter((f) => /import\(\s*['"][^'"]*engine3d\/lazyChunk['"]\s*\)/.test(f.text));
    expect(dynamics.map((f) => f.path).sort()).toEqual([
      'components/map/city3dLayer.web.ts',
      'components/street3d/SceneViewer.web.tsx',
    ]);
  });
});
