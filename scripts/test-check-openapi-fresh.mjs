#!/usr/bin/env bun

// Proves check-openapi-fresh.mjs can FAIL, layer by layer.
//
// A gate that cannot fail is indistinguishable from one that cannot pass. Each
// case below takes the real committed document, breaks exactly one thing a
// layer exists to catch, and asserts that the gate names it — and the untouched
// document must pass, so a gate that fails everything is caught too. The last
// case runs the real CLI against this repository, which is what CI runs.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOpenApiDocument, EXPECTED_OPERATIONS } from './check-openapi-fresh.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const committed = readFileSync(resolve(root, 'packages', 'contracts', 'openapi.json'), 'utf8');
const failures = [];

/** A deep copy of the document, edited, re-serialized the way the generator writes it. */
function mutate(edit) {
  const document = JSON.parse(committed);
  edit(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

function expectPass(name, text, regenerated = text) {
  const found = assertOpenApiDocument(text, regenerated);
  if (found.length > 0) failures.push(`${name}: expected a pass, got:\n  ${found.join('\n  ')}`);
}

function expectFail(name, text, pattern, regenerated = text, expected = EXPECTED_OPERATIONS) {
  const found = assertOpenApiDocument(text, regenerated, expected);
  if (!found.some((failure) => pattern.test(failure))) {
    failures.push(
      `${name}: expected a failure matching ${pattern}, got:\n  ${found.join('\n  ') || '(none)'}`,
    );
  }
}

expectPass('the committed document', committed);

// Layer 4 — the load-bearing one for "regenerate after every contract change".
expectFail(
  'a stale document',
  committed,
  /STALE/,
  mutate((document) => {
    document.components.schemas.Place.properties.name.maxLength = 1;
  }),
);

// Layer 1 — an operation dropped together with its artifact passes freshness.
const dropped = mutate((document) => {
  delete document.paths['/places/nearby'].get;
});
expectFail(
  'an operation dropped from document and generator alike',
  dropped,
  /GET \/places\/nearby is not described/,
  dropped,
);

const extra = mutate((document) => {
  document.paths['/secret'] = { get: document.paths['/claims'].get };
});
expectFail(
  'an operation nobody listed',
  extra,
  /GET \/secret is described but not in EXPECTED_OPERATIONS/,
  extra,
);

// Layer 2 — usable operations.
const noBody = mutate((document) => {
  delete document.paths['/places'].post.requestBody;
});
expectFail(
  'a write that publishes no body',
  noBody,
  /POST \/places publishes no request body/,
  noBody,
);

const noSchema = mutate((document) => {
  document.paths['/search'].get.responses['200'].content['application/json'].schema = {};
});
expectFail(
  'a success response with an empty schema',
  noSchema,
  /GET \/search 200 publishes no response schema/,
  noSchema,
);

const duplicateId = mutate((document) => {
  document.paths['/geocode'].get.operationId = 'search';
});
expectFail(
  'two operations with one operationId',
  duplicateId,
  /reuses operationId search/,
  duplicateId,
);

const unauthenticated = mutate((document) => {
  document.paths['/claims'].get.security = [{}];
});
expectFail(
  'a session-only read published as anonymous',
  unauthenticated,
  /GET \/claims requires an Oxy session/,
  unauthenticated,
);

// Layer 3 — dialect and references.
const nullable = mutate((document) => {
  document.components.schemas.Place.properties.name.nullable = true;
});
expectFail('an OpenAPI 3.0 `nullable`', nullable, /3\.0 keyword `nullable`/, nullable);

const booleanBound = mutate((document) => {
  document.components.schemas.PlaceWithDistance.properties.distanceMeters.exclusiveMinimum = true;
});
expectFail('a boolean exclusiveMinimum', booleanBound, /boolean `exclusiveMinimum`/, booleanBound);

const dangling = mutate((document) => {
  delete document.components.schemas.PlacePage;
});
expectFail(
  'a $ref to a schema that is gone',
  dangling,
  /references #\/components\/schemas\/PlacePage/,
  dangling,
);

// Vacuity floor: an emptied expectation list must not read as a pass.
expectFail('an emptied operation list', committed, /below the floor/, committed, []);

// The CLI, against this repository, the way CI runs it.
const cli = Bun.spawnSync({
  cmd: [process.execPath, resolve(root, 'scripts', 'check-openapi-fresh.mjs')],
  cwd: root,
});
if (cli.exitCode !== 0) {
  failures.push(`the CLI failed on this repository:\n${new TextDecoder().decode(cli.stderr)}`);
}

if (failures.length > 0) {
  console.error(`check-openapi-fresh self-test FAILED:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(
  'check-openapi-fresh can pass and fails on every layer it claims: freshness, named surface, usability, dialect, references, floor.',
);
