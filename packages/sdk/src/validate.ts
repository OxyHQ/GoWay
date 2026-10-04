import { z } from 'zod';
import { GoWayResponseError, GoWayValidationError } from './errors';

/**
 * The one place a contract schema meets a value — on the way out (a caller's
 * input) and on the way in (a response body).
 *
 * ## Both directions use the contract's own schema
 *
 * There is no SDK-side parser or validator to drift from the server's: the
 * request schemas are the ones the backend validates with, and the response
 * schemas are the ones it is contracted to answer with. A response object is
 * rebuilt by zod with exactly the contract's keys — unknown keys are stripped,
 * so a column the backend leaks tomorrow (an internal PostGIS geometry, a
 * reviewer id, a contributor's account) never reaches a consumer even if the
 * backend's own projection regresses.
 *
 * ## Messages name the PATH and the expectation, never the value
 *
 * A failure is reported as `response.items[3].location.latitude: Too big: …`.
 * The value itself is never quoted: a response field is arbitrary server data,
 * and an input field may be the user's precise location, and both end up in
 * whatever error tracker the consumer runs. zod only puts the input on an issue
 * when asked to (`reportInput`), which this module never does.
 *
 * Messages come from zod's English locale passed PER PARSE. `zod` is a shared
 * dependency, so a consumer's own `z.config({ customError })` — which may well
 * quote `issue.input` — would otherwise decide what a GoWay error says. A
 * per-parse map outranks the global one; a message the contract itself wrote on
 * a refinement outranks both, and those are fixed strings.
 */

const ENGLISH = z.locales.en().localeError;

/** The most issues one message lists; the rest are counted. */
const MAX_ISSUES_SHOWN = 3;

function pathOf(root: string, path: readonly PropertyKey[]): string {
  let rendered = root;
  for (const key of path) rendered += typeof key === 'number' ? `[${key}]` : `.${String(key)}`;
  return rendered;
}

function describe(error: z.ZodError, root: string): string {
  const shown = error.issues.slice(0, MAX_ISSUES_SHOWN).map((issue) => `${pathOf(root, issue.path)}: ${issue.message}`);
  const hidden = error.issues.length - shown.length;
  return hidden > 0 ? `${shown.join('; ')} (and ${hidden} more)` : shown.join('; ');
}

/**
 * A caller's input, parsed by its contract request schema — or a
 * {@link GoWayValidationError} with `status: null`, and no request sent.
 *
 * The PARSED value is what the SDK sends, never the caller's object: it is
 * normalized (a locale tag canonical, a country code upper-cased, a place name
 * trimmed) and it holds only the keys the contract names, so a body can never
 * carry a `verification`, an `id` or anything else a future server might read.
 */
export function validInput<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value, { error: ENGLISH });
  if (!result.success) throw new GoWayValidationError(describe(result.error, what), { cause: result.error });
  return result.data;
}

/** A 2xx body, parsed by its contract response schema — or a {@link GoWayResponseError}. */
export function validResponse<T>(schema: z.ZodType<T>, body: unknown, status: number): T {
  const result = schema.safeParse(body, { error: ENGLISH });
  if (!result.success) {
    throw new GoWayResponseError(`GoWay returned a malformed response: ${describe(result.error, 'response')}`, {
      status,
      cause: result.error,
    });
  }
  return result.data;
}
