/**
 * Build GoWay's Planetiler: the pinned release, its pinned OpenMapTiles
 * profile, and GoWay's addon layers (`tiles/openmaptiles-addons/`) — the jar
 * `map:tiles` builds the basemap with (`docs/MAP_STYLES.md` → Outdoors data).
 *
 * ```bash
 * bun run --cwd packages/frontend map:planetiler          # build (and test) the jar
 * ```
 *
 * ## Why a build, and not the release jar
 *
 * The OpenMapTiles schema has no hiking difficulty, trail visibility, ski
 * pistes, via ferratas or climbing. The profile's documented way to add a
 * layer is an ADDON: a class in `org.openmaptiles.addons`, registered in
 * `ExtraLayers` — compiled into the profile, beside its layers, so every
 * OpenMapTiles layer is byte-for-byte what it was and one layer is added
 * (`outdoors`). That needs the profile's source, so the jar is built here:
 *
 *  1. Planetiler's release source at {@link PLANETILER_TAG} and the
 *     OpenMapTiles profile at the submodule commit that tag pins
 *     ({@link OPENMAPTILES_COMMIT}), each checked against its sha256;
 *  2. GoWay's addon sources copied over the profile's empty `addons` package;
 *  3. the addon's own tests run through the whole profile (`OutdoorsTest`);
 *  4. `planetiler-dist`'s with-dependencies jar, written to
 *     `.tiles/planetiler-<tag>-goway.jar` with a receipt of every input hash.
 *
 * Needs a JDK 21 and the network once (Maven's dependencies, cached under
 * `GOWAY_PLANETILER_CACHE`, default `~/.cache/goway-planetiler`). Nothing here
 * changes the OpenMapTiles layers: `map:tiles --verify` asserts all sixteen
 * are still there, and the addon's tests assert `transportation` still draws a
 * path the addon also draws.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(FRONTEND_ROOT, '.tiles');
const ADDONS = join(FRONTEND_ROOT, 'tiles', 'openmaptiles-addons', 'src');
const CACHE =
  process.env.GOWAY_PLANETILER_CACHE || join(process.env.HOME ?? '/tmp', '.cache', 'goway-planetiler');

/** The release `map:tiles` has always used. */
export const PLANETILER_TAG = 'v0.10.2';
const PLANETILER_SOURCE = {
  url: `https://github.com/onthegomap/planetiler/archive/refs/tags/${PLANETILER_TAG}.tar.gz`,
  sha256: '48985ea9e8f87051ff63b2f15952791bc7c5999028e57b2818023a4c839f767a',
  dir: `planetiler-${PLANETILER_TAG.slice(1)}`,
};
/** The `planetiler-openmaptiles` submodule commit {@link PLANETILER_TAG} pins. */
export const OPENMAPTILES_COMMIT = '91516fdf477915b1a985015811049b9b96c7f87e';
const OPENMAPTILES_SOURCE = {
  url: `https://github.com/openmaptiles/planetiler-openmaptiles/archive/${OPENMAPTILES_COMMIT}.tar.gz`,
  sha256: '435520a9b62a5afe7804a1c3420ecdcae95b1774b0af475ac778f7caf1b3349c',
  dir: `planetiler-openmaptiles-${OPENMAPTILES_COMMIT}`,
};

/** Where the jar lands; `map:tiles` reads it from here. */
export const GOWAY_PLANETILER_JAR = join(BUILD_DIR, `planetiler-${PLANETILER_TAG}-goway.jar`);

function run(command: string, argv: string[], cwd: string): Promise<void> {
  return new Promise((settle, fail) => {
    const child = spawn(command, argv, { cwd, stdio: "inherit" });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? settle() : fail(new Error(`${command} ${argv[0] ?? ''} exited ${code}`)),
    );
  });
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Fetch a pinned source tarball once and refuse it if its hash moved. */
async function source(spec: { url: string; sha256: string; dir: string }): Promise<string> {
  const tarball = join(CACHE, `${spec.dir}.tar.gz`);
  if (!(await exists(tarball))) {
    await run('curl', ['-fsSL', '-o', tarball, spec.url], CACHE);
  }
  const digest = await sha256(tarball);
  if (digest !== spec.sha256) {
    throw new Error(`${spec.url}: sha256 ${digest}, expected ${spec.sha256}. Refusing to build.`);
  }
  return tarball;
}

/** Every file under a directory, relative, for the receipt. */
async function files(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await files(root, path)));
    else out.push(path);
  }
  return out.sort();
}

async function main(): Promise<void> {
  await mkdir(CACHE, { recursive: true });
  await mkdir(BUILD_DIR, { recursive: true });
  const planetiler = await source(PLANETILER_SOURCE);
  const openmaptiles = await source(OPENMAPTILES_SOURCE);

  // A clean tree every time: an addon removed from the repository must not
  // linger in the jar from a previous build.
  const tree = join(CACHE, 'tree');
  await rm(tree, { recursive: true, force: true });
  await mkdir(tree, { recursive: true });
  await run('tar', ['xzf', planetiler, '-C', tree], CACHE);
  await run('tar', ['xzf', openmaptiles, '-C', tree], CACHE);
  const root = join(tree, PLANETILER_SOURCE.dir);
  const profile = join(root, 'planetiler-openmaptiles');
  await rm(profile, { recursive: true, force: true });
  await cp(join(tree, OPENMAPTILES_SOURCE.dir), profile, { recursive: true });
  await cp(ADDONS, join(profile, 'src'), { recursive: true });

  const maven = [
    '-B',
    `-Dmaven.repo.local=${join(CACHE, 'm2')}`,
    // A source tarball has no `.git`; Planetiler stamps the jar with this instead.
    `-Dmaven.buildNumber.revisionOnScmFailure=${PLANETILER_TAG}-goway`,
    '-Dspotless.check.skip=true',
    '-Djib.skip=true',
  ];
  // The addon's tests, through the whole OpenMapTiles profile.
  await run(
    './mvnw',
    [...maven, '-Dtest=OutdoorsTest', '-Dsurefire.failIfNoSpecifiedTests=false', '-pl', 'planetiler-openmaptiles', '-am', 'test'],
    root,
  );
  await run('./mvnw', [...maven, '-DskipTests', '-pl', 'planetiler-dist', '-am', 'package'], root);

  const target = join(root, 'planetiler-dist', 'target');
  const jar = (await readdir(target)).find((name) => name.endsWith('-with-deps.jar'));
  if (!jar) throw new Error(`no with-deps jar in ${target}`);
  await cp(join(target, jar), GOWAY_PLANETILER_JAR);

  const addonFiles = await files(ADDONS);
  const receipt = {
    jar: GOWAY_PLANETILER_JAR,
    sha256: await sha256(GOWAY_PLANETILER_JAR),
    planetiler: { tag: PLANETILER_TAG, sha256: PLANETILER_SOURCE.sha256 },
    openmaptiles: { commit: OPENMAPTILES_COMMIT, sha256: OPENMAPTILES_SOURCE.sha256 },
    addons: Object.fromEntries(
      await Promise.all(
        addonFiles.map(async (file) => [file, await sha256(join(ADDONS, file))] as const),
      ),
    ),
    builtAt: new Date().toISOString(),
  };
  await writeFile(`${GOWAY_PLANETILER_JAR}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`· ${GOWAY_PLANETILER_JAR}\n  sha256 ${receipt.sha256}`);
}

if (import.meta.main) await main();
