/**
 * `@goway.to/maps/metro` — what a Metro (Expo) web build needs for the map.
 *
 *     const { withGoWayMaps } = require('@goway.to/maps/metro');
 *     module.exports = withGoWayMaps(getDefaultConfig(__dirname));
 *
 * maplibre-gl 6 is ESM-only and starts its tile worker BY URL, derived from
 * `import.meta.url` — which inside a Metro bundle is not the package
 * directory, so left alone the worker never starts and every tile request
 * fails silently, with no build error and no failing test. `MapView` on the
 * web points the worker at `/vendor/maplibre-gl/<version>/` on the page's own
 * origin; this copies the INSTALLED maplibre-gl's worker modules there, into
 * the app's `public/`, before Metro serves or exports it. Keyed on the
 * version, so the worker can never be a different release from the main
 * thread it talks to (their message protocol is internal and unversioned).
 *
 * `public/vendor/` is a verbatim copy of an installed dependency: gitignore it.
 * Bundlers that understand `new URL(…, import.meta.url)` (Vite, webpack) do
 * not need this.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Files the worker needs, relative to `maplibre-gl/dist/`. */
const WORKER_FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

/**
 * Write the installed maplibre-gl's worker modules to
 * `<projectRoot>/public/vendor/maplibre-gl/<version>/` and return that
 * directory.
 */
function vendorMaplibreWorker(projectRoot) {
  const packageJsonPath = require.resolve('maplibre-gl/package.json', { paths: [projectRoot] });
  const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const distDir = path.join(path.dirname(packageJsonPath), 'dist');
  const vendorRoot = path.join(projectRoot, 'public', 'vendor', 'maplibre-gl');
  const targetDir = path.join(vendorRoot, version);

  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of WORKER_FILES) {
    const source = path.join(distDir, file);
    const target = path.join(targetDir, file);
    const bytes = fs.readFileSync(source);
    // Only on a real difference: Metro watches `public/`, and rewriting
    // identical bytes on every start would churn the watcher.
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) {
      fs.writeFileSync(target, bytes);
    }
  }

  // Drop directories left by a previous version, so an old worker is never
  // exported next to the new one.
  for (const entry of fs.readdirSync(vendorRoot)) {
    if (entry !== version)
      fs.rmSync(path.join(vendorRoot, entry), { recursive: true, force: true });
  }
  return targetDir;
}

/**
 * Copy the worker for this project, and return the Metro config unchanged.
 * `projectRoot` defaults to the config's own.
 */
function withGoWayMaps(config, options = {}) {
  const projectRoot = options.projectRoot ?? config.projectRoot ?? process.cwd();
  vendorMaplibreWorker(projectRoot);
  return config;
}

module.exports = { withGoWayMaps, vendorMaplibreWorker, WORKER_FILES };
