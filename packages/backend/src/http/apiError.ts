/**
 * GoWay's error vocabulary, applied.
 *
 * Every failure an API caller can observe is one of the codes in
 * `@goway/shared-types`, inside the envelope `{ error: { code, message,
 * details? } }`. The CODES are the public contract — not the HTTP status, not
 * the message text. An integrator branches on `not_found` to stop retrying and
 * on `service_unavailable` to keep retrying, so a handler that invents its own
 * shape silently changes what a caller does with a failure.
 *
 * ## The vocabulary is DEFINED in shared-types, not here
 *
 * `packages/shared-types` owns the tuple and `@goway.to/sdk` builds its typed
 * errors from the same tuple; this module only re-exports it and adds the
 * server-side `ApiError` class. One definition means the SDK's union cannot
 * drift from the API's: adding a code widens both in the same commit, and both
 * sides index TOTAL `Record<ApiErrorCode, …>` maps, so forgetting one half is a
 * compile error. Two hand-kept lists disagree silently instead, and the
 * disagreement only surfaces as an SDK consumer's `switch` falling through on a
 * real failure — which is exactly what happened here before they were merged.
 *
 * Anything thrown that is NOT an `ApiError` is a DEFECT rather than a contract
 * case: `errorHandler` answers it `500 internal_error` and leaks nothing — no
 * message, no stack, no driver detail.
 */

import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiErrorDetails,
} from '@goway/shared-types';

export { API_ERROR_CODES, API_ERROR_STATUS };
export type { ApiErrorBody, ApiErrorCode, ApiErrorDetails };

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: ApiErrorDetails;

  constructor(code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.details = details;
  }

  /** The response body for this failure. */
  toResponseBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
