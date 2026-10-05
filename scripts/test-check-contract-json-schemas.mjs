#!/usr/bin/env bun

// Proves check-contract-json-schemas.mjs can FAIL.
//
// Each case hands the pure assertion a synthetic contracts module with exactly
// one defect; the real module must pass. The last case runs the real CLI.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertJsonSchemaSurface } from "./check-contract-json-schemas.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const real = await import(resolve(root, "packages", "contracts", "src", "index.ts"));
const failures = [];

/** The real module with some of its surface replaced. */
function variant(overrides) {
  return {
    CONTRACT_SCHEMA_NAMES: real.CONTRACT_SCHEMA_NAMES,
    CONTRACT_SCHEMAS: real.CONTRACT_SCHEMAS,
    gowayJsonSchema: real.gowayJsonSchema,
    ...overrides,
  };
}

function expectPass(name, contracts) {
  const found = assertJsonSchemaSurface(contracts);
  if (found.length > 0) failures.push(`${name}: expected a pass, got:\n  ${found.join("\n  ")}`);
}

function expectFail(name, contracts, pattern) {
  const found = assertJsonSchemaSurface(contracts);
  if (!found.some((failure) => pattern.test(failure))) {
    failures.push(`${name}: expected a failure matching ${pattern}, got:\n  ${found.join("\n  ") || "(none)"}`);
  }
}

expectPass("the real contracts", real);

const [first, ...rest] = real.CONTRACT_SCHEMA_NAMES;
expectFail("a name with no schema", variant({ CONTRACT_SCHEMA_NAMES: [...real.CONTRACT_SCHEMA_NAMES, "Ghost"] }), /absent from CONTRACT_SCHEMAS: Ghost/);
expectFail("a schema with no name", variant({ CONTRACT_SCHEMA_NAMES: rest }), new RegExp(`not in CONTRACT_SCHEMA_NAMES: ${first}`));
expectFail("a duplicate name", variant({ CONTRACT_SCHEMA_NAMES: [...real.CONTRACT_SCHEMA_NAMES, first] }), /duplicate name/);
expectFail("an emptied list", variant({ CONTRACT_SCHEMA_NAMES: [], CONTRACT_SCHEMAS: {} }), /below the floor/);
expectFail(
  "an entry with no direction",
  variant({ CONTRACT_SCHEMAS: { ...real.CONTRACT_SCHEMAS, [first]: { schema: real.CONTRACT_SCHEMAS[first].schema } } }),
  new RegExp(`${first} does not say whether`),
);
expectFail(
  "a schema that cannot be converted",
  variant({
    gowayJsonSchema: (name) => {
      if (name === first) throw new Error("Transforms cannot be represented in JSON Schema");
      return real.gowayJsonSchema(name);
    },
  }),
  new RegExp(`gowayJsonSchema\\('${first}'\\) THREW`),
);
expectFail("a broken surface", { CONTRACT_SCHEMA_NAMES: "nope" }, /not an array/);

const cli = Bun.spawnSync({ cmd: [process.execPath, resolve(root, "scripts", "check-contract-json-schemas.mjs")], cwd: root });
if (cli.exitCode !== 0) failures.push(`the CLI failed on this repository:\n${new TextDecoder().decode(cli.stderr)}`);

if (failures.length > 0) {
  console.error(`check-contract-json-schemas self-test FAILED:\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("check-contract-json-schemas can pass and fails on every defect it claims to catch.");
