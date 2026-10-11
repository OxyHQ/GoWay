/**
 * Every source file of the app the boundary tests read (`app`, `components`,
 * `features`, `lib`; tests and `node_modules` excluded), with its text — ONE
 * scanner for the chunk and isolation tests beside it, so a change to what
 * they see (a new source folder, a new extension) is made once.
 */
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

export const SOURCE_FILES: ReadonlyArray<{ path: string; text: string }> = SCANNED.flatMap((dir) =>
  sources(join(ROOT, dir)),
).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
