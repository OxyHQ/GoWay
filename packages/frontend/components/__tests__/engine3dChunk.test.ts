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
 *  - only the two engine modules — and their parts (`cityMeshes.ts`, the
 *    sky's `sky.ts`), which only the city engine reaches — load `three` or
 *    `@sparkjsdev/spark` at runtime (`import type` is erased and allowed
 *    anywhere);
 *  - nothing reaches either engine except `engine3d/lazyChunk.ts`, and the
 *    MapLibre adapter imports the city engine's folder for types only;
 *  - `lazyChunk.ts` is only ever imported dynamically.
 *
 * A text check rather than a bundle check because it runs in milliseconds in
 * `bun test`; the bundle itself was measured with `expo export --platform web`
 * and the numbers are in `docs/MAP_3D_CITY.md`.
 */
import { describe, expect, test } from 'bun:test';
import { SOURCE_FILES } from './sourceScan';

const files = SOURCE_FILES;

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
  // The model layer is part of the city engine (one scene, one renderer —
  // docs/SDK_MAP_MODELS.md), imported only by `cityEngine.ts`.
  'components/map/engine/city3d/models.ts',
  // The city engine's GPU-side tile entries; reached only from cityEngine.ts.
  'components/map/engine/city3d/cityMeshes.ts',
  // The city-life renderer is an overlay of the same engine (`overlay.ts`),
  // reached only through `lazyChunk.ts`.
  'components/map/engine/cityLife/lifeRenderer.ts',
  // The street-detail renderer is another overlay of the same engine,
  // reached only through `lazyChunk.ts` (`docs/MAP_STREETS.md`).
  'components/map/engine/cityStreets/streetRenderer.ts',
  // How models (and landmarks) are lit by day and night, imported only by `models.ts`.
  'components/map/engine/city3d/modelLook.ts',
  // GoWay Live's 3D shapes: a pass the city engine draws (`docs/MAP_LIVE.md`).
  'components/map/engine/live3d/livePass.ts',
  // The glTF loader with the meshopt decoder, shared by the model layer and the library.
  'components/map/engine/city3d/gltf.ts',
  // The shared model library (`docs/MODEL_LIBRARY.md`), loaded by city life and the live pass.
  'components/map/engine/vehicles/library.ts',
  // three's WebGPU build (docs/MAP_NATIVE_3D.md): the TSL materials, what
  // they share and the pass that draws them, reached only by the city engine
  // (below); and the phase 1 tile view, reached by no app module (only
  // `scripts/` and the native harness).
  'components/map/engine/city3d/tsl/buildingMaterial.ts',
  'components/map/engine/city3d/tsl/buildingSurface.ts',
  'components/map/engine/city3d/tsl/common.ts',
  // The city sky's: its light, haze and shadow nodes, its ground passes, the
  // sky-lit buildings and the detailed look's response.
  'components/map/engine/city3d/tsl/skyNodes.ts',
  'components/map/engine/city3d/tsl/skyPasses.ts',
  'components/map/engine/city3d/tsl/skyBuildingMaterial.ts',
  'components/map/engine/city3d/tsl/detailedMaterial.ts',
  'components/map/engine/city3d/tsl/treeMaterial.ts',
  'components/map/engine/city3d/tsl/tslPass.ts',
  'components/map/engine/city3d/tsl/cityTileView.ts',
];
/** The TSL modules' folder, and the only app modules allowed to reach into it. */
const TSL = 'components/map/engine/city3d/tsl/';
const TSL_REACHERS = [
  'components/map/engine/city3d/cityEngine.ts',
  'components/map/engine/city3d/cityMeshes.ts',
  // The city sky (an engine part): its nodes, passes and the pass it draws with.
  'components/map/engine/city3d/sky.ts',
  // The street detail's TSL materials (`docs/MAP_NATIVE_3D.md` → step 5).
  'components/map/engine/cityStreets/streetMaterials.ts',
  // City life's TSL materials.
  'components/map/engine/cityLife/lifeMaterials.ts',
];
const CHUNK = 'components/engine3d/lazyChunk.ts';
/**
 * three.js modules that are part of an engine, not engines of their own: they
 * may import `three`, but only their engine may reach them, so they are in the
 * same lazy chunk by construction.
 */
const ENGINE_PARTS: Record<string, string> = {
  'components/map/engine/city3d/sky.ts': 'components/map/engine/city3d/cityEngine.ts',
  // The materials built ahead of the first tiles, over real tile entries.
  'components/map/engine/city3d/materialWarmup.ts': 'components/map/engine/city3d/cityEngine.ts',
  // The street detail's TSL materials and ground atlas, parts of its renderer.
  'components/map/engine/cityStreets/streetMaterials.ts':
    'components/map/engine/cityStreets/streetRenderer.ts',
  // Still, untextured models as one or two draws (`docs/MAP_NATIVE_3D.md`).
  'components/map/engine/city3d/modelBatch.ts': 'components/map/engine/city3d/models.ts',
  // City life's TSL materials, and the library's nodes they read.
  'components/map/engine/cityLife/lifeMaterials.ts':
    'components/map/engine/cityLife/lifeRenderer.ts',
  'components/map/engine/vehicles/libraryNodes.ts':
    'components/map/engine/cityLife/lifeMaterials.ts',
};

