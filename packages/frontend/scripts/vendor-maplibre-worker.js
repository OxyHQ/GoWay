#!/usr/bin/env node
/**
 * Copy MapLibre's worker modules into `public/` so the WEB map can start its
 * tile worker from GoWay's own origin.
 *
 * WHY: `maplibre-gl` 6 ships as ES modules only. The 5.x UMD bundle carried its
 * worker inlined as a Blob, so Metro bundling `maplibre-gl` was the whole
 * story. The 6.x worker is a separate module (`maplibre-gl-worker.mjs`, which
 * imports `./maplibre-gl-shared.mjs`) that the main thread starts BY URL,
 * derived from `import.meta.url` — and inside a Metro bundle that is not the
 * package's directory. Without a worker URL every tile request fails and the
 * map stays blank, with no build error and no failing test.
 *
 * Staying on 5.24.0 to avoid that is no longer an option: GHSA-jrc7-96c5-q579
 * (critical, XSS sanitizer bypass in `DOM.sanitize()`) covers every release
 * `<= 6.4.0`, and 5.24.0 is the last 5.x — there is no patched 5.x and never
 * will be. So GoWay is on 6.x and vendors the worker.
 *
 * `MapCanvas.web.tsx` calls `setWorkerUrl` with
 * `/vendor/maplibre-gl/<getVersion()>/maplibre-gl-worker.mjs`, and this writes
 * exactly that directory from the INSTALLED package, so the worker can never be
 * a different version from the main-thread code it talks to (their message
 * protocol is internal and unversioned).
 *
 * It runs from `metro.config.js`, so every Metro process — `expo start`,
 * `expo export` locally and in CI — has the files before it serves or exports
 * `public/`. `public/vendor/` is gitignored: it is a verbatim copy of an
 * installed dependency, reproduced by `bun install` + any Metro run, and
 * committing it would mean a stale worker could outlive a version bump.
 */
const fs = require('fs');
const path = require('path');

/** Files the worker needs, relative to `maplibre-gl/dist/`. */
const WORKER_FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

const FRONTEND_ROOT = path.dirname(require.resolve('../package.json'));
const VENDOR_ROOT = path.join(FRONTEND_ROOT, 'public', 'vendor', 'maplibre-gl');

/**
 * Write the installed maplibre-gl's worker modules to
 * `public/vendor/maplibre-gl/<version>/` and return that directory.
 */
function vendorMaplibreWorker() {
  const packageJsonPath = require.resolve('maplibre-gl/package.json', { paths: [FRONTEND_ROOT] });
  const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const distDir = path.join(path.dirname(packageJsonPath), 'dist');
  const targetDir = path.join(VENDOR_ROOT, version);

  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of WORKER_FILES) {
    const source = path.join(distDir, file);
    const target = path.join(targetDir, file);
    const bytes = fs.readFileSync(source);
    // Only write on a real difference: Metro watches `public/`, and rewriting
    // identical bytes on every start would churn the watcher.
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) {
      fs.writeFileSync(target, bytes);
    }
  }

  // Drop directories left by a previous version so an old worker is never
  // exported next to the new one.
  for (const entry of fs.readdirSync(VENDOR_ROOT)) {
    if (entry !== version) {
      fs.rmSync(path.join(VENDOR_ROOT, entry), { recursive: true, force: true });
    }
  }

  return targetDir;
}

module.exports = { vendorMaplibreWorker, WORKER_FILES };

if (require.main === module) {
  console.log(`maplibre-gl worker vendored to ${path.relative(process.cwd(), vendorMaplibreWorker())}`);
}
