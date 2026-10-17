#!/usr/bin/env bun

/**
 * Mutation-tests `check-developer-docs.mjs`.
 *
 * A docs gate fails quiet: a link regex with a typo finds no links and
 * reports a clean tree, and a reference check that cannot read an entry finds
 * no exports to miss. Each case below breaks exactly one thing in a scratch
 * tree and requires the REAL gate to name it; the passing cases matter as
 * much, so links inside code and absolute URLs never fire.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { anchorsOf, checkDeveloperDocs, slugOf } from './check-developer-docs.mjs';

let failed = 0;

function report(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const ENTRY =
  'export const createThing = () => 1;\nexport interface ThingOptions { size: number }\n';
const GOOD = {
  'docs/developers/README.md':
    '# Docs\n\nSee [the thing](thing/README.md#install-it) and [the API](https://example.org/x).\n',
  'docs/developers/thing/README.md':
    '# Thing\n\n## Install it\n\n```md\n[not a link](nowhere.md)\n```\n\nInline `[also not](nowhere.md)`.\n',
  'docs/developers/thing/api-reference.md': '# Reference\n\n`createThing`, `ThingOptions`.\n',
  'packages/thing/src/index.ts': ENTRY,
};
const REFERENCES = { 'docs/developers/thing/api-reference.md': ['packages/thing/src/index.ts'] };

async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), 'developer-docs-gate-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) continue;
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents, 'utf8');
    }
    return checkDeveloperDocs(root, { extraPages: [], references: REFERENCES });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log('check-developer-docs');

report(
  'slugs follow GitHub',
  slugOf('`MapView` props & events') === 'mapview-props--events',
  slugOf('`MapView` props & events'),
);
report('repeated headings get -1', anchorsOf('## A\n## A\n').has('a-1'));

let problems = await runAgainst(GOOD);
report(
  'a sound tree passes (code-fenced and inline links and URLs ignored)',
  problems.length === 0,
  problems.join('; '),
);

problems = await runAgainst({ ...GOOD, 'docs/developers/thing/README.md': null });
report(
  'a missing target file fails',
  problems.some((p) => p.includes('no such file')),
  problems.join('; '),
);

problems = await runAgainst({
  ...GOOD,
  'docs/developers/thing/README.md': '# Thing\n\n## Set it up\n',
});
report(
  'a missing anchor fails',
  problems.some((p) => p.includes('no heading with that anchor')),
  problems.join('; '),
);

problems = await runAgainst({
  ...GOOD,
  'docs/developers/thing/api-reference.md':
    '# Reference\n\n```ts\nconst x = 1;\n```\n\n`createThing` and `ThingOptions`.\n',
});
report(
  'a code fence on a reference page does not shift inline code',
  problems.length === 0,
  problems.join('; '),
);

problems = await runAgainst({
  ...GOOD,
  'docs/developers/thing/api-reference.md': '# Reference\n\n`createThing`.\n',
});
report(
  'an undocumented export fails, by name',
  problems.some((p) => p.includes('`ThingOptions`')),
  problems.join('; '),
);

problems = await runAgainst({ ...GOOD, 'packages/thing/src/index.ts': '// moved\n' });
report(
  'an entry that exports nothing fails',
  problems.some((p) => p.includes('exports nothing')),
  problems.join('; '),
);

problems = await runAgainst({ ...GOOD, 'docs/developers/thing/api-reference.md': null });
report(
  'a missing reference page fails',
  problems.some((p) => p.includes('missing')),
  problems.join('; '),
);

problems = await runAgainst({ 'packages/thing/src/index.ts': ENTRY });
report(
  'no docs at all fails',
  problems.some((p) => p.includes('no developer docs')),
  problems.join('; '),
);

if (failed > 0) {
  console.error(`check-developer-docs: ${failed} case(s) failed`);
  process.exit(1);
}
console.log('check-developer-docs: every rule can fail, and a sound tree passes');
