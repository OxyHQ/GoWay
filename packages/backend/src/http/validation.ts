/**
 * The contract schemas at the edge, answered in GoWay's own error vocabulary.
 *
 * Every schema parsed here comes from `@goway/contracts` — the same object the
 * SDK validates its inputs with and the OpenAPI document is generated from.
 * There is no backend copy of a request shape to drift from the published one.
 *
 * ## `bad_request` and `validation_failed` are not the same failure
 *
 * `bad_request` is a MALFORMED request — bad JSON, a field of the wrong type,
 * a required field missing, an unknown or repeated query parameter — and
 * `validation_failed` is a well-formed request whose VALUES are refused: a
 * latitude of 120, a bounding box with `south > north`, a radius of zero. An
 * integrator acts differently on each: the first is a bug in their
 * serialisation, the second is a bug in what they asked for.
 *
 * So the mapping is mechanical rather than a judgement call at each call site.
 * In a BODY, a zod `invalid_type` issue (which is also what a missing field
 * produces) is `bad_request`. In a QUERY, only an unknown or repeated parameter
 * is: everything in a query string arrives as a string, so `latitude=abc` is
 * not a type error a client could have avoided by serialising differently — it
 * is a value this endpoint refuses.
 *
 * ## `details` names the FIELD and never the value
 *
 * `ApiErrorDetails` is the part of an error an integrator may log verbatim, and
 * GoWay's privacy rule is that a user's precise coordinate is transient request
 * data that is never persisted anywhere — including somebody else's log index.
 * A validation failure on a coordinate must not be the thing that writes it
 * down, so `details` carries the field path and the issue code, never the
 * offending value and never a message zod built out of it.
 */

import { queryValues } from '@goway/contracts';
import type { z } from 'zod';
import { ApiError, type ApiErrorCode, type ApiErrorDetails } from './apiError';

/** The field path of the first issue, and how many issues there were. */
function detailsFor(error: z.ZodError): ApiErrorDetails {
  const [first] = error.issues;
  return {
    field: first ? first.path.map((segment) => String(segment)).join('.') || '(root)' : '(root)',
    issue: first?.code ?? 'invalid',
    issueCount: error.issues.length,
  };
}

/**
 * A human-readable summary that names the offending FIELDS only.
 *
 * zod's own `issue.message` is interpolated with the received value for several
 * issue codes, which is exactly what must not be echoed — so the message is
 * built here from the paths instead of forwarded. An unknown parameter is named
 * by its key, which the caller wrote and which carries no value.
 */
function messageFor(error: z.ZodError, what: string): string {
  const fields = [
    ...new Set(
      error.issues.flatMap((issue) => {
        const path = issue.path.map(String).join('.');
        return issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => (path ? `${path}.${key}` : key))
          : [path || '(root)'];
      }),
    ),
  ];
  return `The ${what} is not acceptable: ${fields.join(', ')}.`;
}

function refuse(error: z.ZodError, code: ApiErrorCode, what: string): never {
  throw new ApiError(code, messageFor(error, what), detailsFor(error));
}

/**
 * Parse a request BODY.
 *
 * A wrong type or a missing required field is `bad_request`; anything else is
 * `validation_failed`. When both kinds are present the request is malformed,
 * which is the more fundamental complaint, so `bad_request` wins.
 */
export function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const malformed = result.error.issues.some((issue) => issue.code === 'invalid_type');
  refuse(result.error, malformed ? 'bad_request' : 'validation_failed', 'request body');
}

/**
 * Parse QUERY parameters against a contract query schema.
 *
 * A repeated parameter (`?limit=1&limit=2`) and one the schema does not declare
 * are `bad_request` — the first is ambiguous and the second is a client
 * talking about something this endpoint has never heard of, and silently
 * ignoring either answers a different question than the one asked. Every other
 * failure is `validation_failed`. Values are converted by the type their own
 * schema field declares (`queryValues`), so no endpoint carries a second,
 * string-typed copy of its parameters.
 */
export function parseQuery<S extends z.ZodObject>(schema: S, query: unknown): z.output<S> {
  const raw: Record<string, string> = {};
  const repeated: string[] = [];
  for (const [name, value] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') raw[name] = value;
    else repeated.push(name);
  }
  if (repeated.length > 0) {
    throw new ApiError(
      'bad_request',
      `Each query parameter may appear once; join a list with commas: ${repeated.join(', ')}.`,
      { field: repeated[0] ?? '(root)', issue: 'repeated_parameter', issueCount: repeated.length },
    );
  }

  const result = schema.safeParse(queryValues(schema, raw));
  if (result.success) return result.data;
  const unknown = result.error.issues.some((issue) => issue.code === 'unrecognized_keys');
  refuse(result.error, unknown ? 'bad_request' : 'validation_failed', 'request query');
}

/**
 * Parse PATH parameters.
 *
 * Always `bad_request`: a path segment that is not a place id or a capability
 * key is a URL the client built wrong, not a well-formed question this endpoint
 * refuses to answer — and answering 404 would tell a consumer their stored id
 * is dead when it was never sent.
 */
export function parsePath<S extends z.ZodObject>(schema: S, params: unknown): z.output<S> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  refuse(result.error, 'bad_request', 'request path');
}
