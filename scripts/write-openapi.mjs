#!/usr/bin/env bun

// Write `packages/contracts/openapi.json` from the route registry and the zod
// contracts. Run `bun run openapi` after any contract change and commit the
// result; `check-openapi-fresh.mjs` fails CI otherwise.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { serializeOpenApiDocument } = await import(resolve(root, "packages", "contracts", "src", "openapi.ts"));
const target = resolve(root, "packages", "contracts", "openapi.json");
writeFileSync(target, serializeOpenApiDocument());
console.log(`wrote ${target}`);
