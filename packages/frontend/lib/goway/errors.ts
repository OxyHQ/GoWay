/**
 * Turning a thrown SDK error into the sentence the user should read.
 *
 * Issue #7 → Required states asks for intentional states for "search
 * unavailable", "offline/no network" and friends. The information needed to
 * tell those apart already exists — `@goway.to/sdk` throws a DIFFERENT CLASS
 * for each — so the job here is narrow: collapse the SDK's taxonomy into the
 * handful of outcomes a screen actually renders differently, once, instead of
 * at every call site with a string match on `error.message`.
 *
 * `aborted` is in the list and is NOT a failure: a superseded search cancels
 * its predecessor, and rendering "something went wrong" for the request the app
 * itself threw away is the classic debounce bug.
 */
import {
  GoWayAbortError,
  GoWayNetworkError,
  GoWayNoRouteError,
  GoWayNotFoundError,
  GoWayRateLimitError,
  GoWayResponseError,
  GoWayTimeoutError,
  GoWayUnauthorizedError,
  GoWayUnavailableError,
  GoWayUnsupportedModeError,
  isGoWayError,
} from '@goway.to/sdk';

export type GoWayFailureKind =
  /** The request never reached GoWay. The user reads this as "offline". */
  | 'offline'
  /** It reached GoWay and GoWay did not answer in time. */
  | 'timeout'
  /** GoWay, or a geographic provider behind it, is degraded. */
  | 'unavailable'
  /**
   * There is no route between these points, and there never will be — two
   * points separated by an ocean have no driving route. A NORMAL answer for
   * the directions domain, not a fault: `shared-types` says the same thing
   * twice, and it arrives in two shapes (a 200 with an empty `routes` array,
   * or `no_route`) that must render identically.
   */
  | 'noRoute'
  /**
   * GoWay does not route this travel mode HERE — a statement about coverage,
   * not about the request being wrong. It is its own kind because the only
   * useful action is "pick another mode", and a "Try again" button against it
   * is a button that cannot work.
   */
  | 'unsupportedMode'
  /** This place does not exist (GoWay said so, not a proxy). */
  | 'notFound'
  | 'rateLimited'
  /** Identity is required and absent — only reachable on a gated write. */
  | 'unauthorized'
  /** GoWay answered with something the contract does not describe. */
  | 'malformed'
  /** The app cancelled it. Render nothing. */
  | 'aborted'
  | 'unknown';

export interface GoWayFailure {
  kind: GoWayFailureKind;
  /** Whether repeating the identical request could plausibly succeed. */
  retryable: boolean;
}

/**
 * Order matters: `GoWayTimeoutError` extends `GoWayNetworkError`, so the
 * subclass must be tested first or every timeout reads as "offline". The two
 * routing-domain answers are tested before the generic classes for the same
 * reason — both extend `GoWayApiError`, which would otherwise fall through to
 * `unknown` and render "Something went wrong" for an answer that is not wrong.
 */
export function classifyGoWayError(error: unknown): GoWayFailure {
  if (error instanceof GoWayAbortError) return { kind: 'aborted', retryable: false };
  if (error instanceof GoWayNoRouteError) return { kind: 'noRoute', retryable: false };
  if (error instanceof GoWayUnsupportedModeError) return { kind: 'unsupportedMode', retryable: false };
  if (error instanceof GoWayTimeoutError) return { kind: 'timeout', retryable: true };
  if (error instanceof GoWayNetworkError) return { kind: 'offline', retryable: true };
  if (error instanceof GoWayUnavailableError) return { kind: 'unavailable', retryable: true };
  if (error instanceof GoWayRateLimitError) return { kind: 'rateLimited', retryable: true };
  if (error instanceof GoWayNotFoundError) return { kind: 'notFound', retryable: false };
  if (error instanceof GoWayUnauthorizedError) return { kind: 'unauthorized', retryable: false };
  if (error instanceof GoWayResponseError) return { kind: 'malformed', retryable: false };
  if (isGoWayError(error)) return { kind: 'unknown', retryable: error.retryable };
  return { kind: 'unknown', retryable: false };
}

/**
 * Whether React Query should try this error again.
 *
 * `error` is typed `Error` rather than `unknown` on purpose: React Query infers
 * its `TError` from this callback, and an `unknown` parameter widens every
 * consuming `UseQueryResult` to `UseQueryResult<T, unknown>` — which then fails
 * to assign to the `UseQueryResult<T>` the hooks return.
 */
export function shouldRetryGoWay(failureCount: number, error: Error): boolean {
  return failureCount < 2 && classifyGoWayError(error).retryable;
}
