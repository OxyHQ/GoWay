/**
 * The bounded upstream request.
 *
 * Every rule here exists because its absence is invisible until it is
 * expensive: a retry on a 429 turns a fair-use allowance into a ban, an
 * unbounded wait turns a search box into a spinner, and a 500 for an upstream
 * outage tells an integrator that GoWay broke and that retrying is pointless.
 */

import { describe, expect, it } from 'bun:test';
import { fetchUpstreamJson, isUpstreamError, parseRetryAfterSeconds, UpstreamError } from '../upstream';
import type { FetchLike } from '../provider';
import { jsonResponse, recordingFetch } from './fixtures';

const BASE = { provider: 'photon' as const, url: 'https://photon.example/api?q=a', timeoutMs: 50, attempts: 1 };

/** The `UpstreamError` a call threw, or a failure if it threw something else. */
async function failureOf(request: Parameters<typeof fetchUpstreamJson>[0]): Promise<UpstreamError> {
  try {
    await fetchUpstreamJson(request);
  } catch (error) {
    if (isUpstreamError(error)) return error;
    throw error;
  }
  throw new Error('the request was expected to fail');
}

describe('fetchUpstreamJson', () => {
  it('returns the parsed body on success', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ ok: true }));
    await expect(fetchUpstreamJson({ ...BASE, fetch })).resolves.toEqual({ ok: true });
  });

  it('maps a 429 to rate_limited and carries Retry-After through', async () => {
    const { fetch, urls } = recordingFetch(() =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    );
    // Three attempts CONFIGURED, one attempt made: retrying a rate limit is how
    // a fair-use allowance becomes a block.
    const failure = await failureOf({ ...BASE, fetch, attempts: 3 });

    expect(failure.kind).toBe('rate_limited');
    expect(failure.retryAfterSeconds).toBe(30);
    expect(urls).toHaveLength(1);

    const apiError = failure.toApiError();
    expect(apiError.code).toBe('rate_limited');
    expect(apiError.status).toBe(429);
    expect(apiError.details).toMatchObject({ provider: 'photon', retryAfterSeconds: 30 });
  });

  it('maps an upstream 5xx to provider_unavailable and retries it within the bound', async () => {
    const { fetch, urls } = recordingFetch(() => new Response('', { status: 503 }));
    const failure = await failureOf({ ...BASE, fetch, attempts: 2 });

    expect(failure.kind).toBe('http_error');
    expect(urls).toHaveLength(2);

    const apiError = failure.toApiError();
    // 503 provider_unavailable, never 500: the map data source is down, which
    // is a different thing to tell a user than "GoWay is broken".
    expect(apiError.code).toBe('provider_unavailable');
    expect(apiError.status).toBe(503);
    expect(apiError.details).toMatchObject({ provider: 'photon', reason: 'http_error', status: 503 });
  });

  it('does not retry an upstream 4xx', async () => {
    const { fetch, urls } = recordingFetch(() => new Response('', { status: 400 }));
    const failure = await failureOf({ ...BASE, fetch, attempts: 3 });
    expect(failure.kind).toBe('http_error');
    expect(urls).toHaveLength(1);
  });

  it('aborts on its own timeout and reports it as a provider failure', async () => {
    let aborted = false;
    // A server that accepts the connection and never answers — the failure a
    // timeout exists for, and the one no status code describes.
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('The operation was aborted'));
        });
      });

    const failure = await failureOf({ ...BASE, fetch, timeoutMs: 5 });
    expect(failure.kind).toBe('timeout');
    expect(aborted).toBe(true);
    expect(failure.toApiError().code).toBe('provider_unavailable');
  });

  it('does not retry a timeout, which has already spent the latency budget', async () => {
    const calls: number[] = [];
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls.push(1);
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    await failureOf({ ...BASE, fetch, timeoutMs: 5, attempts: 3 });
    expect(calls).toHaveLength(1);
  });

  it('distinguishes the caller hanging up from an upstream failure', async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        controller.abort();
      });

    const failure = await failureOf({ ...BASE, fetch, timeoutMs: 1_000, signal: controller.signal });
    expect(failure.kind).toBe('aborted');
  });

  it('retries a transport fault and succeeds on the second attempt', async () => {
    const { fetch, urls } = recordingFetch((_url, call) => {
      if (call === 0) throw new Error('ECONNRESET');
      return jsonResponse({ ok: true });
    });
    await expect(fetchUpstreamJson({ ...BASE, fetch, attempts: 2 })).resolves.toEqual({ ok: true });
    expect(urls).toHaveLength(2);
  });

  it('reports a 200 that is not JSON as malformed', async () => {
    const { fetch } = recordingFetch(() => new Response('<html>maintenance</html>', { status: 200 }));
    const failure = await failureOf({ ...BASE, fetch });
    expect(failure.kind).toBe('malformed');
    expect(failure.toApiError().code).toBe('provider_unavailable');
  });

  it('never puts the requested URL in the error it raises', async () => {
    const { fetch } = recordingFetch(() => new Response('', { status: 500 }));
    // The query string carries the user's search text and, on a reverse
    // lookup, their precise coordinate.
    const failure = await failureOf({ ...BASE, fetch, url: 'https://photon.example/reverse?lat=41.4&lon=2.17' });
    expect(failure.message).not.toContain('41.4');
    expect(JSON.stringify(failure.toApiError().details)).not.toContain('41.4');
  });
});

describe('parseRetryAfterSeconds', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterSeconds(new Headers({ 'retry-after': '11' }))).toBe(11);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-09-19T12:00:00Z');
    const headers = new Headers({ 'retry-after': 'Sat, 19 Sep 2026 12:00:30 GMT' });
    expect(parseRetryAfterSeconds(headers, now)).toBe(30);
  });

  it('falls back to RateLimit-Reset and clamps an absurd value', () => {
    expect(parseRetryAfterSeconds(new Headers({ 'ratelimit-reset': '5' }))).toBe(5);
    expect(parseRetryAfterSeconds(new Headers({ 'retry-after': '999999999' }))).toBe(86_400);
  });

  it('is undefined when nothing usable is present', () => {
    expect(parseRetryAfterSeconds(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(parseRetryAfterSeconds(new Headers())).toBeUndefined();
  });
});
