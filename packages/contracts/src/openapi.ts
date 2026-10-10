/**
 * The OpenAPI 3.1 document, generated from the route registry.
 *
 * Nothing here walks route files or reads a handler: every path, parameter,
 * body and response comes from {@link API_OPERATIONS} and every schema from
 * {@link CONTRACT_SCHEMAS} — the same objects the backend validates with and
 * the SDK parses with. The committed `openapi.json` is this function's output,
 * and `scripts/check-openapi-fresh.mjs` fails CI when the two differ.
 *
 * Deterministic by construction: the same contracts always produce the same
 * bytes, so a diff in the committed file is always a contract change.
 */

import { z } from 'zod';
import { API_ERROR_STATUS, type ApiErrorCode } from './errors';
import {
  CONTRACT_SCHEMA_NAMES,
  CONTRACT_SCHEMAS,
  jsonSchemaOptions,
  type ContractSchemaDirection,
  type JsonSchemaDocument,
} from './json-schema';
import { GOWAY_API_BASE_PATH } from './base-path';
import { API_OPERATIONS, UNIVERSAL_ERROR_CODES, type ApiOperation } from './operations';

/** The API's major version, as the path spells it. */
export const GOWAY_API_VERSION = '1';

/** Where the document is served, relative to the API origin. */
export const OPENAPI_DOCUMENT_PATH = `${GOWAY_API_BASE_PATH}/openapi.json`;

const SCHEMA_REF_PREFIX = '#/components/schemas/';

type JsonObject = Record<string, unknown>;

function schemaRef(name: string): JsonObject {
  return { $ref: `${SCHEMA_REF_PREFIX}${name}` };
}

/** A converted schema without the document-level keys a component or parameter must not carry. */
function embedded(document: JsonSchemaDocument): JsonObject {
  const { $schema: _schema, $id: _id, ...rest } = document as JsonObject;
  return rest;
}

/**
 * The named schemas of one direction, converted together so they reference
 * each other by `$ref` instead of inlining one another.
 */
function componentsFor(direction: ContractSchemaDirection): Record<string, JsonObject> {
  const registry = z.registry<{ id: string }>();
  for (const name of CONTRACT_SCHEMA_NAMES) {
    const entry = CONTRACT_SCHEMAS[name];
    if (entry.direction === direction) registry.add(entry.schema, { id: name });
  }
  const converted = z.toJSONSchema(registry, {
    ...jsonSchemaOptions(direction),
    uri: (id) => `${SCHEMA_REF_PREFIX}${id}`,
  });
  return Object.fromEntries(
    Object.entries(converted.schemas).map(([name, document]) => [name, embedded(document)]),
  );
}

function parametersOf(operation: ApiOperation): JsonObject[] {
  const parameters: JsonObject[] = [];
  const add = (location: 'path' | 'query', object: z.ZodObject | undefined): void => {
    if (!object) return;
    for (const [name, field] of Object.entries(object.shape as Record<string, z.ZodType>)) {
      const schema = embedded(z.toJSONSchema(field, jsonSchemaOptions('request')));
      const parameter: JsonObject = {
        name,
        in: location,
        required: location === 'path' || !field.safeParse(undefined).success,
        schema,
      };
      // A list is ONE comma-joined parameter (`capabilities=a.b,c.d`), never a
      // repeated one — a repeated parameter is `bad_request`.
      if (schema.type === 'array') Object.assign(parameter, { style: 'form', explode: false });
      parameters.push(parameter);
    }
  };
  add('path', operation.pathParameters);
  add('query', operation.query);
  return parameters;
}

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Malformed request',
  401: 'No valid Oxy session',
  403: 'Not permitted',
  404: 'Not found',
  409: 'Conflicts with current state',
  410: 'Withdrawn',
  413: 'Too large',
  422: 'Refused values',
  429: 'Rate limited; `Retry-After` and `details.retryAfterSeconds` say when to retry',
  500: 'Server defect',
  503: 'Degraded or unavailable; retry later',
};

function responsesOf(operation: ApiOperation): JsonObject {
  const responses: JsonObject = {};
  for (const [status, name] of Object.entries(operation.responses)) {
    responses[status] =
      name === null
        ? { description: 'No content' }
        : { description: 'Success', content: { 'application/json': { schema: schemaRef(name) } } };
  }

  const byStatus = new Map<number, ApiErrorCode[]>();
  for (const code of [...operation.errors, ...UNIVERSAL_ERROR_CODES]) {
    const status = API_ERROR_STATUS[code];
    const codes = byStatus.get(status) ?? [];
    if (!codes.includes(code)) codes.push(code);
    byStatus.set(status, codes);
  }
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const codes = byStatus.get(status) ?? [];
    responses[String(status)] = {
      description: `${ERROR_DESCRIPTIONS[status] ?? 'Error'}: ${codes.map((code) => `\`${code}\``).join(', ')}`,
      content: { 'application/json': { schema: schemaRef('ApiErrorBody') } },
    };
  }
  return responses;
}

const SECURITY: Readonly<Record<ApiOperation['auth'], JsonObject[]>> = {
  public: [],
  // `{}` first: no credential is an accepted way to call it.
  optional: [{}, { oxySession: [] }],
  required: [{ oxySession: [] }],
};

function operationObject(operation: ApiOperation): JsonObject {
  const object: JsonObject = {
    operationId: operation.operationId,
    summary: operation.summary,
    tags: [operation.tag],
    security: SECURITY[operation.auth],
  };
  const parameters = parametersOf(operation);
  if (parameters.length > 0) object.parameters = parameters;
  if (operation.body) {
    object.requestBody = {
      required: true,
      content: { 'application/json': { schema: schemaRef(operation.body) } },
    };
  }
  object.responses = responsesOf(operation);
  return object;
}

/** The GoWay API as an OpenAPI 3.1 document. */
export function buildOpenApiDocument(): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const operation of API_OPERATIONS) {
    const item = paths[operation.path] ?? {};
    item[operation.method] = operationObject(operation);
    paths[operation.path] = item;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'GoWay API',
      version: GOWAY_API_VERSION,
      summary:
        "Oxy's open map platform: Places, capability filters, search, geocoding, routing and Street 3D.",
      description:
        'Generated from `packages/contracts` — the zod schemas the API validates with and `@goway.to/sdk` parses with. ' +
        'Success bodies are the contract value with no envelope; every error is `{ "error": { "code", "message", "details"? } }`; ' +
        'every list is `{ "items", "nextCursor" }` with an opaque cursor bound to its filters.',
    },
    servers: [{ url: `https://api.goway.to${GOWAY_API_BASE_PATH}` }],
    tags: [...new Set(API_OPERATIONS.map((operation) => operation.tag))].map((name) => ({ name })),
    paths,
    components: {
      schemas: { ...componentsFor('response'), ...componentsFor('request') },
      securitySchemes: {
        oxySession: {
          type: 'http',
          scheme: 'bearer',
          description: 'An Oxy access token (`aud=oxy-api`), as `@oxy.so/services` issues it.',
        },
      },
    },
  };
}

/** The document as the bytes committed in `packages/contracts/openapi.json`. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
