import { GOWAY_API_BASE_PATH, isApiErrorCode } from './contract';
import {
  apiError,
  GoWayAbortError,
  GoWayApiError,
  GoWayError,
  GoWayForbiddenError,
  GoWayNetworkError,
  GoWayRateLimitError,
  GoWayResponseError,
  GoWayTimeoutError,
  GoWayUnauthorizedError,
  GoWayUnavailableError,
  GoWayValidationError,
} from './errors';
import { ParseFailure } from './parse';
import {
  createAbortController,
  globalFetch,
  startTimer,
  stopTimer,
  type GoWayAbortSignal,
  type GoWayFetch,
  type GoWayFetchInit,
  type GoWayFetchResponse,
  type GoWayHeadersLike,
  type GoWayHttpMethod,
} from './runtime';

/**
 * Supplies the caller's Oxy access token.
 *
 * Called before EVERY request and never cached, stored or logged by the SDK.
 * The host app's Oxy auth package owns the session and its refresh; a copy kept
 * here would go stale exactly when it mattered, and a token held in SDK state
 * would outlive the sign-out that was supposed to end it.
 */
export type GoWayAccessTokenGetter = () =>
  | string
  | null
  | undefined
  | Promise<string | null | undefined>;

/** Everything a request needs from the client. Resolved and validated once. */
export interface TransportConfig {
  apiBaseUrl: string;
  fetch: GoWayFetch | undefined;
  getAccessToken: GoWayAccessTokenGetter | undefined;
  timeoutMs: number;
  headers: Readonly<Record<string, string>>;
}

/** A query parameter value. An array becomes one comma-joined parameter. */
export type QueryValue = string | number | boolean | readonly string[] | undefined;

/** One request, fully described. */
export interface RequestSpec {
  method: GoWayHttpMethod;
  /** Path below {@link GOWAY_API_BASE_PATH}, with every segment already encoded. */
  path: string;
  query?: Readonly<Record<string, QueryValue>>;
  /** A JSON body for a write. Never sent on a GET. */
  body?: unknown;
  signal?: GoWayAbortSignal | undefined;
}

/**
 * Serialise query parameters DETERMINISTICALLY: `undefined` omitted, keys in
 * sorted order, both halves `encodeURIComponent`-encoded, booleans as
 * `true`/`false`.
 *
 * A set-valued parameter (`capabilities`, `categories`) is sorted, de-duplicated
 * and joined with an unencoded comma. Those filters are conjunctions and
 * disjunctions respectively — their order carries no meaning — so sorting is
 * what makes two callers who ask the same question produce the same URL, and
 * an empty set is omitted rather than sent as an empty parameter (which a
 * server could read as "match nothing").
 *
 * Two calls with the same input produce byte-identical URLs, which is what lets
 * a consumer, a CDN or a tile cache key on them.
 *
 * Hand-rolled rather than `URLSearchParams`, which encodes a space as `+` and
 * is incomplete in React Native.
 */
export function serializeQuery(query: Readonly<Record<string, QueryValue>>): string {
  const parts: string[] = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const members = [...new Set(value as readonly string[])].sort();
      if (members.length === 0) continue;
      parts.push(`${encodeURIComponent(key)}=${members.map((member) => encodeURIComponent(member)).join(',')}`);
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * One path segment. `.` and `..` are refused rather than encoded: the WHATWG
 * URL parser treats `..` AND `%2e%2e` as a parent-directory segment, so a place
 * id of `..` would silently address a different route.
 */
export function pathSegment(id: string, what: string): string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new GoWayValidationError(`${what} must be a non-empty string`);
  }
  if (id === '.' || id === '..') throw new GoWayValidationError(`${what} is not a valid id`);
  return encodeURIComponent(id);
}

export function buildUrl(apiBaseUrl: string, path: string, query: Readonly<Record<string, QueryValue>>): string {
  const serialized = serializeQuery(query);
  return `${apiBaseUrl}${GOWAY_API_BASE_PATH}${path}${serialized === '' ? '' : `?${serialized}`}`;
}

/** The largest amount of server-supplied message text an error will carry. */
const MAX_SERVER_MESSAGE_LENGTH = 200;

