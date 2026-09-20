#!/usr/bin/env bun

/**
 * Every Bun workspace member must have its `package.json` copied into the
 * backend image before `bun install --frozen-lockfile` runs.
 *
 * ## Why this is a gate and not a convention
 *
 * `--frozen-lockfile` resolves the WHOLE workspace graph, not just the part the
 * backend imports. `bun.lock` records that `@goway/frontend` depends on
 * `@goway.to/sdk`, so a member named in the lockfile and absent from the build
 * context is a hard error — `workspace "@goway/frontend" depends on workspace
 * "@goway.to/sdk" (packages/sdk), which is listed in bun.lock but not on disk`.
 *
 * That is exactly what happened: `packages/sdk` was added to `workspaces` and
 * the Dockerfile was not updated. It stayed invisible for five merges because
 * the deploy job never reached the image build — it was failing earlier, at the
 * AWS credential exchange. The first time the build actually ran, it failed.
 *
 * The failure surfaces only in a container build, which is the most expensive
 * place to learn it and the one a developer's machine never exercises.
 *
 * ## What it checks
 *
 * The root `workspaces` array is the source of truth. For each member, the
 * Dockerfile must copy its manifest in the dependency-install stage. Parsed
 * from structure — the workspace list from JSON, the COPY targets from the
 * Dockerfile — rather than grepped for a string, so a commented-out COPY does
 * not satisfy it.
 */

import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const DOCKERFILE = 'packages/backend/Dockerfile';

const workspaces = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')).workspaces;
if (!Array.isArray(workspaces) || workspaces.length === 0) {
  console.error('::error::root package.json declares no `workspaces` array; this check would measure nothing.');
  process.exit(1);
}

const dockerfile = readFileSync(`${ROOT}${DOCKERFILE}`, 'utf8');

/** COPY targets in the builder stage, ignoring comments and --from lines. */
const copied = new Set();
for (const raw of dockerfile.split('\n')) {
  const line = raw.trim();
  if (line.startsWith('#')) continue;
  const m = /^COPY\s+(?!--from)(.+)$/i.exec(line);
  if (!m) continue;
  for (const token of m[1].split(/\s+/)) copied.add(token);
}

if (copied.size === 0) {
  console.error(`::error::parsed no COPY instructions out of ${DOCKERFILE}; the parser is broken, not the Dockerfile.`);
  process.exit(1);
}

const missing = workspaces.filter((ws) => !copied.has(`${ws}/package.json`));

if (missing.length > 0) {
  for (const ws of missing) {
    console.error(
      `::error::${DOCKERFILE} never copies ${ws}/package.json, but the root \`workspaces\` array names ${ws}. ` +
        `\`bun install --frozen-lockfile\` resolves the whole graph and will fail with "listed in bun.lock but not on disk".`,
    );
  }
  process.exit(1);
}

console.log(
  `Dockerfile workspace coverage is sound: all ${workspaces.length} workspace member(s) ` +
    `(${workspaces.join(', ')}) have their manifest copied before the frozen install.`,
);
