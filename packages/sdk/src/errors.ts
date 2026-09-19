import { API_ERROR_RETRYABLE } from './contract';
import type { ApiErrorCode } from './contract';

/**
 * Every code a {@link GoWayError} can carry.
 *
 * The API's stable codes ({@link ApiErrorCode}, defined once in
 * `packages/shared-types`) pass through unchanged when a response names one.
 * The rest describe failures the API never got to report: the request never
 * completed, the caller cancelled it, the body was not the contract, or the
 * status carried no GoWay error body.
 */
export type GoWayErrorCode =
  | ApiErrorCode
  | 'network_error'
  | 'timeout'
  | 'aborted'
  | 'malformed_response'
  | 'http_error';

/** Options every error constructor accepts. All optional; each class has defaults. */
export interface GoWayErrorOptions {
  /** HTTP status, or `null` when no response was received. */
  status?: number | null;
  code?: GoWayErrorCode;
  retryable?: boolean;
  /** The `error.details` member of the API's error body, when it sent one. */
  details?: Readonly<Record<string, unknown>> | null;
  cause?: unknown;
}

/** `options` with every property it leaves `undefined` taken from `defaults`. */
function withDefaults<T extends GoWayErrorOptions>(options: T, defaults: GoWayErrorOptions): T {
  const merged: GoWayErrorOptions = { ...defaults };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged as T;
}

/**
 * A brand every SDK error carries: the names of its class and each ancestor.
 *
 * `instanceof` compares class IDENTITY, and a process can hold two copies of
 * this package — the ESM and the CommonJS build side by side (a CommonJS
 * dependency of an ESM app), or two versions. An error thrown by one copy is
 * then not `instanceof` the other copy's class, and a consumer's
 * `if (err instanceof GoWayNotFoundError)` silently takes the wrong branch. Each
 * class therefore answers `instanceof` from this brand as well as from its
 * prototype chain. `Symbol.for` is what makes the key shared across copies.
 */
const LINEAGE: unique symbol = Symbol.for('@goway.to/sdk:error-lineage') as never;

type Branded = { [LINEAGE]?: readonly string[] };

function lineageOf(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const lineage = (value as Branded)[LINEAGE];
  return Array.isArray(lineage) ? lineage : undefined;
}

/** The base of every error the SDK throws. */
export class GoWayError extends Error {
  /** The stable class name used for cross-copy `instanceof`. Never minified. */
  static readonly errorName: string = 'GoWayError';

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return lineageOf(value)?.includes(this.errorName) ?? false;
  }

  /** A stable, machine-readable code. Branch on this or on the class, never on `message`. */
  readonly code: GoWayErrorCode;
  /** The HTTP status, or `null` when no response was received (or the error is client-side). */
  readonly status: number | null;
  /**
   * Whether repeating the SAME request later may succeed. For an API error this
   * is `API_ERROR_RETRYABLE[code]`, the API's own answer, not the SDK's guess.
   * The SDK never retries by itself; this tells a caller whether a retry with
   * backoff is sensible.
   */
  readonly retryable: boolean;
  /** Structured, code-specific context from the API's error body, or `null`. */
  readonly details: Readonly<Record<string, unknown>> | null;
  declare readonly cause?: unknown;

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message);
    const target = new.target as typeof GoWayError;
    Object.setPrototypeOf(this, target.prototype);

    const lineage: string[] = [];
    let current: typeof GoWayError | null = target;
    while (current !== null) {
      if (Object.prototype.hasOwnProperty.call(current, 'errorName')) lineage.push(current.errorName);
      if (current === GoWayError) break;
      current = Object.getPrototypeOf(current) as typeof GoWayError | null;
    }
    Object.defineProperty(this, LINEAGE, { value: Object.freeze(lineage), enumerable: false });
    Object.defineProperty(this, 'name', {
      value: target.errorName,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    // Non-enumerable, so serialising an error never walks into whatever a
    // `fetch` implementation attached to its own failure.
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false, configurable: true });
    }

    this.code = options.code ?? 'http_error';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
  }

  /** A safe, loggable shape: no cause, no stack, no request data, no token. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      retryable: this.retryable,
      message: this.message,
      ...(this.details === null ? {} : { details: this.details }),
    };
  }
}

/** The request did not complete: DNS, TLS, connection reset, offline. Retryable. */
export class GoWayNetworkError extends GoWayError {
  static override readonly errorName: string = 'GoWayNetworkError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'network_error', retryable: true }));
  }
}

/** The request exceeded the client's `timeoutMs`. A network error; retryable. */
export class GoWayTimeoutError extends GoWayNetworkError {
  static override readonly errorName: string = 'GoWayTimeoutError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'timeout' }));
  }
}

/** The caller aborted the request through its own `AbortSignal`. Not retryable. */
export class GoWayAbortError extends GoWayError {
  static override readonly errorName: string = 'GoWayAbortError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'aborted', retryable: false }));
  }
}

/** A non-2xx response the SDK has no more specific class for. */
export class GoWayApiError extends GoWayError {
  static override readonly errorName: string = 'GoWayApiError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'http_error' }));
  }
}

/**
 * The input was refused: by the API (`bad_request`, `validation_failed`), or by
 * the SDK before any request was sent (`status: null`) — an empty place id, a
 * latitude outside ±90, a `radiusMeters` that is not a positive number.
 */
