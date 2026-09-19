import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  API_ERROR_RETRYABLE,
  API_ERROR_STATUS,
  createGoWayClient,
  GoWayApiError,
  GoWayConflictError,
  GoWayError,
  GoWayForbiddenError,
  GoWayNetworkError,
  GoWayNoRouteError,
  GoWayNotFoundError,
  GoWayRateLimitError,
  GoWayResponseError,
  GoWayUnauthorizedError,
  GoWayUnavailableError,
  GoWayUnsupportedModeError,
  GoWayValidationError,
  isGoWayError,
  type ApiErrorCode,
} from '../src/index';
import { errorBody, PLACE } from './fixtures';
import { failingFetch, fakeFetch, rejection } from './helpers';

/**
 * The expected class for every code, written out INDEPENDENTLY of the mapping
 * in `src/errors.ts`. `API_ERROR_CODES` drives the loop, so a code added to
 * `packages/shared-types` and forgotten here fails this test as well as the
 * build.
 */
const EXPECTED: Record<ApiErrorCode, new (...args: never[]) => GoWayError> = {
  bad_request: GoWayValidationError,
  validation_failed: GoWayValidationError,
  unauthorized: GoWayUnauthorizedError,
  forbidden: GoWayForbiddenError,
  not_found: GoWayNotFoundError,
  conflict: GoWayConflictError,
  rate_limited: GoWayRateLimitError,
  no_route: GoWayNoRouteError,
  unsupported_mode: GoWayUnsupportedModeError,
  provider_unavailable: GoWayUnavailableError,
  service_unavailable: GoWayUnavailableError,
  internal_error: GoWayUnavailableError,
  method_not_allowed: GoWayValidationError,
  payload_too_large: GoWayValidationError,
};

