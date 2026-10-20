#!/usr/bin/env bun

/**
 * The developer documentation (`docs/developers/`, and the package READMEs that
 * point into it) can drift from the code in two silent ways, and this gate
 * catches both.
 *
 *   1. **A link that goes nowhere.** Every relative link in the pages must name
 *      a file that exists, and an `#anchor` a heading that exists in it (by
 *      GitHub's slug rule). Absolute `https://` links are not fetched.
 *
 *   2. **An export the reference does not mention.** Each API reference page
 *      is paired with the entry file(s) it documents. Every name an entry
 *      exports (values and types, as TypeScript's `getExportsOfModule` reports
 *      them, read from SOURCE so no build is needed) must appear on its page in
 *      backticks. A new export without a line in the reference fails here,
 *      not in an integrator's editor.
 *
 * Both carry a vacuity floor: a docs tree with no pages, or an entry that
 * exports nothing, fails rather than reporting a clean result.
 * `scripts/test-check-developer-docs.mjs` mutation-tests each rule.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the developer docs live, and the READMEs that link into them. */
export const DOC_ROOTS = ['docs/developers'];
export const EXTRA_PAGES = ['packages/sdk/README.md', 'packages/maps/README.md'];

/** Each reference page, and the entry file(s) whose exports it must name. */
export const REFERENCE_PAGES = {
  'docs/developers/maps/api-reference/index.md': [
    'packages/maps/src/index.ts',
    'packages/maps/src/index.web.ts',
  ],
  'docs/developers/maps/api-reference/plugin.md': ['packages/maps/src/plugin.ts'],
  'docs/developers/maps/api-reference/testing.md': ['packages/maps/src/testing.ts'],
  'docs/developers/maps/api-reference/brand.md': ['packages/maps/src/brand/artwork.ts'],
  'docs/developers/maps/api-reference/metro.md': ['packages/maps/metro.cjs'],
  'docs/developers/sdk/api-reference/index.md': ['packages/sdk/src/index.ts'],
  'docs/developers/sdk/api-reference/live.md': ['packages/sdk/src/live.ts'],
  'docs/developers/sdk/api-reference/geo.md': ['packages/sdk/src/geo.ts'],
  'docs/developers/sdk/api-reference/road-access.md': ['packages/sdk/src/roadAccess.ts'],
  'docs/developers/sdk/api-reference/map.md': ['packages/sdk/src/map.ts'],
};

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slugOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every anchor a page offers: one per heading, with GitHub's `-1`, `-2` for repeats. */
export function anchorsOf(markdown) {
  const anchors = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const base = slugOf(heading[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** The relative links of a page, outside code: `[text](target)`. */
export function linksOf(markdown) {
  const links = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const prose = line.replace(/`[^`]*`/g, '');
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
      links.push(target);
    }
  }
  return links;
}

export function checkLinks(root, pages) {
  const problems = [];
  for (const page of pages) {
    const markdown = readFileSync(page, 'utf8');
    for (const link of linksOf(markdown)) {
      const [path, anchor] = link.split('#');
      const target = path === '' ? page : resolve(dirname(page), path);
      const name = relative(root, page);
      if (!existsSync(target)) {
        problems.push(`${name}: link to ${link} — no such file`);
        continue;
      }
      if (
        anchor &&
        target.endsWith('.md') &&
        !anchorsOf(readFileSync(target, 'utf8')).has(anchor)
      ) {
        problems.push(`${name}: link to ${link} — no heading with that anchor`);
      }
    }
  }
  return problems;
}

/** The names an entry file exports, as TypeScript sees them (source, no build). */
export function exportedNames(root, entry) {
  const options = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    baseUrl: root,
    paths: { '@goway/contracts': ['packages/contracts/src/index.ts'] },
  };
  const file = resolve(root, entry);
  const program = ts.createProgram([file], options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) return [];
  return checker
    .getExportsOfModule(module)
    .map((symbol) => symbol.getName())
    .filter((name) => name !== 'default' && name !== 'export=');
}

export function checkReference(root, references) {
  const problems = [];
  for (const [page, entries] of Object.entries(references)) {
    const path = resolve(root, page);
    if (!existsSync(path)) {
      problems.push(`${page}: missing (it documents ${entries.join(', ')})`);
      continue;
    }
    // Inline code only: fenced blocks are dropped first, so their backticks
    // cannot pair across lines with the prose around them.
    const text = readFileSync(path, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
    const mentioned = new Set(
      [...text.matchAll(/`([^`\n]+)`/g)].flatMap((m) => m[1].match(/[A-Za-z_$][\w$]*/g) ?? []),
    );
    for (const entry of entries) {
      const names = exportedNames(root, entry);
      if (names.length === 0) {
        problems.push(
          `${page}: ${entry} exports nothing — the entry moved or the check cannot read it`,
        );
        continue;
      }
      for (const name of names) {
        if (!mentioned.has(name))
          problems.push(`${page}: \`${name}\` (exported by ${entry}) is not documented`);
      }
    }
  }
  return problems;
}

export function checkDeveloperDocs(root = repositoryRoot, options = {}) {
  const roots = options.docRoots ?? DOC_ROOTS;
  const extra = options.extraPages ?? EXTRA_PAGES;
  const pages = [
    ...roots.flatMap((directory) => markdownFiles(resolve(root, directory))),
    ...extra.map((page) => resolve(root, page)).filter((page) => existsSync(page)),
  ];
  if (pages.length === 0) return [`no developer docs found under ${roots.join(', ')}`];
  return [
    ...checkLinks(root, pages),
    ...checkReference(root, options.references ?? REFERENCE_PAGES),
  ];
}

if (import.meta.main) {
  const problems = checkDeveloperDocs();
  if (problems.length > 0) {
    console.error(`Developer docs: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const references = Object.keys(REFERENCE_PAGES).length;
  console.log(
    `Developer docs OK: every relative link resolves and ${references} reference page(s) name every export.`,
  );
}
