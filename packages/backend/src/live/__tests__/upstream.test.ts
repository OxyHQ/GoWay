/**
 * What GoWay reads from a feed is bounded by what it decides, not by what the
 * feed sends: a body is counted DECOMPRESSED as it arrives and refused at the
 * cap (an endless stream or a gzip bomb costs the cap, not itself); a key
 * never follows a redirect to another host; a feed's records are capped; and
 * `Retry-After` is honoured in both its forms.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { getBytes, retryAfterSeconds } from '../normalise';
import { decodeGtfsRealtime, MAX_FEED_RECORDS, protobufWriter as w } from '../protobuf';
import type { LiveFetch } from '../types';

const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

const realFetch = globalThis.fetch as unknown as LiveFetch;
const signal = () => AbortSignal.timeout(10_000);

describe('a body is counted as it arrives', () => {
  it('refuses an endless stream at the cap instead of waiting for its end', async () => {
    const chunk = new Uint8Array(64 * 1024);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
          }),
        ),
    });
    servers.push(server);
    const started = Date.now();
    await expect(
      getBytes(realFetch, `http://127.0.0.1:${server.port}/`, signal(), {}, 1024 * 1024),
    ).rejects.toThrow(/too large/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('counts a gzip bomb in decompressed bytes, and stops near the cap', async () => {
    // 64 MB of zeros is ~64 KB on the wire: its content-length says nothing.
    const bomb = gzipSync(new Uint8Array(64 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(bomb, { headers: { 'content-encoding': 'gzip' } }),
    });
    servers.push(server);
    const cap = 1024 * 1024;
    const error = await getBytes(
      realFetch,
      `http://127.0.0.1:${server.port}/`,
      signal(),
      {},
      cap,
    ).then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error?.message).toMatch(/too large/);
    const read = Number(/(\d+) read/.exec(error?.message ?? '')?.[1]);
    expect(read).toBeGreaterThan(cap);
    expect(read).toBeLessThan(4 * cap);
  });
});

describe('redirects', () => {
  const record = () => {
    const seen: Record<string, string>[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push(Object.fromEntries(request.headers.entries()));
        return new Response('ok');
      },
    });
    servers.push(server);
    return { seen, origin: `http://127.0.0.1:${server.port}` };
  };

  it('drop a key for another host, keep it for the same one, and never trade https for http', async () => {
    const target = record();
    const redirector = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/away') return Response.redirect(`${target.origin}/feed`, 302);
        if (path === '/here') return Response.redirect('/landed', 302);
        return new Response(request.headers.get('x-api-key') ?? 'none');
      },
    });
    servers.push(redirector);
    const headers = { 'user-agent': 'GoWay-Live/1.0', 'x-api-key': 'secret' };
    const base = `http://127.0.0.1:${redirector.port}`;
    await getBytes(realFetch, `${base}/away`, signal(), headers);
    expect(target.seen[0]?.['x-api-key']).toBeUndefined();
    expect(target.seen[0]?.['user-agent']).toBe('GoWay-Live/1.0');
    const same = await getBytes(realFetch, `${base}/here`, signal(), headers);
    expect(new TextDecoder().decode(same)).toBe('secret');

    const downgrade: LiveFetch = async () => ({
      status: 302,
      headers: { get: (name) => (name === 'location' ? 'http://elsewhere.example/feed' : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      getBytes(downgrade, 'https://feeds.example/vp.pb', signal(), headers),
    ).rejects.toThrow(/https to http/);
  });
});

describe('Retry-After', () => {
  it('reads seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-15T07:00:00Z');
    expect(retryAfterSeconds('120', now)).toBe(120);
    expect(retryAfterSeconds('Thu, 15 Oct 2026 07:02:30 GMT', now)).toBe(150);
    expect(retryAfterSeconds('Thu, 15 Oct 2026 06:00:00 GMT', now)).toBeNull();
    expect(retryAfterSeconds('soon', now)).toBeNull();
    expect(retryAfterSeconds(null, now)).toBeNull();
  });
});

describe('a feed is capped in records', () => {
  it('refuses a feed of more entities than any real one', () => {
    const header = w.bytes(1, [...w.string(1, '2.0'), ...w.uint(3, 1)]);
    // The smallest entity: an id. Repeated past the cap.
    const entity = w.bytes(2, w.string(1, 'e'));
    const count = MAX_FEED_RECORDS + 1;
    const bytes = new Uint8Array(header.length + entity.length * count);
    bytes.set(header, 0);
    for (let i = 0; i < count; i++) bytes.set(entity, header.length + i * entity.length);
    expect(() => decodeGtfsRealtime(bytes)).toThrow(/more than/);
    expect(() =>
      decodeGtfsRealtime(bytes.subarray(0, header.length + entity.length * 10)),
    ).not.toThrow();
  });
});