describe('the three.js chunk', () => {
  test('the scan sees the engines (a vacuity check)', () => {
    for (const engine of [...ENGINES, CHUNK, ...Object.keys(ENGINE_PARTS)])
      expect(files.some((f) => f.path === engine)).toBe(true);
  });

  test('only the engines import three.js or Spark at runtime', () => {
    const offenders = files
      .filter((f) => !ENGINES.includes(f.path) && !(f.path in ENGINE_PARTS))
      .filter((f) => runtimeImports(f.text, /^(three|@sparkjsdev\/spark)(\/|$)/).length > 0)
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('only the city engine reaches the TSL modules at runtime', () => {
    const offenders = files
      .filter((f) => !f.path.startsWith(TSL) && !TSL_REACHERS.includes(f.path))
      .filter((f) => runtimeImports(f.text, /(city3d\/tsl\/|^\.\/tsl\/)/).length > 0)
      .map((f) => f.path);
    expect(offenders).toEqual([]);
    const tileView = files
      .filter((f) => runtimeImports(f.text, /cityTileView$/).length > 0)
      .map((f) => f.path);
    expect(tileView).toEqual([]);
  });

  test('only the city engine reaches the model layer at runtime', () => {
    const offenders = files
      .filter((f) => f.path !== 'components/map/engine/city3d/cityEngine.ts')
      .filter((f) => runtimeImports(f.text, /city3d\/models$|^\.\/models$/).length > 0)
      .filter((f) => f.path.startsWith('components/map/engine/'))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('an engine part is reached only by its engine', () => {
    for (const [part, engine] of Object.entries(ENGINE_PARTS)) {
      const name = part.split('/').pop()?.replace(/\.ts$/, '') ?? part;
      const reachers = files
        .filter((f) => f.path !== part)
        .filter((f) => runtimeImports(f.text, new RegExp(`/${name}$`)).length > 0)
        .map((f) => f.path);
      expect(reachers).toEqual([engine]);
    }
  });

  test('only lazyChunk.ts reaches the engines at runtime', () => {
    const offenders = files
      .filter((f) => f.path !== CHUNK)
      .filter(
        (f) =>
          runtimeImports(
            f.text,
            /(sparkEngine|city3d\/cityEngine|cityLife\/lifeRenderer|live3d\/livePass|cityStreets\/streetRenderer)$/,
          ).length > 0,
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('only the city engine reaches cityMeshes.ts at runtime', () => {
    // It imports three, so anything else importing it would put three (and
    // it) into a second chunk, and both into `__common`.
    const importers = files
      .filter((f) => runtimeImports(f.text, /(^|\/)cityMeshes$/).length > 0)
      .map((f) => f.path);
    expect(importers.sort()).toEqual([
      'components/map/engine/city3d/cityEngine.ts',
      // The material warm-up's tile entries: an engine part (below).
      'components/map/engine/city3d/materialWarmup.ts',
    ]);
  });

  test('the map-feature registry reads no build variable', () => {
    // A person decides in the settings modal; the adapter is handed the
    // answers. A build switch here would be a second way to decide.
    const registry = files.find((f) => f.path === 'lib/map/mapFeatures.ts');
    expect(registry).toBeDefined();
    expect(registry?.text).not.toMatch(/process\.env/);
  });

  test('the MapLibre adapter imports the city engine folder type-only', () => {
    // Anything it imported at runtime from there would be shared with the
    // engine chunk and hoisted into `__common` too: measured, `occlusion.ts`
    // was, until the adapter stopped importing its defaults.
    const adapter = files.find((f) => f.path === 'components/map/city3dLayer.web.ts');
    expect(adapter).toBeDefined();
    expect(runtimeImports(adapter?.text ?? '', /engine\/(city3d|cityLife|cityStreets)\//)).toEqual(
      [],
    );
  });

  test('the live adapter imports the engine folders type-only', () => {
    const adapter = files.find((f) => f.path === 'components/map/liveLayer.web.ts');
    expect(adapter).toBeDefined();
    expect(runtimeImports(adapter?.text ?? '', /engine\/(city3d|live3d)\//)).toEqual([]);
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
      'components/map/liveLayer.web.ts',
      'components/street3d/SceneViewer.web.tsx',
    ]);
  });
});
