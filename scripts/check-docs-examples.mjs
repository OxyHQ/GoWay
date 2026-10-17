#!/usr/bin/env bun

/**
 * Every example in the developer docs compiles against the code on this tree.
 *
 * An example page (`docs/developers/<product>/examples/*.md`, not the index)
 * promises a complete program somebody can paste. Each `ts` / `tsx` code block
 * on one is written out as a file and type-checked with the frontend's
 * compiler settings, where `@goway.to/maps`, `@goway.to/sdk` and Bloom resolve
 * exactly as they do for an app. A renamed prop, a removed export or a
 * changed signature fails here instead of in a reader's editor.
 *
 * Needs the SDK and the maps SDK built (their `dist/` is what an app imports),
 * which is why CI runs it after the build steps. Guides are NOT checked: their
 * blocks are fragments by design. A docs tree with no examples fails, so a
 * moved folder cannot pass by checking nothing.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = join(repositoryRoot, 'docs/developers');
const frontend = join(repositoryRoot, 'packages/frontend');

function examplePages() {
  if (!existsSync(docsRoot)) return [];
  return readdirSync(docsRoot)
    .map((product) => join(docsRoot, product, 'examples'))
    .filter((directory) => existsSync(directory) && statSync(directory).isDirectory())
    .flatMap((directory) =>
      readdirSync(directory)
        .filter((name) => name.endsWith('.md') && name !== 'README.md')
        .map((name) => join(directory, name)),
    );
}

/** The `ts` and `tsx` blocks of a page, in order. */
export function codeBlocks(markdown) {
  return [...markdown.matchAll(/^```(tsx?)\n([\s\S]*?)^```/gm)].map((match) => ({
    language: match[1],
    code: match[2],
  }));
}

const pages = examplePages();
if (pages.length === 0) {
  console.error('Docs examples: no example pages found under docs/developers/*/examples/');
  process.exit(1);
}

const scratch = join(frontend, `.docs-examples-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const origin = new Map();
let blocks = 0;
try {
  for (const page of pages) {
    const product = basename(dirname(dirname(page)));
    codeBlocks(readFileSync(page, 'utf8')).forEach((block, index) => {
      const file = `${product}--${basename(page, '.md')}--${index}.${block.language}`;
      writeFileSync(join(scratch, file), block.code);
      origin.set(file, `${relative(repositoryRoot, page)} (block ${index + 1})`);
      blocks += 1;
    });
  }
  writeFileSync(
    join(scratch, 'tsconfig.json'),
    JSON.stringify({
      extends: '../tsconfig.json',
      include: ['./*.ts', './*.tsx'],
      compilerOptions: { noEmit: true, noUnusedLocals: false, noUnusedParameters: false },
    }),
  );
  try {
    execFileSync('bunx', ['tsc', '-p', join(scratch, 'tsconfig.json')], {
      cwd: frontend,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const prefix = `${basename(scratch)}/`;
    const lines = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(prefix);
        if (at === -1) return line;
        const rest = line.slice(at + prefix.length);
        const file = rest.slice(0, rest.indexOf('('));
        return `${origin.get(file) ?? file}${rest.slice(file.length)}`;
      });
    console.error(
      `Docs examples: ${blocks} block(s) on ${pages.length} page(s) do not all compile:`,
    );
    for (const line of lines) console.error(`  ${line}`);
    process.exit(1);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(
  `Docs examples OK: ${blocks} code block(s) on ${pages.length} example page(s) compile.`,
);
