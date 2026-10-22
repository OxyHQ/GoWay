import { describe, expect, it } from 'bun:test';
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
const publicDns = async () => ['93.184.216.34'];

interface Harness {
  relay: SnapshotRelay;
  calls: string[];
  clock: { t: number };
}

function harness(respond: (url: string) => Response | Promise<Response>): Harness {
  const calls: string[] = [];
  const clock = { t: 1_000_000 };
  const relay = new SnapshotRelay({
    fetch: async (input: URL | string) => {
      calls.push(String(input));
      return respond(String(input));
    },
    now: () => clock.t,
    resolve: publicDns,
  });
  return { relay, calls, clock };
}

const jpeg = (headers: Record<string, string> = {}) =>
  new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } });

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

  it('follows a redirect but re-checks every hop, refusing one into the private network', async () => {
    const ok = harness((url) =>
      url.endsWith('one.jpg')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.org/final.jpg' },
          })
        : jpeg(),
    );
    await ok.relay.snapshot(target);
    expect(ok.calls).toEqual([target.upstreamUrl, 'https://cdn.example.org/final.jpg']);

    const inward = harness(
      () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
    );
    await expect(inward.relay.snapshot(target)).rejects.toThrow('not a public address');
    expect(inward.calls).toEqual([target.upstreamUrl]);
  });

  it('serves what the bytes are, not what the operator labelled them (a PNG sent as image/jpeg)', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const { relay } = harness(
      () => new Response(png, { headers: { 'content-type': 'image/jpeg' } }),
    );
    expect((await relay.snapshot(target)).contentType).toBe('image/png');
  });

  it('refuses HTML or SVG even when it is labelled as an image', async () => {
    const html = harness(
      () =>
        new Response('<script>alert(1)</script>', { headers: { 'content-type': 'image/jpeg' } }),
    );
    await expect(html.relay.snapshot(target)).rejects.toThrow('not an image');
  });

  it('refuses a page that is not an image, an error status and a picture over the cap', async () => {
    const html = harness(
      () => new Response('<script>', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(html.relay.snapshot(target)).rejects.toThrow('not an image');
    const down = harness(() => new Response('', { status: 503 }));
    await expect(down.relay.snapshot(target)).rejects.toBeInstanceOf(SnapshotUnavailableError);
    const huge = harness(
      () =>
        new Response(new Uint8Array(MAX_SNAPSHOT_BYTES + 1), {
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
    await expect(huge.relay.snapshot(target)).rejects.toThrow('too large');
  });

  it('does not hammer a camera that just failed, and serves the old copy through an outage', async () => {
    let healthy = true;
    const { relay, calls, clock } = harness(() =>
      healthy ? jpeg() : new Response('', { status: 500 }),
    );
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
    const { relay, calls } = harness(() => new Response('', { status: 500 }));
    await expect(relay.snapshot(target)).rejects.toBeInstanceOf(SnapshotUnavailableError);
    await expect(relay.snapshot(target)).rejects.toThrow('try again shortly');
    expect(calls).toHaveLength(1);
  });
});
