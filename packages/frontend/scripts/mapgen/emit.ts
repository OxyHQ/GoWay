/**
 * Write a generated file tree, or prove the committed one still matches it.
 *
 * ## Why both scripts share this
 *
 * `public/map/fonts/` and `public/map/sprites/` are GENERATED files that are
 * COMMITTED, for the same reason `public/map/goway-*.json` is: they are served
 * as static assets straight out of `dist/`, so the deploy is the commit, and
 * having the bytes in the diff is the only way a reviewer can see that a font
 * or icon change actually happened. The cost of that choice is drift — someone
 * edits the generator, does not re-run it, and ships a sprite that disagrees
 * with its own source. `--check` is what makes that cost zero.
 *
 * ## What `--check` has to catch that a naive comparison does not
 *
 *  1. **Changed bytes.** Obvious, and the easy half.
 *  2. **Missing files.** A range that the generator now emits and the tree does
 *     not. MapLibre answers a 404 glyph range by rendering no text — silently.
 *  3. **Files nobody generates any more.** The failure that a per-file loop
 *     misses entirely. Drop a fontstack from the build and its 33 stale `.pbf`
 *     files stay in `public/`, keep being deployed, and keep answering
 *     requests with glyphs from a weight that is no longer in any style. The
 *     map looks fine. It is just wrong, and nothing in CI would have said so.
 *
 * So the unit of comparison is the whole subtree, not the file.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** A generated tree: POSIX-ish relative path -> bytes. */
export type EmitTree = Map<string, Uint8Array>;

export interface EmitResult {
  written: number;
  totalBytes: number;
}

/** Every file under `root`, as paths relative to it, with `/` separators. */
async function listTree(root: string): Promise<string[]> {
  // A tree that does not exist yet is an empty tree, not a failure: `--check`
  // has to be able to say "33 files missing" on a fresh clone of a branch
  // where somebody forgot to commit the output.
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // `parentPath` is absolute; relative() then split/join normalises Windows
    // separators so the keys match the ones callers build with '/'.
    const full = join(entry.parentPath, entry.name);
    files.push(relative(root, full).split(sep).join('/'));
  }
  return files;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Compare the committed tree under `root` against `tree`, appending to `problems`.
 *
 * Reports at most a handful of differing files by name: a regenerated font
 * tree differs in 132 files at once, and 132 identical lines of "out of date"
 * is worse than one line that says so and names three.
 */
export async function checkTree(root: string, tree: EmitTree, problems: string[]): Promise<void> {
  const onDisk = new Set(await listTree(root));
  const differing: string[] = [];
  const missing: string[] = [];

  for (const [path, expected] of tree) {
    if (!onDisk.has(path)) {
      missing.push(path);
      continue;
    }
    onDisk.delete(path);
    const actual = new Uint8Array(await readFile(join(root, path)));
    if (!sameBytes(actual, expected)) differing.push(path);
  }

  const describe = (paths: string[]): string =>
    paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;

  if (missing.length > 0) problems.push(`${root}: ${missing.length} generated file(s) missing — ${describe(missing)}`);
  if (differing.length > 0) {
    problems.push(`${root}: ${differing.length} file(s) differ from what the generator produces — ${describe(differing)}`);
  }
  if (onDisk.size > 0) {
    const stale = [...onDisk].sort();
    problems.push(`${root}: ${stale.length} file(s) are committed but no longer generated — ${describe(stale)}`);
  }
}

/**
 * Replace the tree under `root` with `tree`.
 *
 * `root` is removed first rather than overwritten in place, because an
 * incremental write leaves behind exactly the stale files that `checkTree`
 * exists to catch, and a generator that can produce a state its own checker
 * rejects is not a generator anybody can trust.
 */
export async function writeTree(root: string, tree: EmitTree): Promise<EmitResult> {
  try {
    await stat(root);
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let totalBytes = 0;
  // Sorted so the log is stable and diffable between runs.
  for (const path of [...tree.keys()].sort()) {
    const bytes = tree.get(path)!;
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    totalBytes += bytes.length;
  }
  return { written: tree.size, totalBytes };
}

/** `1.42 MB`, for logs and reports. Base 1024, because these are file sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
