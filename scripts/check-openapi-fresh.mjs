#!/usr/bin/env bun

// Fail the build when `packages/contracts/openapi.json` stops describing the API
// it claims to describe.
//
// The document is GENERATED from the route registry in `@goway/contracts`
// (`API_OPERATIONS`) and the zod schemas the backend validates with — no route
// files are walked, so there is no hand-maintained mount map for a route to fall
// out of. That removes one failure and not the others, so this gate has four
// layers, and no layer covers another:
//
// Layer 1 — the surface is described, BY NAME. An explicit list of every
// operation an integrator's client is generated from, checked against the
// committed document. Not derived from the registry, because a list derived from
// the thing under test cannot disagree with it: an operation deleted from the
// registry and the regenerated document in the SAME commit is exactly what a
// freshness check alone stays green through.
//
// Layer 2 — every operation is USABLE: a unique `operationId` (what a generator
// names the function), a success response that names a schema (or a 204 that
// says it has no body), a request body exactly where the list says one is taken,
// a `security` statement, and the session scheme on every operation the list
// marks as requiring one. Counting "operations with a response schema" counts
// the error envelope every operation `$ref`s; this layer separates 2xx from the
// rest.
//
// Layer 3 — the document speaks the DIALECT it declares. `openapi: 3.1.0` is
// JSON Schema 2020-12: `nullable` does not exist and `exclusiveMinimum` is a
// number, not a boolean. Both are dropped in silence by a conforming consumer,
// so the constraint reads as present and is not. Every `$ref` must also resolve.
//
// Layer 4 — the artifact is FRESH: regenerate from the contracts and compare the
// bytes. This is the only layer that sees a schema or an operation change
// without the document being regenerated.
//
// The assertion logic is exported and pure so `test-check-openapi-fresh.mjs` can
// prove each layer fails; the CLI half only does the I/O.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every operation the GoWay API publishes, spelled out, with whether it takes a
 * request body and whether it requires an Oxy session.
 */
