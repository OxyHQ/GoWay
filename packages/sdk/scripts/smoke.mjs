#!/usr/bin/env node
/**
 * Release smoke test for `@goway.to/sdk`: pack it the way it is published,
 * install the TARBALL into a scratch consumer, and use it from every runtime
 * the package claims.
 *
 * Run after `build`. Nothing here reads `src/`: every check is against the
 * packed artefact, because that is the only thing a consumer ever receives.
 *
 *   node scripts/smoke.mjs              # pack into a temp dir, test, clean up
 *   node scripts/smoke.mjs --out <dir>  # also keep the tested tarball in <dir>
 *
 * `--out` is how a publish workflow releases EXACTLY the tarball this script
 * tested, rather than re-packing afterwards. That matters more than it sounds:
 * `@oxyhq/services@30.0.0` shipped with `lib/` empty and 26 of its 33 `exports`
 * targets pointing at files that did not exist, because `npm publish <tarball>`
 * runs ZERO lifecycle scripts — no `prepublishOnly`, no `prepare`, no build.
 * Every check below therefore measures the tarball, never the working tree.
 *
 * ## Why the tarball is packed from a staging directory
 *
 * The package's own manifest lists its build tooling and the private contract
 * package (`workspace:*`) as devDependencies. A consumer never installs those,
 * but the published manifest would still name a private workspace package and
 * a protocol no registry understands. So the tarball is packed from a staging
 * directory holding `dist/`, the docs and a manifest reduced to the fields a
 * consumer's package manager and the registry read. The result is asserted
 * below: no dependencies of any kind, no scripts, no `workspace:`, and no
 * mention of the private `@goway/` scope in any shipped file.
 *
 * ## What is checked
 *
 *  1. The tarball holds exactly dist + README + CHANGELOG + LICENSE + NOTICE + manifest.
 *  2. No shipped file mentions the private package scope or `workspace:`, and
 *     no JavaScript file imports a Node built-in or any package at all.
 *  3. Node ESM `import` and CJS `require` of the INSTALLED package: create a
 *     client, parse a place through a fetch double (which exercises the bundled
 *     closed value sets), build the canonical deep link, map a `not_found` body
 *     to `GoWayNotFoundError`, and recognise an error from the CJS copy as
 *     `instanceof` the ESM class.
 *  4. The same ESM program under Bun.
 *  5. A browser bundle (esbuild, `platform: 'browser'`) and a React Native
 *     bundle (`conditions: ['react-native']`, RN main fields,
 *     `platform: 'neutral'`) both build, resolve the ESM entry, and pull in no
 *     Node built-in.
 *  6. The declarations type-check in a consumer compiled with `nodenext` in
 *     BOTH module kinds, `lib: ["ES2020"]` (no DOM), `types: []` and
 *     `skipLibCheck: false` — so they are self-contained and ask nothing of the
 *     consumer's environment.
 */

import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const keepDir = outIndex === -1 ? null : resolve(process.argv[outIndex + 1] ?? '');
if (outIndex !== -1 && !process.argv[outIndex + 1]) fail('--out needs a directory');

const PRIVATE_SCOPE = '@goway/';
const EXPECTED_FILES = [
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/NOTICE',
  'package/README.md',
  'package/dist/index.cjs',
  'package/dist/index.d.cts',
  'package/dist/index.d.ts',
  'package/dist/index.js',
  'package/package.json',
];

/** The manifest fields a consumer's package manager and the registry read. */
const PUBLISHED_FIELDS = [
  'name', 'version', 'description', 'license', 'author', 'homepage', 'repository', 'bugs', 'keywords',
  'type', 'sideEffects', 'main', 'module', 'types', 'react-native', 'exports', 'files', 'engines',
  'publishConfig',
];

function fail(message) {
  console.error(`sdk smoke FAILED: ${message}`);
  process.exit(1);
}

