#!/usr/bin/env node
/**
 * Build `@goway.to/maps` into `dist/` with the TypeScript compiler: one module
 * and one declaration per source file, so a platform fork stays a file of its
 * own (`MapView.web.js` beside `MapView.js`) and the web entry
 * (`index.web.js`, chosen by the `browser` export condition) names each fork.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await rm(join(root, 'dist'), { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
});
console.log('built dist/');