export const EXPECTED_OPERATIONS = [
  { method: "get", path: "/places/nearby", body: false, auth: false },
  { method: "get", path: "/places/bounds", body: false, auth: false },
  { method: "get", path: "/places", body: false, auth: false },
  { method: "get", path: "/places/{placeId}", body: false, auth: false },
  { method: "post", path: "/places", body: true, auth: true },
  { method: "patch", path: "/places/{placeId}", body: true, auth: true },
  { method: "put", path: "/places/{placeId}/capabilities/{key}", body: true, auth: true },
  { method: "delete", path: "/places/{placeId}/capabilities/{key}", body: false, auth: true },
  { method: "get", path: "/places/{placeId}/hours-exceptions", body: false, auth: false },
  { method: "post", path: "/places/{placeId}/hours-exceptions", body: true, auth: true },
  { method: "put", path: "/places/{placeId}/hours-exceptions/{exceptionId}", body: true, auth: true },
  { method: "delete", path: "/places/{placeId}/hours-exceptions/{exceptionId}", body: false, auth: true },
  { method: "get", path: "/places/{placeId}/media", body: false, auth: false },
  { method: "post", path: "/places/{placeId}/media", body: true, auth: true },
  { method: "put", path: "/places/{placeId}/media/order", body: true, auth: true },
  { method: "delete", path: "/places/{placeId}/media/{mediaId}", body: false, auth: true },
  { method: "post", path: "/places/{placeId}/media/{mediaId}/reports", body: true, auth: true },
  { method: "get", path: "/places/{placeId}/reviews", body: false, auth: false },
  { method: "get", path: "/places/{placeId}/reviews/mine", body: false, auth: true },
  { method: "put", path: "/places/{placeId}/reviews/mine", body: true, auth: true },
  { method: "delete", path: "/places/{placeId}/reviews/mine", body: false, auth: true },
  { method: "put", path: "/places/{placeId}/reviews/{reviewId}/reply", body: true, auth: true },
  { method: "delete", path: "/places/{placeId}/reviews/{reviewId}/reply", body: false, auth: true },
  { method: "post", path: "/places/{placeId}/reviews/{reviewId}/reports", body: true, auth: true },
  { method: "get", path: "/categories", body: false, auth: false },
  { method: "post", path: "/places/{placeId}/claims", body: true, auth: true },
  { method: "get", path: "/places/{placeId}/claims", body: false, auth: true },
  { method: "get", path: "/places/{placeId}/revisions", body: false, auth: false },
  { method: "post", path: "/places/{placeId}/reports", body: true, auth: true },
  { method: "get", path: "/claims", body: false, auth: true },
  { method: "get", path: "/moderation/claims", body: false, auth: true },
  { method: "post", path: "/moderation/claims/{claimId}/decision", body: true, auth: true },
  { method: "patch", path: "/moderation/places/{placeId}", body: true, auth: true },
  { method: "put", path: "/moderation/places/{placeId}/capabilities/{key}", body: true, auth: true },
  { method: "delete", path: "/moderation/places/{placeId}/capabilities/{key}", body: false, auth: true },
  { method: "get", path: "/moderation/places/{placeId}/revisions", body: false, auth: true },
  { method: "get", path: "/moderation/duplicates", body: false, auth: true },
  { method: "post", path: "/moderation/duplicates/{candidateId}/resolution", body: true, auth: true },
  { method: "get", path: "/moderation/reports", body: false, auth: true },
  { method: "post", path: "/moderation/reports/{reportId}/resolution", body: true, auth: true },
  { method: "get", path: "/moderation/places/{placeId}/media", body: false, auth: true },
  { method: "patch", path: "/moderation/places/{placeId}/media/{mediaId}", body: true, auth: true },
  { method: "get", path: "/moderation/places/{placeId}/reviews", body: false, auth: true },
  { method: "patch", path: "/moderation/places/{placeId}/reviews/{reviewId}", body: true, auth: true },
  { method: "delete", path: "/moderation/places/{placeId}/reviews/{reviewId}/reply", body: false, auth: true },
  { method: "get", path: "/search", body: false, auth: false },
  { method: "get", path: "/geocode", body: false, auth: false },
  { method: "get", path: "/geocode/reverse", body: false, auth: false },
  { method: "get", path: "/geocode/structured", body: false, auth: false },
  { method: "post", path: "/routes", body: true, auth: false },
  { method: "get", path: "/captures/policy", body: false, auth: false },
  { method: "get", path: "/captures/sessions", body: false, auth: true },
  { method: "post", path: "/captures/sessions", body: true, auth: true },
  { method: "get", path: "/captures/sessions/{sessionId}", body: false, auth: true },
  { method: "get", path: "/captures/sessions/{sessionId}/assets", body: false, auth: true },
  { method: "post", path: "/captures/sessions/{sessionId}/assets", body: true, auth: true },
  { method: "get", path: "/captures/assets/{assetId}", body: false, auth: true },
  { method: "post", path: "/captures/assets/{assetId}/finalize", body: true, auth: true },
  { method: "delete", path: "/captures/assets/{assetId}", body: false, auth: true },
  { method: "get", path: "/street3d/coverage", body: false, auth: false },
  { method: "get", path: "/street3d/scenes/{sceneId}", body: false, auth: false },
  { method: "post", path: "/street3d/scenes/{sceneId}/reports", body: true, auth: true },
];

/** A layer that examines nothing must fail, not pass. */
const MINIMUM_OPERATIONS = 25;

const METHODS = ["get", "post", "put", "patch", "delete"];

const FORBIDDEN_30_KEYWORDS = {
  nullable: "spell it as a type union, e.g. `type: [\"string\", \"null\"]`",
};

/** Every node of a JSON value, with its path, depth first. */
function* walk(value, path = "#") {
  yield [value, path];
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) yield* walk(entry, `${path}/${index}`);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) yield* walk(entry, `${path}/${key}`);
  }
}

/** Every operation in the document as `{ method, path, operation }`. */
function operationsOf(document) {
  const found = [];
  for (const [path, item] of Object.entries(document?.paths ?? {})) {
    for (const method of METHODS) {
      if (item?.[method]) found.push({ method, path, operation: item[method] });
    }
  }
  return found;
}

/**
 * Checks a committed OpenAPI document, and that it matches a freshly generated
 * one. Returns the failures; an empty array means the document is sound.
 */