async function throwing(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<GoWayError> {
  const { fetch } = fakeFetch(status, body, headers);
  return rejection(createGoWayClient({ fetch }).places.get('gw_place_01H8'));
}

describe('API error codes', () => {
  it('covers every code in the shared vocabulary', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  for (const code of API_ERROR_CODES) {
    it(`maps ${code} to its class, status and retryability`, async () => {
      const error = await throwing(API_ERROR_STATUS[code], errorBody(code, 'the server said so'));
      expect(error).toBeInstanceOf(EXPECTED[code]);
      expect(error).toBeInstanceOf(GoWayError);
      expect(isGoWayError(error)).toBe(true);
      expect(error.code).toBe(code);
      expect(error.status).toBe(API_ERROR_STATUS[code]);
      // Retryability is the API's answer, never the class default: internal_error
      // and provider_unavailable share GoWayUnavailableError but not this.
      expect(error.retryable).toBe(API_ERROR_RETRYABLE[code]);
      expect(error.message).toContain('the server said so');
      expect(error.toJSON()).toMatchObject({ code, status: API_ERROR_STATUS[code] });
    });
  }

  it('treats no_route and unsupported_mode as domain answers, not defects', async () => {
    const noRoute = await throwing(422, errorBody('no_route', 'no path between these points'));
    expect(noRoute).toBeInstanceOf(GoWayNoRouteError);
    // An API error, NOT a validation error: the request was perfectly valid.
    expect(noRoute).toBeInstanceOf(GoWayApiError);
    expect(noRoute).not.toBeInstanceOf(GoWayValidationError);
    expect(noRoute.retryable).toBe(false);

    const mode = await throwing(422, errorBody('unsupported_mode'));
    expect(mode).toBeInstanceOf(GoWayUnsupportedModeError);
    expect(mode).not.toBeInstanceOf(GoWayValidationError);
  });

  it('carries the details envelope and reads retryAfterSeconds from it', async () => {
    const error = (await throwing(
      429,
      errorBody('rate_limited', 'slow down', { retryAfterSeconds: 42 }),
    )) as GoWayRateLimitError;
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.details).toEqual({ retryAfterSeconds: 42 });
    expect(error.toJSON()).toMatchObject({ retryAfterSeconds: 42, retryable: true });
  });

  it('falls back to the Retry-After header', async () => {
    const error = (await throwing(429, errorBody('rate_limited'), { 'Retry-After': '17' })) as GoWayRateLimitError;
    expect(error.retryAfterSeconds).toBe(17);
  });

  it('bounds and flattens a hostile server message', async () => {
    const error = await throwing(500, errorBody('internal_error', `a\nb\u0000c${'x'.repeat(500)}`));
    expect(error.message).not.toContain('\n');
    expect(error.message.length).toBeLessThan(300);
  });
});

describe('errors with no GoWay error body', () => {
  it('does not claim a bare 404 means the place is gone', async () => {
    const error = await throwing(404, '<html>nginx</html>');
    expect(error).toBeInstanceOf(GoWayApiError);
    expect(error).not.toBeInstanceOf(GoWayNotFoundError);
  });

  it('still classifies 401, 403, 429 and 5xx from the status alone', async () => {
    expect(await throwing(401, '')).toBeInstanceOf(GoWayUnauthorizedError);
    expect(await throwing(403, '')).toBeInstanceOf(GoWayForbiddenError);
    expect(await throwing(429, '')).toBeInstanceOf(GoWayRateLimitError);
    expect(await throwing(503, '')).toBeInstanceOf(GoWayUnavailableError);
    expect(await throwing(418, '')).toBeInstanceOf(GoWayApiError);
  });

  it('reports an unreachable network as a retryable network error', async () => {
    const client = createGoWayClient({ fetch: failingFetch(new TypeError('fetch failed')) });
    const error = await rejection(client.places.get('a'));
    expect(error).toBeInstanceOf(GoWayNetworkError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBeNull();
  });

  it('reports an unparseable success body as a response error', async () => {
    const error = await throwing(200, 'not json at all');
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.code).toBe('malformed_response');
  });
});

describe('the cross-copy lineage brand', () => {
  it('recognises an error thrown by another copy of the SDK', () => {
    const brand = Symbol.for('@goway.to/sdk:error-lineage');
    // What an error from a second (CJS) copy of this package looks like here:
    // a plain object carrying the lineage, whose prototype chain we do not share.
    const fromOtherCopy = Object.defineProperty(new Error('from the CJS copy'), brand, {
      value: Object.freeze(['GoWayNotFoundError', 'GoWayError']),
      enumerable: false,
    });
    expect(fromOtherCopy).toBeInstanceOf(GoWayNotFoundError);
    expect(fromOtherCopy).toBeInstanceOf(GoWayError);
    expect(isGoWayError(fromOtherCopy)).toBe(true);
    expect(fromOtherCopy).not.toBeInstanceOf(GoWayForbiddenError);
  });

  it('brands a real error with its whole ancestry', async () => {
    const brand = Symbol.for('@goway.to/sdk:error-lineage');
    const error = (await throwing(404, errorBody('not_found'))) as GoWayError & Record<symbol, string[]>;
    expect(error[brand]).toEqual(['GoWayNotFoundError', 'GoWayError']);
    expect(Object.keys(error)).not.toContain('cause');
  });

  it('leaves nothing sensitive in toJSON', async () => {
    const { fetch } = fakeFetch(500, errorBody('internal_error', 'boom'));
    const client = createGoWayClient({ fetch, getAccessToken: () => 'super-secret' });
    const error = await rejection(client.places.get('a'));
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('stack');
  });

  it('does not treat a foreign error as a GoWay one', () => {
    expect(isGoWayError(new Error('unrelated'))).toBe(false);
    expect(isGoWayError({ code: 'not_found' })).toBe(false);
    expect(isGoWayError(null)).toBe(false);
  });
});

describe('successful responses are not errors', () => {
  it('parses a 200 straight through', async () => {
    const { fetch } = fakeFetch(200, PLACE);
    const place = await createGoWayClient({ fetch }).places.get('gw_place_01H8');
    expect(place.id).toBe('gw_place_01H8');
  });
});
