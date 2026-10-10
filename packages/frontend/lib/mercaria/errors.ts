/**
 * What a failed Mercaria read means for the place sheet.
 *
 * `@mercaria.co/sdk` throws a different class for each outcome, and only three
 * of them change what "Products at this store" draws:
 *
 *  - **gone** (410) — the location was withdrawn, restricted, closed with its
 *    store, or its place stopped naming it. Mercaria said so; stop showing it.
 *  - **notFound** (404) — never public. Hidden the same way.
 *  - **unavailable** — Mercaria, or GoWay behind it, could not answer right
 *    now (503, 5xx, offline, a timeout, a rate limit). NOT a reason to hide
 *    for good: a 503 here usually means Mercaria could not ask GoWay whether
 *    the place still names the location, and the honest answer is "try again".
 *
 * Everything else — a malformed response, a route this SDK and the server
 * disagree on, a 404 without Mercaria's error body (a proxy, which proves
 * nothing) — is `unknown`, and the section hides: this app renders only what
 * Mercaria confirmed.
 */
import {
  MercariaAbortError,
  MercariaGoneError,
  MercariaNetworkError,
  MercariaNotFoundError,
  MercariaRateLimitError,
  MercariaUnavailableError,
} from '@mercaria.co/sdk';

export type MercariaFailureKind = 'gone' | 'notFound' | 'unavailable' | 'aborted' | 'unknown';

export interface MercariaFailure {
  kind: MercariaFailureKind;
  /** Whether repeating the identical request could plausibly succeed. */
  retryable: boolean;
}

/** `MercariaTimeoutError` extends `MercariaNetworkError`, so both read as unavailable. */
export function classifyMercariaError(error: unknown): MercariaFailure {
  if (error instanceof MercariaAbortError) return { kind: 'aborted', retryable: false };
  if (error instanceof MercariaGoneError) return { kind: 'gone', retryable: false };
  if (error instanceof MercariaNotFoundError) return { kind: 'notFound', retryable: false };
  if (
    error instanceof MercariaUnavailableError ||
    error instanceof MercariaNetworkError ||
    error instanceof MercariaRateLimitError
  ) {
    return { kind: 'unavailable', retryable: true };
  }
  return { kind: 'unknown', retryable: false };
}

/** Whether React Query should try this error again. `Error`, not `unknown`: see `shouldRetryGoWay`. */
export function shouldRetryMercaria(failureCount: number, error: Error): boolean {
  return failureCount < 2 && classifyMercariaError(error).retryable;
}

/**
 * What one Mercaria read puts on screen.
 *
 * `hidden` for anything Mercaria did not confirm — an empty page, gone, not
 * found, an unknown failure; `retry` only when another attempt could change
 * the answer.
 */
export type MercariaReadState = 'loading' | 'retry' | 'hidden' | 'ready';

export function mercariaReadState(read: {
  status: 'pending' | 'error' | 'success';
  error: Error | null;
  empty: boolean;
}): MercariaReadState {
  if (read.status === 'pending') return 'loading';
  if (read.status === 'error')
    return classifyMercariaError(read.error).kind === 'unavailable' ? 'retry' : 'hidden';
  return read.empty ? 'hidden' : 'ready';
}
