#!/usr/bin/env node
/**
 * Build `@goway.to/sdk` into `dist/`.
 *
 * Output — four files per entry point, one per module format:
 *
 *   dist/<entry>.js     ESM   (`import`, `react-native`, `default`)
 *   dist/<entry>.cjs    CJS   (`require`) — GoWay's own backend is CommonJS
 *   dist/<entry>.d.ts   declarations for the ESM entry
 *   dist/<entry>.d.cts  the same declarations for the CJS entry, so TypeScript
 *                       under `node16`/`nodenext` does not see ESM types
 *                       masquerading as CJS
 *
 * Two entries: `index` (`@goway.to/sdk`, the HTTP client) and `live`
 * (`@goway.to/sdk/live`, the GoWay Live socket protocol). Each is bundled ON
 * ITS OWN — no shared chunk — so loading one never loads the other: the live
 * schemas stay out of every HTTP-only consumer, GoWay's own first paint
 * included, and a contract module both reach is simply inlined twice.
 *
 * ## Why esbuild + rollup-plugin-dts, and not tsc or tsup
 *
 * The contract lives in `@goway/contracts`, which is PRIVATE and never
 * published. The published package therefore cannot depend on it or reference
 * it from its declarations — a consumer resolving `workspace:*` from a registry
 * tarball has nothing to resolve — so both halves are BUNDLED:
 *
 *  - esbuild inlines the contract modules the SDK reaches (the schemas it
 *    validates and parses with, the closed value sets, the helpers), and emits
 *    both module formats from one source.
 *  - rollup-plugin-dts with `respectExternal` inlines the declarations the
 *    public types reach, so the `.d.ts` is self-contained.
 *
 * `tsc` alone cannot do this: it emits one `.d.ts` per input file and has no
 * way to bundle declarations, so its output would still `import type … from
 * '@goway/contracts'` and fail in every consumer. `tsup` wraps these same
 * two tools, with a dependency tree an order of magnitude larger and less
 * control over resolution and the side-effects flag — nothing it adds is
 * needed for a single-entry package.
 *
 * ## `zod` is the one thing NOT bundled
 *
 * The contract IS zod schemas, so zod is a real runtime dependency, declared in
 * `dependencies` and left EXTERNAL in both halves: the JavaScript imports
 * `zod`, and the declarations import its types (`z.infer<…>` is how every
 * contract type is spelled). Bundling it would ship a private copy that a
 * consumer's own zod could not share or deduplicate, and would inline zod's
 * whole declaration tree into ours. `scripts/smoke.mjs` holds the result to
 * that: `zod` (and its subpaths, in declarations) is the only bare import any
 * shipped file may contain.
 *
 * `platform: 'neutral'` and `target: 'es2020'` keep the output free of any
 * Node, browser or bundler-specific shim; the bundle is not minified because
 * consumers' bundlers minify, and readable output is what someone debugging a
 * failed parse steps into.
 */

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ENTRIES = ['index', 'live'];
const tsconfig = join(root, 'tsconfig.json');

/** The runtime dependency, kept out of both bundles: `zod` and any subpath of it. */
const EXTERNAL = ['zod', 'zod/*'];
const isExternal = (id) => id === 'zod' || id.startsWith('zod/');

/**
 * Every module of the private contract package is pure types, schemas, data
 * and functions, so a module the SDK does not reach contributes nothing — the
 * OpenAPI builder and the JSON Schema registry, for two, never reach a consumer. If
 * one ever grows a real side effect the SDK depends on, the smoke test — which
 * exercises the BUILT bundle, closed value sets included — is what fails.
 */
const contractIsSideEffectFree = {
  name: 'contract-is-side-effect-free',
  setup(build) {
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData === 'resolving') return undefined;
      const fromContract =
        args.path === '@goway/contracts' || args.importer.includes('/contracts/');
      if (!fromContract || isExternal(args.path)) return undefined;
      const resolved = await build.resolve(args.path, {
        importer: args.importer,
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: 'resolving',
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, sideEffects: false };
    });
  },
};

const shared = {
  bundle: true,
  platform: 'neutral',
  target: 'es2020',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [contractIsSideEffectFree],
  external: EXTERNAL,
  tsconfig,
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const name of ENTRIES) {
  const entry = join(root, 'src', `${name}.ts`);
  await esbuild.build({
    ...shared,
    entryPoints: [entry],
    format: 'esm',
    outfile: join(dist, `${name}.js`),
  });
  await esbuild.build({
    ...shared,
    entryPoints: [entry],
    format: 'cjs',
    outfile: join(dist, `${name}.cjs`),
  });

  const bundle = await rollup({
    input: entry,
    // `respectExternal` makes the plugin inline declarations from node_modules
    // too, so zod must be named external here as well or its types are copied in.
    external: isExternal,
    plugins: [dts({ respectExternal: true, tsconfig })],
    onwarn(warning, warn) {
      // A circular re-export inside the contract package is harmless for
      // declarations and would otherwise print on every build.
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      warn(warning);
    },
  });
  const { output } = await bundle.generate({ format: 'es' });
  await bundle.close();
  const declarations = output.find((chunk) => chunk.type === 'chunk');
  if (!declarations) throw new Error(`rollup-plugin-dts produced no declaration chunk for ${name}`);
  await writeFile(join(dist, `${name}.d.ts`), dropOrphanedDocblocks(declarations.code));
  await copyFile(join(dist, `${name}.d.ts`), join(dist, `${name}.d.cts`));
}

/**
 * Keep only the comment that DOCUMENTS each top-level declaration.
 *
 * Bundling a module's declarations carries its file-level docblock along,
 * stranded above the first declaration it happened to precede — design notes
 * about GoWay's internals (the Drizzle schema, private packages, why a schema
 * fails closed) that describe nothing a consumer can use. Every leading comment
 * of a top-level statement except the last one is exactly that, so it is
 * removed; the last one is the declaration's own JSDoc and stays.
 */
function dropOrphanedDocblocks(code) {
  const source = ts.createSourceFile(
    'index.d.ts',
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const removals = [];
  for (const statement of source.statements) {
    const ranges = ts.getLeadingCommentRanges(code, statement.pos) ?? [];
    for (const range of ranges.slice(0, -1)) removals.push(range);
  }
  let result = code;
  for (const { pos, end } of removals.sort((a, b) => b.pos - a.pos)) {
    result = result.slice(0, pos) + result.slice(end).replace(/^\r?\n/, '');
  }
  return result;
}

console.log(`built ${ENTRIES.map((name) => `dist/${name}.{js,cjs,d.ts,d.cts}`).join(', ')}`);
