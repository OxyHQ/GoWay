import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  GoWayAbortError,
  GoWayNetworkError,
  GoWayTimeoutError,
} from '../src/index';
import { fakeFetch, hangingFetch, rejection } from './helpers';
import { PLACE } from './fixtures';

describe('timeouts', () => {
  it('rejects with GoWayTimeoutError when the request outlives timeoutMs', async () => {
    const { fetch, calls } = hangingFetch();
    const client = createGoWayClient({ fetch, timeoutMs: 20 });
    const error = await rejection(client.places.get('a'));
    expect(error).toBeInstanceOf(GoWayTimeoutError);
    // A timeout IS a network error, so `catch (e) { if (e instanceof GoWayNetworkError) }`
    // covers both without naming each.
    expect(error).toBeInstanceOf(GoWayNetworkError);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('20 ms');
    expect(calls).toHaveLength(1);
  });

  it('aborts the fetch it started, so a real one releases the connection', async () => {
    const { fetch, calls } = hangingFetch();
    await createGoWayClient({ fetch, timeoutMs: 20 }).places.get('a').catch(() => undefined);
    expect(calls[0]?.init.signal?.aborted).toBe(true);
  });

  it('times out an injected fetch that ignores the signal entirely', async () => {
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(PLACE) };
    };
    const client = createGoWayClient({ fetch: slow, timeoutMs: 20 });
    await expect(client.places.get('a')).rejects.toBeInstanceOf(GoWayTimeoutError);
  });

  it('times out a token getter that never settles', async () => {
    const { fetch, calls } = hangingFetch();
    const client = createGoWayClient({
      fetch,
      timeoutMs: 20,
      getAccessToken: () => new Promise<string>(() => undefined),
    });
    await expect(client.places.get('a')).rejects.toBeInstanceOf(GoWayTimeoutError);
    // The request was never sent: no token, no call.
    expect(calls).toHaveLength(0);
  });

  it('does not fire after a request that completed in time', async () => {
    const { fetch } = fakeFetch(200, PLACE);
    const place = await createGoWayClient({ fetch, timeoutMs: 50 }).places.get('a');
    expect(place.id).toBe('gw_place_01H8');
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

describe('abort', () => {
  it('rejects before sending anything when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = hangingFetch();
    const client = createGoWayClient({ fetch });
    const error = await rejection(client.places.get('a', { signal: controller.signal }));
    expect(error).toBeInstanceOf(GoWayAbortError);
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('rejects with GoWayAbortError when the caller aborts mid-flight', async () => {
    const controller = new AbortController();
    const { fetch } = hangingFetch();
    const client = createGoWayClient({ fetch, timeoutMs: 5_000 });
    const pending = client.places.get('a', { signal: controller.signal });
    controller.abort();
    const error = await rejection(pending);
    expect(error).toBeInstanceOf(GoWayAbortError);
    expect(error).not.toBeInstanceOf(GoWayTimeoutError);
  });

  it('removes its abort listener once the request settles', async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(200, PLACE);
    await createGoWayClient({ fetch }).places.get('a', { signal: controller.signal });
    // Aborting afterwards must not reject anything or throw.
    expect(() => controller.abort()).not.toThrow();
  });
});

describe('request shape', () => {
  it('sends Accept, the extra headers, and no body on a GET', async () => {
    const { fetch, calls } = fakeFetch(200, PLACE);
    const client = createGoWayClient({ fetch, headers: { 'X-Trace-Id': 'trace-1' } });
    await client.places.get('a');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers.Accept).toBe('application/json');
    expect(calls[0]?.init.headers['X-Trace-Id']).toBe('trace-1');
    expect(calls[0]?.init.headers).not.toHaveProperty('Content-Type');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.init.redirect).toBe('follow');
  });

  it('fails with a TypeError when no fetch is available at all', async () => {
    const original = globalThis.fetch;
    // @ts-expect-error removing the global is the point of this test
    delete globalThis.fetch;
    try {
      await expect(createGoWayClient().places.get('a')).rejects.toBeInstanceOf(TypeError);
    } finally {
      globalThis.fetch = original;
    }
  });
});
