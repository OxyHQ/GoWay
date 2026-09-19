/**
 * The GoWay API error vocabulary — one definition, three consumers.
 *
 * The backend raises these codes, its HTTP layer serializes {@link ApiErrorBody}
 * and `@goway.to/sdk` maps them back to typed errors. Defining the codes here
 * rather than in each layer is what stops `goway.places.get()` throwing
 * "not found" while the API answers something else: both sides index total
 * `Record<ApiErrorCode, …>` maps, so a code added on one side and not the other
 * fails to typecheck instead of drifting silently.
 *
 * These codes are a **public contract**. Renaming one is a breaking change.
 */

/**
 * Every error code the GoWay API may return, in status order.
 *
 * Two pairs look redundant and are not:
 *
 * - `bad_request` is a malformed request (bad JSON, wrong type, missing field);
 *   `validation_failed` is a well-formed request whose values are refused
 *   (a latitude of 120, a bounding box with `south > north`).
 * - `service_unavailable` is GoWay itself degraded or draining;
 *   `provider_unavailable` is an upstream geographic provider failing. A client
 *   can retry both, but only the second means "the map data source is down",
 *   which is a different thing to tell a user.
 */
export const API_ERROR_CODES = [
  /** Malformed request: bad JSON, wrong type, missing required field. */
  'bad_request',
  /** No credentials, or credentials that did not verify. */
  'unauthorized',
  /** Authenticated, but not permitted to do this. */
  'forbidden',
  /** The addressed resource does not exist, or is not visible to this caller. */
  'not_found',
  /** The route exists but not for this HTTP method. */
  'method_not_allowed',
  /** The request conflicts with current state (duplicate claim, stale update). */
  'conflict',
  /** The request body exceeded the accepted size. */
  'payload_too_large',
  /** Well-formed, but a value failed semantic validation. */
  'validation_failed',
  /** A routing request is well-formed but no route exists. Not a failure of GoWay. */
  'no_route',
  /** The requested travel mode is not supported by the active routing provider. */
  'unsupported_mode',
  /** The caller exceeded a rate limit. Carries `retryAfterSeconds` in `details`. */
  'rate_limited',
  /** An unexpected server-side defect. Never carries internal detail. */
  'internal_error',
  /** An upstream geographic provider failed, timed out or rate-limited GoWay. */
  'provider_unavailable',
  /** GoWay itself is degraded, draining or not yet ready to serve. */
  'service_unavailable',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Machine-readable context for a failure.
 *
 * Scalars only, and never user content or a coordinate: `details` is the part
 * of an error an integrator may log verbatim, and GoWay's privacy rule is that
 * a user's precise location is transient request data that is never persisted
 * anywhere — including somebody else's log index.
 */
export type ApiErrorDetails = Record<string, string | number | boolean | null>;

/**
 * The serialized error envelope. Every non-2xx GoWay API response has this
 * shape, so a consumer never has to branch on which endpoint failed.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** Human-readable, safe to log. Not safe to parse — the code is the contract. */
    message: string;
    details?: ApiErrorDetails;
  };
}

/**
 * The HTTP status each code is answered with.
 *
 * Typed as a total `Record<ApiErrorCode, number>` rather than inferred from its
 * own keys, so a code added to the tuple above and forgotten here is a compile
 * error instead of an `undefined` status.
 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  validation_failed: 422,
  no_route: 422,
  unsupported_mode: 422,
  rate_limited: 429,
  internal_error: 500,
  provider_unavailable: 503,
  service_unavailable: 503,
};

/**
 * Whether retrying the identical request could plausibly succeed.
 *
 * A caller should back off rather than loop: the three transient codes are
 * properties of the moment, everything else is a property of the request itself
 * and will fail again the same way.
 */
export const API_ERROR_RETRYABLE: Readonly<Record<ApiErrorCode, boolean>> = {
  bad_request: false,
  unauthorized: false,
  forbidden: false,
  not_found: false,
  method_not_allowed: false,
  conflict: false,
  payload_too_large: false,
  validation_failed: false,
  no_route: false,
  unsupported_mode: false,
  rate_limited: true,
  internal_error: false,
  provider_unavailable: true,
  service_unavailable: true,
};

/** Narrows an unknown string to an {@link ApiErrorCode}. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}
