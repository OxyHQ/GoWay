/**
 * zod at the edge, answered in GoWay's own error vocabulary.
 *
 * ## `bad_request` and `validation_failed` are not the same failure
 *
 * The contract draws the line explicitly: `bad_request` is a MALFORMED request
 * — bad JSON, a field of the wrong type, a required field missing —
 * and `validation_failed` is a well-formed request whose VALUES are refused: a
 * latitude of 120, a bounding box with `south > north`, a radius of zero.
 * An integrator acts differently on each: the first is a bug in their
 * serialisation, the second is a bug in what they asked for.
 *
 * So the mapping is mechanical rather than a judgement call at each call site:
 * a zod `invalid_type` issue (which is also what a MISSING field produces) is
 * `bad_request`; every other issue is `validation_failed`. A query string
 * carries only strings, so nothing in it can be "the wrong type" — every query
 * failure is a refused value, and {@link parseQuery} says so unconditionally.
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
 * built here from the paths instead of forwarded.
 */
function messageFor(error: z.ZodError, what: string): string {
  const fields = [...new Set(error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'))];
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
export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const malformed = result.error.issues.some((issue) => issue.code === 'invalid_type');
  refuse(result.error, malformed ? 'bad_request' : 'validation_failed', 'request body');
}

/**
 * Parse QUERY parameters.
 *
 * Always `validation_failed`. Everything in a query string arrives as a string,
 * so `latitude=abc` is not a type error a client could have avoided by
 * serialising differently — it is a value this endpoint refuses.
 */
export function parseQuery<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  refuse(result.error, 'validation_failed', 'request query');
}
