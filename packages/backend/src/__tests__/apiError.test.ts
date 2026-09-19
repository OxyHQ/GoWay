/**
 * The error vocabulary.
 *
 * These codes are the PUBLIC contract: `packages/shared-types` re-exports the
 * tuple and `@goway.to/sdk` builds its typed errors from it, so a consumer's
 * `switch` is only exhaustive if this list is the one the API actually answers
 * with.
 */

import { describe, expect, it } from 'bun:test';
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  ApiError,
  isApiError,
  type ApiErrorCode,
} from '../http/apiError';

describe('API_ERROR_CODES', () => {
  it('is not empty', () => {
    // Vacuity floor. Every assertion below iterates this tuple, so an empty one
    // would make the whole file pass while checking nothing.
    expect(API_ERROR_CODES.length).toBeGreaterThan(5);
  });

  it('has no duplicates', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  it('maps every code to exactly one HTTP status', () => {
    // A code added to the tuple and forgotten in the status map would otherwise
    // produce `undefined`, which Express turns into a 200 — a failure reported
    // as a success.
    for (const code of API_ERROR_CODES) {
      const status = API_ERROR_STATUS[code];
      expect(typeof status).toBe('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('has no status entry that is not a declared code', () => {
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual([...API_ERROR_CODES].sort());
  });
});

describe('ApiError', () => {
  it('carries the status its code maps to', () => {
    for (const code of API_ERROR_CODES) {
      expect(new ApiError(code, 'x').status).toBe(API_ERROR_STATUS[code]);
    }
  });

  it('renders the { error: { code, message } } envelope', () => {
    const body = new ApiError('not_found', 'No such place.').toResponseBody();
    expect(body).toEqual({ error: { code: 'not_found', message: 'No such place.' } });
  });

  it('omits details entirely when there are none', () => {
    // `details: undefined` is not the same wire shape as an absent key once it
    // goes through JSON.stringify, and a consumer checking `'details' in error`
    // sees the difference.
    expect('details' in new ApiError('conflict', 'x').toResponseBody().error).toBe(false);
  });

  it('includes details when given', () => {
    const body = new ApiError('bad_request', 'Bad radius.', {
      parameter: 'radius',
      maximum: 50_000,
    }).toResponseBody();
    expect(body.error.details).toEqual({ parameter: 'radius', maximum: 50_000 });
  });

  it('is recognised by isApiError, and nothing else is', () => {
    expect(isApiError(new ApiError('forbidden', 'x'))).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
    expect(isApiError({ code: 'forbidden', status: 403 })).toBe(false);
    expect(isApiError(null)).toBe(false);
  });

  it('is a real Error, so a throw keeps its stack', () => {
    const error = new ApiError('internal_error', 'x');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(typeof error.stack).toBe('string');
  });
});

describe('the codes the SDK depends on', () => {
  // Named explicitly rather than derived from the tuple. Deriving would make
  // this test agree with any change, including a deletion — and deleting a code
  // is a breaking change for every consumer that branches on it.
  const REQUIRED: readonly ApiErrorCode[] = [
    'bad_request',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'rate_limited',
    'internal_error',
    'service_unavailable',
  ];

  it('are all present', () => {
    for (const code of REQUIRED) expect(API_ERROR_CODES).toContain(code);
  });
});
