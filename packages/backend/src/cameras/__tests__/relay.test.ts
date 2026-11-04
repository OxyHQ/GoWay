import { describe, expect, it } from 'bun:test';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { type SafeFetchResult, SsrfRejection } from '@oxy.so/core/server';
import {
  holdSeconds,
  MAX_SNAPSHOT_BYTES,
  SnapshotRelay,
  SnapshotUnavailableError,
  sniffImageType,
} from '../relay';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const target = {
  id: 'prov.one',
  upstreamUrl: 'https://cams.example.org/one.jpg',
  refreshSeconds: 60,
};
/** What an upstream answers, as `safeFetch` hands it over: status, headers and a body stream. */
interface Upstream {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: Uint8Array | string;
}

interface Harness {
  relay: SnapshotRelay;
  calls: string[];
  clock: { t: number };
}

/**
 * A relay whose `safeFetch` is stubbed: the SDK's resolution, pinning and
 * redirect checks are its own (tested in `@oxy.so/core`); what is tested here
 * is what the relay does with the answer. The refusal tests at the end run the
 * REAL `safeFetch`, which refuses before any connection is made.
 */
function harness(respond: (url: string) => Upstream | Promise<Upstream>): Harness {
  const calls: string[] = [];
  const clock = { t: 1_000_000 };
  const relay = new SnapshotRelay({
    safeFetch: async (url): Promise<SafeFetchResult> => {
      calls.push(url);
      const answer = await respond(url);
      const body = answer.body ?? new Uint8Array();
      return {
        response: Readable.from([Buffer.from(body)]) as unknown as IncomingMessage,
        status: answer.status ?? 200,
        headers: answer.headers ?? {},
        finalUrl: url,
      };
    },
    now: () => clock.t,
  });
  return { relay, calls, clock };
}

const jpeg = (headers: IncomingHttpHeaders = {}): Upstream => ({
  body: JPEG,
  headers: { 'content-type': 'image/jpeg', ...headers },
});

describe('sniffImageType', () => {
  it('reads the type from the bytes, and refuses anything else', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(sniffImageType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<html><script>'))).toBeNull();
    expect(
      sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('holdSeconds', () => {
  it('is half the camera refresh, floored and capped', () => {
    expect(holdSeconds(60)).toBe(30);
    expect(holdSeconds(4)).toBe(5);
    expect(holdSeconds(3600)).toBe(300);
  });
});

describe('SnapshotRelay', () => {
  it('serves one upstream fetch to every viewer inside the hold, then refreshes', async () => {
    const { relay, calls, clock } = harness(() =>
      jpeg({ 'last-modified': 'Thu, 22 Oct 2026 13:10:22 GMT' }),
    );
    const first = await relay.snapshot(target);
    expect(first.contentType).toBe('image/jpeg');
    expect(first.frameAt?.toISOString()).toBe('2026-10-22T13:10:22.000Z');
    expect(first.etag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    clock.t += 29_000;
    await relay.snapshot(target);
    expect(calls).toHaveLength(1);
    clock.t += 2_000;
    await relay.snapshot(target);
    expect(calls).toHaveLength(2);
  });

  it('shares one fetch between concurrent first requests', async () => {
    const { relay, calls } = harness(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jpeg();
    });
    await Promise.all([relay.snapshot(target), relay.snapshot(target), relay.snapshot(target)]);
    expect(calls).toHaveLength(1);
  });

  it('maps a refusal of the address to "unavailable"', async () => {
    const refused = new SnapshotRelay({
      safeFetch: async () => {
        throw new SsrfRejection('Blocked address: 10.0.0.1');
      },
    });
    await expect(refused.snapshot(target)).rejects.toBeInstanceOf(SnapshotUnavailableError);
  });

  it('serves what the bytes are, not what the operator labelled them (a PNG sent as image/jpeg)', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const { relay } = harness(() => ({ body: png, headers: { 'content-type': 'image/jpeg' } }));
    expect((await relay.snapshot(target)).contentType).toBe('image/png');
  });

  it('refuses HTML or SVG even when it is labelled as an image', async () => {
    const html = harness(() => ({
      body: '<script>alert(1)</script>',
      headers: { 'content-type': 'image/jpeg' },
    }));
    await expect(html.relay.snapshot(target)).rejects.toThrow('not an image');
  });

  it('refuses a page that is not an image, an error status and a picture over the cap', async () => {
    const html = harness(() => ({ body: '<script>', headers: { 'content-type': 'text/html' } }));
    await expect(html.relay.snapshot(target)).rejects.toThrow('not an image');
    const down = harness(() => ({ status: 503 }));
    await expect(down.relay.snapshot(target)).rejects.toBeInstanceOf(SnapshotUnavailableError);
    const huge = harness(() => ({
      body: new Uint8Array(MAX_SNAPSHOT_BYTES + 1),
      headers: { 'content-type': 'image/jpeg' },
    }));
    await expect(huge.relay.snapshot(target)).rejects.toThrow('too large');
  });

  it('does not hammer a camera that just failed, and serves the old copy through an outage', async () => {
    let healthy = true;
    const { relay, calls, clock } = harness(() => (healthy ? jpeg() : { status: 500 }));
    const copy = await relay.snapshot(target);
    healthy = false;
    clock.t += 40_000; // past the hold
    expect(await relay.snapshot(target)).toBe(copy); // fetch failed → the old copy
    const failures = calls.length;
    clock.t += 1_000; // inside the failure hold
    expect(await relay.snapshot(target)).toBe(copy);
    expect(calls).toHaveLength(failures);
  });

  it('refuses outright when a camera has failed and there is no copy', async () => {
    const { relay, calls } = harness(() => ({ status: 500 }));
    await expect(relay.snapshot(target)).rejects.toBeInstanceOf(SnapshotUnavailableError);
    await expect(relay.snapshot(target)).rejects.toThrow('try again shortly');
    expect(calls).toHaveLength(1);
  });
});

describe('SnapshotRelay with the real safeFetch', () => {
  it('never connects to a private, loopback or cloud-metadata address', async () => {
    for (const upstreamUrl of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1/one.jpg',
      'http://localhost/one.jpg',
      'http://[::1]/one.jpg',
      'http://10.0.0.1/one.jpg',
      'https://cams.example.org:5432/one.jpg',
    ]) {
      const relay = new SnapshotRelay();
      await expect(
        relay.snapshot({ id: upstreamUrl, upstreamUrl, refreshSeconds: 60 }),
      ).rejects.toThrow("Refused the camera's address");
    }
  });
});
