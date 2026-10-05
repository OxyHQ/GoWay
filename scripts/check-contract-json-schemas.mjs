#!/usr/bin/env bun

// Every named contract schema converts to JSON Schema, and the name list and
// the schema registry agree.
//
// `gowayJsonSchema(name)` calls `z.toJSONSchema` lazily, so a schema zod cannot
// convert — a transform in a response, a custom type, a name added to one
// structure and not the other — throws at the moment somebody asks for it: an
// integrator, or the OpenAPI generator on the next contract change. This closes
// that gap at CI time. (Pattern: CrowdSource's
// `check-published-json-schemas.mjs`. GoWay's contracts package is private and
// bundled into the SDK rather than published, so it is checked from source
// rather than from a packed tarball.)
//
// The assertions are deliberately NOT a count literal. A literal is a fourth
// place to update when a schema is added — and a merge resolving it to a
// plausible wrong number is exactly how a missing name passes. Instead:
//
//   * `CONTRACT_SCHEMA_NAMES` and the keys of `CONTRACT_SCHEMAS` must be the
//     same SET, in both directions;
//   * every entry must say which direction it travels in;
//   * every name must convert without throwing and yield a non-empty document;
//   * a floor and a duplicate check, so a broken import returning an empty
//     array, or a duplicate hiding an omission, cannot pass.
//
// The assertion logic is exported and pure so `test-check-contract-json-schemas.mjs`
// can mutation-test it; the CLI half only does the I/O.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fewest names the contracts have ever published. A floor, not an equality —
 * it never needs updating when a schema is ADDED.
 */
const MINIMUM_NAMES = 30;

const DIRECTIONS = new Set(["request", "response"]);

/** Checks the JSON-Schema surface of an imported contracts module. Returns the failures. */
export function assertJsonSchemaSurface(contracts) {
  const failures = [];
  const names = contracts.CONTRACT_SCHEMA_NAMES;
  const schemas = contracts.CONTRACT_SCHEMAS;
  const convert = contracts.gowayJsonSchema;

  if (!Array.isArray(names)) return ["CONTRACT_SCHEMA_NAMES is not an array; the package surface is not what this check expects."];
  if (schemas === null || typeof schemas !== "object") return ["CONTRACT_SCHEMAS is not an object; the package surface is not what this check expects."];
  if (typeof convert !== "function") return ["gowayJsonSchema is not a function; the package surface is not what this check expects."];

  if (names.length < MINIMUM_NAMES) {
    failures.push(
      `only ${names.length} schema name(s) found, below the floor of ${MINIMUM_NAMES}. ` +
        "Either the import is broken or names were removed; neither should pass silently.",
    );
  }

  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    failures.push(`duplicate name(s): ${[...new Set(duplicates)].join(", ")}. A duplicate inflates the count while hiding an omission.`);
  }

  const declared = new Set(names);
  const registered = new Set(Object.keys(schemas));
  const missingSchema = [...declared].filter((name) => !registered.has(name));
  const missingName = [...registered].filter((name) => !declared.has(name));
  if (missingSchema.length > 0) {
    failures.push(`named in CONTRACT_SCHEMA_NAMES but absent from CONTRACT_SCHEMAS: ${missingSchema.join(", ")}. Asking for one throws.`);
  }
  if (missingName.length > 0) {
    failures.push(
      `present in CONTRACT_SCHEMAS but not in CONTRACT_SCHEMA_NAMES: ${missingName.join(", ")}. ` +
        "It never reaches the OpenAPI document or an integrator enumerating the names.",
    );
  }

  for (const name of declared) {
    if (!registered.has(name)) continue;
    const entry = schemas[name];
    if (!entry || !DIRECTIONS.has(entry.direction)) {
      failures.push(`CONTRACT_SCHEMAS.${name} does not say whether it is a request or a response.`);
      continue;
    }
    let document;
    try {
      document = convert(name);
    } catch (error) {
      failures.push(
        `gowayJsonSchema('${name}') THREW: ${error instanceof Error ? error.message : String(error)}. ` +
          "Conversion is lazy, so this would reach an integrator or the OpenAPI generator rather than a build.",
      );
      continue;
    }
    if (document === null || typeof document !== "object" || Object.keys(document).length === 0) {
      failures.push(`gowayJsonSchema('${name}') returned no usable document.`);
    }
  }

  return failures;
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const contracts = await import(resolve(root, "packages", "contracts", "src", "index.ts"));
  const failures = assertJsonSchemaSurface(contracts);
  if (failures.length > 0) {
    console.error("The contracts have an unusable JSON-Schema surface:\n");
    for (const failure of failures) console.error(`::error::${failure}`);
    process.exit(1);
  }
  console.log(
    `All ${contracts.CONTRACT_SCHEMA_NAMES.length} contract schema name(s) convert to JSON Schema, ` +
      "and the name list and schema registry agree.",
  );
}