/** A server message made safe to put in an error: a string, one line, bounded. */
function safeServerMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (flattened === '') return null;
  return flattened.length > MAX_SERVER_MESSAGE_LENGTH
    ? `${flattened.slice(0, MAX_SERVER_MESSAGE_LENGTH)}…`
    : flattened;
}

function readHeader(headers: GoWayHeadersLike | undefined, name: string): string | null {
  try {
    const value = headers?.get(name);
    return typeof value === 'string' ? value.trim() : null;
  } catch {
    return null;
  }
}

const DELTA_SECONDS = /^\d+$/;

/**
 * Seconds until a rate-limited caller may retry: `Retry-After` (delta-seconds
 * or HTTP-date), then `RateLimit-Reset`, then the `reset=` member of a combined
 * `RateLimit` header. `null` when none is present and parseable.
 */
export function parseRetryAfterSeconds(headers: GoWayHeadersLike | undefined, now = Date.now()): number | null {
  const retryAfter = readHeader(headers, 'retry-after');
  if (retryAfter) {
    if (DELTA_SECONDS.test(retryAfter)) return Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  }
  const reset = readHeader(headers, 'ratelimit-reset');
  if (reset && DELTA_SECONDS.test(reset)) return Number(reset);
  const combined = readHeader(headers, 'ratelimit');
  const member = combined ? /(?:^|[;,\s])reset=(\d+)/i.exec(combined) : null;
  return member?.[1] !== undefined ? Number(member[1]) : null;
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The typed error for a non-2xx response.
 *
 * GoWay's own error code decides the class whenever the body is a real
 * {@link ApiErrorBody}; the whole point of defining the vocabulary once in
 * `packages/shared-types` is that this mapping is total and mechanical.
 *
 * The status is only a FALLBACK, for a response GoWay did not write — and a 404
 * without a GoWay error body is deliberately a {@link GoWayApiError}, never
 * `NotFound`. A misrouted proxy or a paused deployment answers 404 for
 * everything, and a consumer told "this place does not exist" may drop a
 * persisted GoWay Place ID on the strength of it. Only GoWay can say that.
 */
export function errorForResponse(
  status: number,
  headers: GoWayHeadersLike | undefined,
  body: unknown,
): GoWayError {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const details = isRecord(envelope?.details) ? Object.freeze({ ...envelope.details }) : null;
  const serverMessage = safeServerMessage(envelope?.message);
  const message = serverMessage
    ? `GoWay API error (HTTP ${status}): ${serverMessage}`
    : `GoWay API responded with HTTP ${status}`;

  if (envelope !== undefined && isApiErrorCode(envelope.code)) {
    const retryAfterSeconds =
      typeof details?.retryAfterSeconds === 'number' && Number.isFinite(details.retryAfterSeconds)
        ? details.retryAfterSeconds
        : parseRetryAfterSeconds(headers);
    return apiError(envelope.code, message, { status, details, retryAfterSeconds });
  }

  if (status === 400 || status === 422) return new GoWayValidationError(message, { status, code: 'bad_request' });
  if (status === 401) return new GoWayUnauthorizedError(message, { status });
  if (status === 403) return new GoWayForbiddenError(message, { status });
  if (status === 429) {
    return new GoWayRateLimitError(message, { status, retryAfterSeconds: parseRetryAfterSeconds(headers) });
  }
  if (status === 404 || status === 410) {
    return new GoWayApiError(`GoWay API responded with HTTP ${status} without a GoWay error body`, { status });
  }
  if (status === 408) return new GoWayApiError(message, { status, retryable: true });
  if (status >= 500 && status !== 501 && status !== 505) return new GoWayUnavailableError(message, { status });
  return new GoWayApiError(message, { status });
}

/**
 * Turn a completed response into data, or into the typed error it represents.
 *
 * A 2xx body IS the contract value — GoWay wraps success in no envelope, so
 * there is no second place for a response to say "actually this failed". Only
 * non-2xx bodies carry {@link ApiErrorBody}.
 */
export function interpretResponse<T>(
  response: { status: number; headers: GoWayHeadersLike | undefined; text: string },
  parse: (data: unknown, path: string) => T,
): T {
  const { status, headers, text } = response;
  const body = parseJson(text);

  if (status < 200 || status >= 300) throw errorForResponse(status, headers, body);

  if (body === undefined) {
    throw new GoWayResponseError(`GoWay returned HTTP ${status} with an empty or unparseable body`, { status });
  }
  try {
    return parse(body, 'response');
  } catch (error) {
    if (error instanceof ParseFailure) {
      throw new GoWayResponseError(`GoWay returned a malformed response: ${error.message}`, {
        status,
        cause: error,
      });
    }
    throw error;
  }
}

type Cancellation = 'aborted' | 'timeout';

/**
 * Perform one request and parse it.
 *
 * Cancellation is enforced HERE, not delegated to `fetch`: every await — the
 * token getter, the request, the body — is raced against the caller's signal
 * and the timeout, so an injected `fetch` that ignores `signal` still cannot
 * outlive either. The signal is also passed to `fetch` so a real one releases
 * the connection.
 */
export async function request<T>(
  config: TransportConfig,
  spec: RequestSpec,
  parse: (data: unknown, path: string) => T,
): Promise<T> {
  const { signal } = spec;
  if (signal?.aborted) throw new GoWayAbortError('The request was aborted before it was sent');

  const fetchImpl = config.fetch ?? globalFetch();
  if (!fetchImpl) {
    throw new TypeError('No fetch implementation is available; pass `fetch` to createGoWayClient');
  }
  const url = buildUrl(config.apiBaseUrl, spec.path, spec.query ?? {});

  const controller = createAbortController();
  let cancellation: Cancellation | undefined;
  let rejectCancelled: (reason: unknown) => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  // The race below observes this promise; this handler only stops an
  // unobserved rejection from being reported when nothing is awaiting.
  cancelled.catch(() => undefined);

  const cancel = (reason: Cancellation) => {
    if (cancellation !== undefined) return;
    cancellation = reason;
    controller?.abort();
    rejectCancelled(cancellationError(reason, config.timeoutMs));
  };
  const onAbort = () => cancel('aborted');
  signal?.addEventListener('abort', onAbort);
  const timer = startTimer(() => cancel('timeout'), config.timeoutMs);

  const race = <V>(step: Promise<V>): Promise<V> => Promise.race([step, cancelled]);

  try {
    const headers: Record<string, string> = { ...config.headers, Accept: 'application/json' };
    // The token is fetched per request and lives only in this local: it is
    // never written to the client, to a module variable, or to a log line.
    if (config.getAccessToken) {
      const getter = config.getAccessToken;
      const token = await race(Promise.resolve().then(() => getter()));
      if (token !== null && token !== undefined && typeof token !== 'string') {
        throw new TypeError('getAccessToken must return a string, null or undefined');
      }
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const init: GoWayFetchInit = {
      method: spec.method,
      headers,
      credentials: 'omit',
      redirect: 'follow',
      ...(controller ? { signal: controller.signal } : {}),
    };
    if (spec.method !== 'GET' && spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(spec.body);
    }

    let response: GoWayFetchResponse;
    try {
      response = await race(fetchImpl(url, init));
    } catch (error) {
      if (cancellation !== undefined) throw cancellationError(cancellation, config.timeoutMs);
      throw new GoWayNetworkError('The request to GoWay could not be completed', { cause: error });
    }

    let text: string;
    try {
      text = await race(response.text());
    } catch (error) {
      if (cancellation !== undefined) throw cancellationError(cancellation, config.timeoutMs);
      throw new GoWayNetworkError('The response from GoWay could not be read', {
        status: response.status,
        cause: error,
      });
    }

    return interpretResponse({ status: response.status, headers: response.headers, text }, parse);
  } catch (error) {
    // A cancellation that lands while the token getter is pending surfaces as
    // the race's own rejection; normalise so the caller always sees one class.
    if (cancellation !== undefined && !(error instanceof GoWayError)) {
      throw cancellationError(cancellation, config.timeoutMs);
    }
    throw error;
  } finally {
    stopTimer(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function cancellationError(reason: Cancellation, timeoutMs: number): GoWayError {
  return reason === 'timeout'
    ? new GoWayTimeoutError(`The request to GoWay timed out after ${timeoutMs} ms`)
    : new GoWayAbortError('The request was aborted');
}