export function assertOpenApiDocument(committedText, regeneratedText, expected = EXPECTED_OPERATIONS) {
  const failures = [];

  let document;
  try {
    document = JSON.parse(committedText);
  } catch (error) {
    return [`the committed document is not JSON: ${error instanceof Error ? error.message : String(error)}`];
  }

  if (expected.length < MINIMUM_OPERATIONS) {
    failures.push(`only ${expected.length} expected operation(s) listed, below the floor of ${MINIMUM_OPERATIONS}.`);
  }

  // Layer 3 (header first): the declared dialect.
  if (document.openapi !== "3.1.0") failures.push(`openapi is ${JSON.stringify(document.openapi)}, expected "3.1.0".`);

  const operations = operationsOf(document);
  const byKey = new Map(operations.map((entry) => [`${entry.method} ${entry.path}`, entry]));

  // Layer 1: the surface, by name.
  for (const want of expected) {
    const entry = byKey.get(`${want.method} ${want.path}`);
    if (!entry) {
      failures.push(`${want.method.toUpperCase()} ${want.path} is not described.`);
      continue;
    }
    // Layer 2, for the named operations: body and auth exactly as listed.
    const hasBody = entry.operation.requestBody?.content?.["application/json"]?.schema !== undefined;
    if (hasBody !== want.body) {
      failures.push(
        `${want.method.toUpperCase()} ${want.path} ${want.body ? "publishes no request body" : "publishes a request body it does not take"}.`,
      );
    }
    const security = entry.operation.security;
    const requiresSession =
      Array.isArray(security) &&
      security.length > 0 &&
      security.every((requirement) => requirement && Object.keys(requirement).includes("oxySession"));
    if (want.auth && !requiresSession) {
      failures.push(`${want.method.toUpperCase()} ${want.path} requires an Oxy session but is published as callable without one.`);
    }
  }
  for (const entry of operations) {
    if (!expected.some((want) => want.method === entry.method && want.path === entry.path)) {
      failures.push(`${entry.method.toUpperCase()} ${entry.path} is described but not in EXPECTED_OPERATIONS; add it there deliberately.`);
    }
  }

  // Layer 2: every operation usable.
  const seenIds = new Map();
  for (const { method, path, operation } of operations) {
    const name = `${method.toUpperCase()} ${path}`;
    if (typeof operation.operationId !== "string" || operation.operationId === "") {
      failures.push(`${name} has no operationId.`);
    } else if (seenIds.has(operation.operationId)) {
      failures.push(`${name} reuses operationId ${operation.operationId} from ${seenIds.get(operation.operationId)}.`);
    } else {
      seenIds.set(operation.operationId, name);
    }
    if (!Array.isArray(operation.security)) failures.push(`${name} states no security requirement.`);

    const successes = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status));
    if (successes.length === 0) failures.push(`${name} has no success response.`);
    for (const [status, response] of successes) {
      const schema = response?.content?.["application/json"]?.schema;
      if (status === "204") {
        if (schema !== undefined) failures.push(`${name} 204 publishes a body.`);
      } else if (schema === undefined || (typeof schema === "object" && Object.keys(schema).length === 0)) {
        failures.push(`${name} ${status} publishes no response schema.`);
      }
    }
  }

  // Layer 3: dialect and references.
  const components = document.components?.schemas ?? {};
  for (const [node, path] of walk(document)) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    for (const [keyword, advice] of Object.entries(FORBIDDEN_30_KEYWORDS)) {
      if (keyword in node) failures.push(`${path} uses the OpenAPI 3.0 keyword \`${keyword}\`: ${advice}.`);
    }
    for (const keyword of ["exclusiveMinimum", "exclusiveMaximum"]) {
      if (typeof node[keyword] === "boolean") {
        failures.push(`${path} has a boolean \`${keyword}\`; in 3.1 the keyword carries the bound.`);
      }
    }
    if (typeof node.$ref === "string") {
      const match = /^#\/components\/schemas\/(.+)$/.exec(node.$ref);
      if (!match || !(match[1] in components)) failures.push(`${path} references ${node.$ref}, which does not exist.`);
    }
  }

  // Layer 4: freshness.
  if (committedText !== regeneratedText) {
    failures.push(
      "packages/contracts/openapi.json is STALE: the contracts generate a different document. " +
        "Run `bun run openapi` and commit the result.",
    );
  }

  return failures;
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const committed = readFileSync(resolve(root, "packages", "contracts", "openapi.json"), "utf8");
  const { serializeOpenApiDocument } = await import(resolve(root, "packages", "contracts", "src", "openapi.ts"));
  const failures = assertOpenApiDocument(committed, serializeOpenApiDocument());
  if (failures.length > 0) {
    console.error("The OpenAPI document does not describe the API:\n");
    for (const failure of failures) console.error(`::error::${failure}`);
    process.exit(1);
  }
  console.log(
    `OpenAPI document is sound and fresh: all ${EXPECTED_OPERATIONS.length} named operations described, ` +
      "every success schema present, 3.1 dialect, every $ref resolved, bytes identical to the generator.",
  );
}
