/**
 * The landmarks stay out of first paint (`docs/MAP_LANDMARKS.md` → What the
 * flag costs).
 *
 *  - The tour UI is ONE lazy chunk, `features/landmarks/lazy.ts`, entered only
 *    by `import()` from `ExploreScreen` (the flyover's rule, for the same
 *    `__common` reason — see `flyoverChunk.test.ts`).
 *  - The registry reader, `lib/map/landmarks/load.ts`, is used by TWO lazy
 *    chunks (the map adapter and the tour), so neither may import it
 *    statically: each reaches it by `import()`, which makes it an async chunk
 *    of its own instead of a first-paint `__common` module. The schema
 *    (`registry.ts`) is reached only through it.
 *  - Nothing in the feature reaches three.js, MapLibre or an engine.
 */
import { describe, expect, test } from 'bun:test';
import { SOURCE_FILES } from './sourceScan';

const files = SOURCE_FILES;

function staticImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm,
  ))
    out.push(m[1]);
  return out;
}

function dynamicImports(text: string): string[] {
  return [...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

const featureSpecifier =
  /(^@\/features\/landmarks\/|^@\/lib\/map\/landmarks\/(tour|match)$|^\.\/(LandmarkEntry|LandmarkOverlay|LandmarkTour|useLandmarks)$)/;
const inFeature = (path: string) =>
  path.startsWith('features/landmarks/') ||
  path === 'lib/map/landmarks/tour.ts' ||
  path === 'lib/map/landmarks/match.ts';

describe('the landmarks chunks', () => {
  test('the scan sees them (a vacuity check)', () => {
    for (const path of [
      'features/landmarks/lazy.ts',
      'lib/map/landmarks/load.ts',
      'lib/map/landmarks/registry.ts',
      'features/explore/ExploreScreen.tsx',
      'components/map/city3dLayer.web.ts',
    ])
      expect(files.some((f) => f.path === path)).toBe(true);
  });

  test('nothing outside the tour UI imports it statically', () => {
    const offenders = files
      .filter((f) => !inFeature(f.path))
      .filter((f) => staticImports(f.text).some((spec) => featureSpecifier.test(spec)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('the tour UI is entered only through lazy.ts, by ExploreScreen', () => {
    const dynamics = files
      .filter((f) => f.path !== 'features/landmarks/lazy.ts')
      .filter((f) =>
        dynamicImports(f.text).some((spec) => spec.startsWith('@/features/landmarks/')),
      );
    expect(dynamics.map((f) => f.path)).toEqual(['features/explore/ExploreScreen.tsx']);
    for (const f of dynamics) {
      // The tour overlay, the place action and the pill (which sits in the
      // screen's top-right stack): every one through lazy.ts.
      const specs = dynamicImports(f.text).filter((spec) =>
        spec.startsWith('@/features/landmarks/'),
      );
      expect(specs.length).toBeGreaterThan(0);
      expect(new Set(specs)).toEqual(new Set(['@/features/landmarks/lazy']));
    }
  });

  test('the registry reader is only ever imported dynamically, by its three users', () => {
    const statics = files
      .filter((f) => f.path !== 'lib/map/landmarks/load.ts')
      .filter((f) =>
        staticImports(f.text).some((spec) => /landmarks\/(load|registry)$/.test(spec)),
      );
    expect(statics.map((f) => f.path)).toEqual([]);
    // load.ts's own header shows the call as usage; it does not import itself.
    const dynamics = files
      .filter((f) => f.path !== 'lib/map/landmarks/load.ts')
      .filter((f) => dynamicImports(f.text).includes('@/lib/map/landmarks/load'))
      .map((f) => f.path)
      .sort();
    expect(dynamics).toEqual([
      'components/map/city3dLayer.web.ts',
      // The settings modal's About lists every landmark model's licence.
      'features/explore/MapSettingsModal.tsx',
      'features/landmarks/useLandmarks.ts',
    ]);
  });

  test('the tour UI never reaches three.js, MapLibre or an engine', () => {
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
