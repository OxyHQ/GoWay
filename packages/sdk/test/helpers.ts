import type { GoWayError } from '../src/errors';
import type { GoWayFetch, GoWayFetchInit, GoWayFetchResponse } from '../src/runtime';

/** One call the SDK made to the injected `fetch`. */
export interface RecordedCall {
  url: string;
  init: GoWayFetchInit;
}

function response(status: number, body: unknown, headers: Record<string, string>): GoWayFetchResponse {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** A `fetch` double that answers every call the same way and records them all. */
export function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: GoWayFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: GoWayFetch = async (url, init) => {
    calls.push({ url, init });
    return response(status, body, headers);
  };
  return { fetch, calls };
}

/** A `fetch` double that never settles — for timeout and abort tests. */
export function hangingFetch(): { fetch: GoWayFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: GoWayFetch = (url, init) => {
    calls.push({ url, init });
    return new Promise<GoWayFetchResponse>(() => undefined);
  };
  return { fetch, calls };
}

/** A `fetch` double that rejects, as a real one does when the network is down. */
export function failingFetch(reason: unknown): GoWayFetch {
  return async () => {
    throw reason;
  };
}

/** The query string of a recorded URL, or `''`. */
export function queryOf(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? '' : url.slice(index + 1);
}

/**
 * The error a call rejected with, typed as one.
 *
 * `promise.catch((e) => e)` would widen to `Success | GoWayError` and make
 * every assertion about the error a type error, so the rejection is unwrapped
 * here instead — and a call that unexpectedly SUCCEEDS fails loudly rather
 * than silently asserting nothing.
 */
export async function rejection(promise: Promise<unknown>): Promise<GoWayError> {
  try {
    await promise;
  } catch (error) {
    return error as GoWayError;
  }
  throw new Error('expected the call to reject, but it resolved');
}