export class GoWayValidationError extends GoWayError {
  static override readonly errorName: string = 'GoWayValidationError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'validation_failed' }));
  }
}

/** 401: the access token was missing where required, expired or invalid. */
export class GoWayUnauthorizedError extends GoWayError {
  static override readonly errorName: string = 'GoWayUnauthorizedError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'unauthorized' }));
  }
}

/** 403: the caller is authenticated but not allowed (an unapproved place claim, say). */
export class GoWayForbiddenError extends GoWayError {
  static override readonly errorName: string = 'GoWayForbiddenError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'forbidden' }));
  }
}

/**
 * 404: GoWay has no such place — or the caller may not see it. Only raised when
 * the response is a genuine GoWay error body: a bare 404 from a proxy proves
 * nothing about the resource, and a consumer told "this place no longer exists"
 * may drop a persisted GoWay Place ID on the strength of it.
 */
export class GoWayNotFoundError extends GoWayError {
  static override readonly errorName: string = 'GoWayNotFoundError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'not_found' }));
  }
}

/** 409: the write conflicts with current state — a duplicate claim, a stale update. */
export class GoWayConflictError extends GoWayError {
  static override readonly errorName: string = 'GoWayConflictError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'conflict' }));
  }
}

/**
 * No route exists between the requested points.
 *
 * A NORMAL answer for this domain, not a defect: two points separated by an
 * ocean have no driving route and never will. Render "no route found", never
 * "something went wrong", and do not retry — `retryable` is `false`. It extends
 * {@link GoWayApiError} rather than {@link GoWayValidationError} on purpose:
 * the request was perfectly valid.
 *
 * The same answer can also arrive as a 200 with an empty `routes` array; handle
 * both.
 */
export class GoWayNoRouteError extends GoWayApiError {
  static override readonly errorName: string = 'GoWayNoRouteError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'no_route' }));
  }
}

/**
 * The requested {@link TravelMode} is not supported by the active routing
 * provider here.
 *
 * Also a normal domain answer: it is a statement about coverage, not about the
 * caller's request being wrong. Offer the user another mode.
 */
export class GoWayUnsupportedModeError extends GoWayApiError {
  static override readonly errorName: string = 'GoWayUnsupportedModeError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'unsupported_mode' }));
  }
}

/** Options {@link GoWayRateLimitError} additionally accepts. */
export interface GoWayRateLimitErrorOptions extends GoWayErrorOptions {
  retryAfterSeconds?: number | null;
}

/** 429: too many requests. Retryable, after `retryAfterSeconds` when GoWay said. */
export class GoWayRateLimitError extends GoWayError {
  static override readonly errorName: string = 'GoWayRateLimitError';

  /** Seconds to wait before retrying, from `error.details` or `Retry-After`, or `null`. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, options: GoWayRateLimitErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'rate_limited', retryable: true }));
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterSeconds: this.retryAfterSeconds };
  }
}

/**
 * GoWay is temporarily unable to answer: an upstream geographic provider failed
 * or timed out (`provider_unavailable`, 503), or GoWay itself hit a defect
 * (`internal_error`, 500). Render "temporarily unavailable" — this is never
 * evidence about the place, route or query itself.
 */
export class GoWayUnavailableError extends GoWayError {
  static override readonly errorName: string = 'GoWayUnavailableError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'provider_unavailable', retryable: true }));
  }
}

/**
 * The response was not the contract: invalid JSON, a missing or mistyped field,
 * a value outside a closed set, or a coordinate that is not a coordinate.
 * `status` is the HTTP status that came with it.
 */
export class GoWayResponseError extends GoWayError {
  static override readonly errorName: string = 'GoWayResponseError';

  constructor(message: string, options: GoWayErrorOptions = {}) {
    super(message, withDefaults(options, { code: 'malformed_response', retryable: false }));
  }
}

/** Whether `value` is an error thrown by (any copy of) this SDK. */
export function isGoWayError(value: unknown): value is GoWayError {
  return value instanceof GoWayError;
}

/**
 * The class each API error code becomes.
 *
 * Typed as a TOTAL `Record<ApiErrorCode, …>`: adding a code to
 * `packages/shared-types` without giving it a class here fails to compile, so
 * the SDK cannot quietly degrade a new, meaningful code into a generic
 * `GoWayApiError` the way a `switch` with a `default` would.
 */
type ApiErrorConstructor = new (message: string, options: GoWayRateLimitErrorOptions) => GoWayError;

const API_ERROR_CLASS: Readonly<Record<ApiErrorCode, ApiErrorConstructor>> = {
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
  // Both are defects in the CALLER rather than in the request's values, and
  // neither is worth its own class: a consumer of a typed SDK cannot reach
  // `method_not_allowed` without the SDK itself having built the wrong request,
  // and `payload_too_large` is a bad argument by another name.
  method_not_allowed: GoWayValidationError,
  payload_too_large: GoWayValidationError,
};

/**
 * Build the typed error for an API error code.
 *
 * `retryable` comes from `API_ERROR_RETRYABLE`, never from the class default:
 * `internal_error` and `provider_unavailable` share a class but not an answer
 * to "should I retry this?".
 */
export function apiError(
  code: ApiErrorCode,
  message: string,
  options: GoWayRateLimitErrorOptions = {},
): GoWayError {
  const Constructor = API_ERROR_CLASS[code];
  return new Constructor(message, { ...options, code, retryable: API_ERROR_RETRYABLE[code] });
}
