/**
 * Whether a change reaches what the 3D city visibility gate
 * (`check-city3d-visible.ts`) measures: CI's `changes` job runs it on a pull
 * request to decide `city3d`. Push to main runs the gate whatever this says.
 *
 *   bun packages/frontend/scripts/city3dAffected.ts <base> <head>
 *
 * Prints `affected=true|false` (for `$GITHUB_OUTPUT`) and why on stderr.
 *
 * The gate's inputs are the engine and what it draws ({@link INPUT_PATHS};
 * a unit test beside them is not one, its fixtures are), the packages that
 * code runs with everything they depend on in `bun.lock`
 * ({@link ENGINE_PACKAGES}), and the packages that bundle it
 * ({@link BUNDLER_PACKAGES}, themselves only: their own dependency trees
 * hold half the lockfile's utilities). A dependency bump that reaches none
 * of them (Bloom, the Oxy SDK, Alia) is not the gate's business: the
 * development console gate and the unit tests still load the app.
 */
import { $ } from 'bun';

/** Files and directories (a trailing `/`) the gate's result depends on, from the repository root. */
export const INPUT_PATHS = [
  // The engine, its MapLibre layers and workers, the map's features, styles
  // and quality presets, and the gate's fixtures.
  'packages/frontend/components/map/',
  'packages/frontend/components/engine3d/',
  'packages/frontend/lib/map/',
  'packages/frontend/public/map/',
  // How Metro bundles it (the workers are chunks of their own).
  'packages/frontend/metro.config.js',
  'packages/frontend/babel.config.js',
  // The gate, and the generators its synthetic city and glyphs come from.
  'packages/frontend/scripts/check-city3d-visible.ts',
  'packages/frontend/scripts/city3dSettled.ts',
  'packages/frontend/scripts/city3dShards.ts',
  'packages/frontend/scripts/city3dAffected.ts',
  'packages/frontend/scripts/cameraClearanceDrive.ts',
  'packages/frontend/scripts/serveDevExport.ts',
  'packages/frontend/scripts/citygen/',
  'packages/frontend/scripts/mapgen/',
  // Workspace packages the engine imports: style layers, labels, model
  // placement, geometry, the coverage index.
  'packages/contracts/src/',
  'packages/sdk/src/',
  'packages/maps/src/',
  'packages/map-service/src/coverageTree.js',
  '.github/workflows/ci.yml',
];

/** Packages the engine runs, or the gate drives it with: these and their dependencies. */
export const ENGINE_PACKAGES = [
  'three',
  'maplibre-gl',
  '@maplibre/maplibre-gl-style-spec',
  '@mapbox/vector-tile',
  'pbf',
  'earcut',
  'clipper-lib',
  'playwright-core',
];

/** Packages that bundle and host the engine on the web: these alone. */
export const BUNDLER_PACKAGES = [
  'expo',
  '@expo/cli',
  '@expo/metro-config',
  'babel-preset-expo',
  'metro',
  'react',
  'react-dom',
  'react-native-web',
];

interface Lockfile {
  workspaces: Record<string, Record<string, unknown>>;
  packages: Record<string, unknown[]>;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** `@scope/name@1.2.3` → `@scope/name`. */
function nameOf(spec: unknown): string {
  const s = String(spec);
  return s.slice(0, s.lastIndexOf('@') > 0 ? s.lastIndexOf('@') : s.length);
}

function dependenciesOf(entry: unknown[]): string[] {
  const meta = entry.find((part) => typeof part === 'object' && part !== null) as
    | Record<string, Record<string, string> | undefined>
    | undefined;
  return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(meta?.[field] ?? {}));
}

/** {@link ENGINE_PACKAGES} and everything they depend on, by name. */
export function engineClosure(lock: Lockfile): Set<string> {
  const deps = new Map<string, string[]>();
  for (const entry of Object.values(lock.packages)) {
    const name = nameOf(entry[0]);
    deps.set(name, [...(deps.get(name) ?? []), ...dependenciesOf(entry)]);
  }
  const reached = new Set<string>();
  const next = [...ENGINE_PACKAGES];
  for (let name = next.pop(); name !== undefined; name = next.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    next.push(...(deps.get(name) ?? []));
  }
  return reached;
}

/** Package names whose resolution or whose range in a workspace differs between two lockfiles. */
export function changedPackages(before: Lockfile, after: Lockfile): Set<string> {
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])) {
    const [a, b] = [before.packages[key], after.packages[key]];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    for (const entry of [a, b]) if (entry) changed.add(nameOf(entry[0]));
  }
  for (const path of new Set([
    ...Object.keys(before.workspaces),
    ...Object.keys(after.workspaces),
  ])) {
    for (const field of DEPENDENCY_FIELDS) {
      const a = (before.workspaces[path]?.[field] ?? {}) as Record<string, string>;
      const b = (after.workspaces[path]?.[field] ?? {}) as Record<string, string>;
      for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[name] !== b[name]) changed.add(name);
      }
    }
  }
  return changed;
}

/** Why `files` (and the two lockfiles) reach the gate; empty when they do not. */
export function reasons(files: string[], before: Lockfile, after: Lockfile): string[] {
  const why = files
    .filter((file) => INPUT_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p)))
    .filter((file) => !file.includes('/__tests__/') || file.includes('/__tests__/fixtures/'))
    .map((file) => `changes ${file}`);
  const engine = new Set([...engineClosure(before), ...engineClosure(after), ...BUNDLER_PACKAGES]);
  for (const name of changedPackages(before, after)) {
    if (engine.has(name)) why.push(`changes the package ${name}`);
  }
  return why;
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error('usage: city3dAffected.ts <base> <head>');
  const files = (await $`git diff --name-only ${base} ${head}`.text()).split('\n').filter(Boolean);
  const lockAt = async (rev: string) =>
    Bun.JSONC.parse(await $`git show ${rev}:bun.lock`.text()) as Lockfile;
  const why = reasons(files, await lockAt(base), await lockAt(head));
  for (const line of why) console.error(line);
  if (why.length === 0) console.error('nothing the 3D city visibility gate measures changes');
  console.log(`affected=${why.length > 0}`);
}
