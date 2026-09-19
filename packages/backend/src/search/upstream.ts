/**
 * One bounded, cancellable JSON request to an upstream geocoder.
 *
 * Every provider call in this package goes through here, so the resilience
 * rules are stated once instead of per adapter:
 *
 *  - an `AbortController` PER REQUEST, aborted by a timer, so a provider that
 *    accepts a connection and never answers cannot hold a user's search open;
 *  - a bounded attempt count (`1` by default) — no configuration can express an
 *    infinite retry, and a `429` is never retried, because retrying a rate
 *    limit is how a fair-use allowance becomes a ban;
 *  - a total mapping from upstream failure to GoWay's error vocabulary, so a
 *    caller sees `provider_unavailable` (retryable, "the map data source is
 *    down") or `rate_limited` with `retryAfterSeconds`, and never a 500 that
 *    says GoWay itself broke.
 *
 * ## Nothing here logs a URL
 *
 * The query string carries the user's search text and, for a reverse lookup,
 * their precise coordinate. GoWay's privacy rule is that those are transient
 * request data, so failures are reported by provider, kind and status — the
 * three fields an operator actually pages on — and the URL is never part of an
 * error message or a log field.
 */

import type { SearchSource } from '@goway/shared-types';
import { ApiError } from '../http/apiError';
import type { FetchLike } from './provider';

/** How an upstream request failed, at the granularity the mapping needs. */
export type UpstreamFailureKind =
  /** The per-request timer fired. */
  | 'timeout'
  /** The caller hung up. */
  | 'aborted'
  /** DNS, TLS, connection reset — `fetch` itself rejected. */
  | 'network'
  /** HTTP 429. */
  | 'rate_limited'
  /** Any other non-2xx status. */
  | 'http_error'
  /** 2xx whose body was not the JSON shape the adapter expects. */
  | 'malformed';

export interface UpstreamErrorOptions {
  status?: number;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * A provider call that did not produce a usable payload.
 *
 * Carries no URL, no query text and no coordinate — see the module note. The
 * message is fixed text per kind so it is safe to log verbatim.
 */
export class UpstreamError extends Error {
  readonly provider: SearchSource;
  readonly kind: UpstreamFailureKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(provider: SearchSource, kind: UpstreamFailureKind, options: UpstreamErrorOptions = {}) {
    super(`The ${provider} geocoder request failed (${kind})`, { cause: options.cause });
    this.name = 'UpstreamError';
    this.provider = provider;
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /**
   * The failure as an API caller should see it.
   *
   * A rate limit stays a rate limit: `429` plus `retryAfterSeconds` is the one
   * failure a client can act on correctly, and flattening it into a generic
   * 503 would turn "wait eleven seconds" into "retry immediately, forever".
   * Everything else — including an upstream `400`, which means GoWay built a
   * bad URL — is `provider_unavailable`. A 500 would tell the integrator that
   * GoWay's own service broke and that retrying is pointless; neither half of
   * that is true, and the operator learns about it from the log line instead.
   */
  toApiError(): ApiError {
    if (this.kind === 'rate_limited') {
      return new ApiError('rate_limited', 'The upstream geocoder is rate limiting GoWay.', {
        provider: String(this.provider),
        ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      });
    }
    return new ApiError('provider_unavailable', 'The geocoding provider is unavailable.', {
      provider: String(this.provider),
      reason: this.kind,
      ...(this.status !== undefined ? { status: this.status } : {}),
    });
  }
}

export function isUpstreamError(error: unknown): error is UpstreamError {
  return error instanceof UpstreamError;
}

const DELTA_SECONDS = /^\d+$/;

/**
 * Seconds until a rate-limited caller may retry, from `Retry-After`
 * (delta-seconds or an HTTP-date) and then `RateLimit-Reset`.
 *
 * Clamped to a day: a header naming a date years out is far more likely a
 * misconfigured proxy than a real answer, and propagating it would park a
 * client's backoff indefinitely.
 */
const MAX_RETRY_AFTER_SECONDS = 86_400;

export function parseRetryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const candidates = [headers.get('retry-after'), headers.get('ratelimit-reset')];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (!value) continue;
    if (DELTA_SECONDS.test(value)) {
      return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS);
    }
    const date = Date.parse(value);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(0, Math.ceil((date - now) / 1000)), MAX_RETRY_AFTER_SECONDS);
    }
  }
  return undefined;
}

export interface UpstreamJsonRequest {
  provider: SearchSource;
  fetch: FetchLike;
  url: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Total attempts, retries included. `1` means no retry. */
  attempts: number;
  /** The caller's cancellation, if any. */
  signal?: AbortSignal;
}

/** Whether a second attempt could plausibly land differently. */
function isRetryable(error: UpstreamError): boolean {
  // A timeout already consumed the caller's latency budget, a 429 must not be
  // hammered, and a 4xx will be refused identically next time. What is left is
  // a transport fault or an upstream 5xx, which is what a retry is for.
  if (error.kind === 'network') return true;
  return error.kind === 'http_error' && error.status !== undefined && error.status >= 500;
}

/**
 * GET `url` and parse the body as JSON, or throw an {@link UpstreamError}.
 *
 * The returned value is `unknown`: the adapter that knows the payload validates
 * it. Handing back a typed value from here would put every provider's shape in
 * one signature, which is the coupling the provider interface exists to avoid.
 */
export async function fetchUpstreamJson(request: UpstreamJsonRequest): Promise<unknown> {
  let lastError: UpstreamError | undefined;

  for (let attempt = 1; attempt <= request.attempts; attempt += 1) {
    try {
      return await attemptUpstreamJson(request);
    } catch (error) {
      if (!isUpstreamError(error)) throw error;
      lastError = error;
      if (attempt >= request.attempts || !isRetryable(error)) throw error;
    }
  }

  // Unreachable: the loop either returns or throws. Spelled out so a future
  // edit to the bounds cannot silently fall through to `undefined`.
  throw lastError ?? new UpstreamError(request.provider, 'network');
}

async function attemptUpstreamJson(request: UpstreamJsonRequest): Promise<unknown> {
  const { provider } = request;
  const controller = new AbortController();
  // Which side aborted decides which failure the caller is told about: a timer
  // firing is `provider_unavailable`, a client hanging up is nobody's failure.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  const onCallerAbort = (): void => controller.abort();
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await request.fetch(request.url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...request.headers },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) throw new UpstreamError(provider, 'timeout', { cause });
      if (request.signal?.aborted) throw new UpstreamError(provider, 'aborted', { cause });
      throw new UpstreamError(provider, 'network', { cause });
    }

    if (response.status === 429) {
      throw new UpstreamError(provider, 'rate_limited', {
        status: response.status,
        ...(() => {
          const seconds = parseRetryAfterSeconds(response.headers);
          return seconds === undefined ? {} : { retryAfterSeconds: seconds };
        })(),
      });
    }
    if (!response.ok) {
      throw new UpstreamError(provider, 'http_error', { status: response.status });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (timedOut) throw new UpstreamError(provider, 'timeout', { cause });
      if (request.signal?.aborted) throw new UpstreamError(provider, 'aborted', { cause });
      throw new UpstreamError(provider, 'network', { cause });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new UpstreamError(provider, 'malformed', { status: response.status, cause });
    }
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }
}