/**
 * `npm config` settings that must not reach the commands this script runs.
 *
 * npm passes every config option to lifecycle scripts as an `npm_config_*`
 * environment variable, and a nested npm *reads them back*. So
 * `npm publish --dry-run` — the rehearsal a careful person does first — sets
 * `npm_config_dry_run=true`, `prepublishOnly` runs this script, and the
 * `npm pack` below inherits the flag: npm reports the tarball it WOULD have
 * written, writes nothing, and the smoke test dies on `ENOENT` for a file that
 * was never going to exist.
 *
 * The failure is worse than it sounds, because of which way round it fails.
 * The cautious rehearsal is the one thing that always breaks, while the real
 * publish works — so the person who checks first sees a broken release and the
 * person who does not, does not. Measured by the team who published 0.1.0:
 * `npm_config_dry_run=true bun run smoke` reproduces it exactly, and clearing
 * the variable makes it pass.
 *
 * This script's job is to prove that a real tarball works, so a real tarball is
 * always what it builds — whatever the outer npm was asked to pretend.
 */
const INHERITED_NPM_FLAGS_TO_CLEAR = ['npm_config_dry_run'];

function run(command, args, cwd, what) {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const name of INHERITED_NPM_FLAGS_TO_CLEAR) delete env[name];
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.error) fail(`${what}: could not run ${command} (${result.error.message})`);
  if (result.status !== 0) {
    fail(`${what}: ${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'goway-sdk-smoke-'));
  const checks = [];
  const pass = (name) => {
    checks.push(name);
    console.log(`  ok  ${name}`);
  };

  try {
    // ── Stage and pack ────────────────────────────────────────────────────────
    for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
      await stat(join(root, 'dist', file)).catch(() => fail(`dist/${file} is missing — run the build first`));
    }
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const stage = join(scratch, 'stage');
    await mkdir(stage, { recursive: true });
    await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
    for (const doc of ['README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']) await cp(join(root, doc), join(stage, doc));
    const published = Object.fromEntries(
      PUBLISHED_FIELDS.filter((key) => key in manifest).map((key) => [key, manifest[key]]),
    );
    await writeFile(join(stage, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);

    const packDir = join(scratch, 'pack');
    await mkdir(packDir);
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDir], stage, 'pack'));
    const tarball = join(packDir, packed[0].filename);
    const tarballBytes = (await stat(tarball)).size;

    // ── 1. File list ──────────────────────────────────────────────────────────
    const listed = run('tar', ['-tzf', tarball], scratch, 'list tarball').split('\n').filter(Boolean).sort();
    if (JSON.stringify(listed) !== JSON.stringify(EXPECTED_FILES)) {
      fail(`tarball files are\n  ${listed.join('\n  ')}\nexpected\n  ${EXPECTED_FILES.join('\n  ')}`);
    }
    pass(`tarball holds exactly ${EXPECTED_FILES.length} files (dist, docs, manifest)`);

    // ── 2. Content of every shipped file ─────────────────────────────────────
    const extract = join(scratch, 'extract');
    await mkdir(extract);
    run('tar', ['-xzf', tarball, '-C', extract], scratch, 'extract tarball');
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
    for (const file of await listFiles(extract)) {
      const text = await readFile(file, 'utf8');
      const name = relative(extract, file);
      if (text.includes(PRIVATE_SCOPE)) fail(`${name} mentions the private scope ${PRIVATE_SCOPE}`);
      if (text.includes('workspace:')) fail(`${name} contains a workspace: protocol`);
      if (/\.(?:c?js|d\.c?ts)$/.test(name)) {
        for (const [, specifier] of text.matchAll(importSpecifier)) {
          if (builtins.has(specifier)) fail(`${name} imports the Node built-in ${specifier}`);
          if (!specifier.startsWith('.')) fail(`${name} imports the package ${specifier}; the SDK has no dependencies`);
        }
      }
    }
    const shippedManifest = JSON.parse(await readFile(join(extract, 'package', 'package.json'), 'utf8'));
    for (const field of [
      'dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies',
      'bundleDependencies', 'bundledDependencies', 'scripts',
    ]) {
      if (field in shippedManifest) fail(`the published manifest carries ${field}`);
    }
    if (shippedManifest.name !== '@goway.to/sdk') fail(`published name is ${shippedManifest.name}`);
    pass('no private scope, no workspace protocol, no dependencies, no scripts, no Node built-in imports');

    // ── 3. Node ESM + CJS from the installed tarball ─────────────────────────
    const consumer = join(scratch, 'consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), '{ "name": "sdk-smoke-consumer", "private": true }\n');
    run(
      'npm',
      ['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock', '--offline'],
      consumer,
      'install tarball',
    );

    await writeFile(join(consumer, 'program.mjs'), CONSUMER_ESM);
    await writeFile(join(consumer, 'program.cjs'), CONSUMER_CJS);
    run(process.execPath, ['program.mjs'], consumer, 'node ESM import');
    pass('node ESM import: client, place parse, deep link, not_found → GoWayNotFoundError, cross-copy instanceof');
    run(process.execPath, ['program.cjs'], consumer, 'node CJS require');
    pass('node CJS require: client, place parse, deep link');

    // ── 4. Bun ────────────────────────────────────────────────────────────────
    run('bun', ['program.mjs'], consumer, 'bun import');
    pass('bun import');

    // ── 5. Browser and React Native bundles ──────────────────────────────────
    await writeFile(join(consumer, 'bundle-entry.js'), BUNDLE_ENTRY);
    const bundles = {
      browser: { platform: 'browser' },
      'react-native': {
        platform: 'neutral',
        conditions: ['react-native'],
        mainFields: ['react-native', 'module', 'main'],
      },
    };
    for (const [target, options] of Object.entries(bundles)) {
      let result;
      try {
        result = await esbuild.build({
          entryPoints: [join(consumer, 'bundle-entry.js')],
          absWorkingDir: consumer,
          bundle: true,
          write: false,
          metafile: true,
          format: 'esm',
          logLevel: 'silent',
          ...options,
        });
      } catch (error) {
        fail(`${target} bundle did not build: ${error.message}`);
      }
      const inputs = Object.keys(result.metafile.inputs);
      const offending = inputs.filter((input) => builtins.has(input) || input.startsWith('node:'));
      if (offending.length > 0) fail(`${target} bundle pulled in Node built-ins: ${offending.join(', ')}`);
      if (!inputs.some((input) => input.endsWith('@goway.to/sdk/dist/index.js'))) {
        fail(`${target} bundle did not resolve the ESM entry (inputs: ${inputs.join(', ')})`);
      }
      pass(`${target} bundle builds from dist/index.js with no Node built-ins`);
    }

    // ── 6. Declarations in a no-DOM nodenext consumer, both module kinds ─────
    await writeFile(join(consumer, 'types-esm.mts'), CONSUMER_TYPES);
    await writeFile(join(consumer, 'types-cjs.cts'), CONSUMER_TYPES);
    await writeFile(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'ES2020',
          lib: ['ES2020'],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['types-esm.mts', 'types-cjs.cts'],
      }),
    );
    const tsc = join(dirname(fileURLToPath(import.meta.resolve('typescript'))), '..', 'bin', 'tsc');
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], consumer, 'consumer type-check');
    pass('declarations type-check under nodenext (ESM and CJS), lib ES2020 without DOM, skipLibCheck off');

    if (keepDir) {
      await mkdir(keepDir, { recursive: true });
      await cp(tarball, join(keepDir, packed[0].filename));
    }

    const unpackedBytes = packed[0].unpackedSize;
    console.log(
      `sdk smoke passed — ${checks.length} checks; ${packed[0].filename}: ${(tarballBytes / 1024).toFixed(1)} KB packed, ` +
        `${(unpackedBytes / 1024).toFixed(1)} KB unpacked${keepDir ? `; kept in ${keepDir}` : ''}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ── Consumer programs ───────────────────────────────────────────────────────

const SHARED_PROGRAM = String.raw`
const place = {
  id: 'gw_place_01H8',
  name: 'Cafè de la Plaça',
  location: { latitude: 41.3874, longitude: 2.1686 },
  categories: ['food.cafe'],
  status: 'active',
  verification: { state: 'owner_verified', verifiedAt: '2026-01-04T10:00:00.000Z' },
  sources: [{ source: 'openstreetmap', sourceId: 'node/12345' }],
  capabilities: [{
    namespace: 'payments.faircoin',
    capability: 'accepted',
    key: 'payments.faircoin.accepted',
    value: true,
    verification: 'oxy_verified',
    observedAt: '2026-02-01T09:30:00.000Z',
  }],
  createdAt: '2025-12-01T00:00:00.000Z',
  updatedAt: '2026-02-01T09:30:00.000Z',
  internalRowId: 99,
};
const respond = (status, body) => async () => ({
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});
function check(condition, message) { if (!condition) { throw new Error('smoke assertion failed: ' + message); } }
async function exercise(sdk) {
  const client = sdk.createGoWayClient({
    fetch: respond(200, [{ ...place, distanceMeters: 412.5 }]),
    getAccessToken: () => 'smoke-token',
  });
  const merchants = await client.places.nearby({
    latitude: 41.3874, longitude: 2.1686, radiusMeters: 5000, capabilities: ['payments.faircoin.accepted'],
  });
  check(merchants.length === 1, 'one merchant parsed');
  check(merchants[0].distanceMeters === 412.5, 'distance parsed');
  check(merchants[0].capabilities[0].verification === 'oxy_verified', 'closed value set survived bundling');
  check(!('internalRowId' in merchants[0]), 'a leaked backend column is stripped');
  check(client.links.place(merchants[0]) === 'https://goway.to/place/gw_place_01H8', 'canonical deep link');
  check(sdk.toGeoPosition(merchants[0].location)[0] === 2.1686, 'bundled helper is longitude-first');
  check(sdk.WELL_KNOWN_CAPABILITIES.includes('payments.faircoin.accepted'), 'bundled value set');
  check(sdk.API_ERROR_RETRYABLE.no_route === false, 'bundled retryability table');

  const missing = sdk.createGoWayClient({
    fetch: respond(404, { error: { code: 'not_found', message: 'no such place' } }),
  });
  let error;
  try { await missing.places.get('gw_missing'); } catch (caught) { error = caught; }
  check(error instanceof sdk.GoWayNotFoundError && error.code === 'not_found' && error.status === 404,
    'not_found maps to GoWayNotFoundError');
  check(error.retryable === false, 'not_found is not retryable');
  return error;
}
`;

const CONSUMER_ESM = `${SHARED_PROGRAM}
import * as esm from '@goway.to/sdk';
import { createRequire } from 'node:module';
const cjs = createRequire(import.meta.url)('@goway.to/sdk');
await exercise(esm);
const fromCjs = await exercise(cjs);
check(esm.GoWayNotFoundError !== cjs.GoWayNotFoundError, 'the ESM and CJS builds are two copies');
check(fromCjs instanceof esm.GoWayNotFoundError, 'a CJS-thrown error is instanceof the ESM class');
check(fromCjs instanceof esm.GoWayError && esm.isGoWayError(fromCjs), 'and of the ESM base class');
check(!(fromCjs instanceof esm.GoWayForbiddenError), 'but not of an unrelated class');
`;

const CONSUMER_CJS = `${SHARED_PROGRAM}
const sdk = require('@goway.to/sdk');
exercise(sdk).catch((error) => { console.error(error); process.exit(1); });
`;

const BUNDLE_ENTRY = `
import { createGoWayClient } from '@goway.to/sdk';
export const url = createGoWayClient().links.place('gw_place_01H8');
`;

const CONSUMER_TYPES = `
import {
  createGoWayClient,
  GoWayNoRouteError,
  GoWayNotFoundError,
  type GoWayClient,
  type NearbyPlacesQuery,
  type Place,
  type PlaceWithDistance,
  type RouteResponse,
  type SearchResults,
} from '@goway.to/sdk';

const client: GoWayClient = createGoWayClient({ getAccessToken: async () => null, locale: 'ca' });

export async function merchants(query: NearbyPlacesQuery): Promise<string> {
  try {
    const nearby: PlaceWithDistance[] = await client.places.nearby(query);
    const detail: Place = await client.places.get(nearby[0]!.id);
    const results: SearchResults = await client.search.query({ query: detail.name, limit: 5 });
    const directions: RouteResponse = await client.routes.directions({
      origin: { coordinate: { latitude: query.latitude, longitude: query.longitude } },
      destination: { placeId: detail.id },
      mode: 'walk',
    });
    return client.links.place(detail) + results.providers.length + directions.routes.length;
  } catch (error) {
    if (error instanceof GoWayNoRouteError) return 'no route';
    if (error instanceof GoWayNotFoundError) return error.code;
    throw error;
  }
}
`;

await main();
