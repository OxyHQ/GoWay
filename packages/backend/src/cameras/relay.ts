/**
 * GoWay's own copy of a camera's picture.
 *
 * A client asks GoWay for `/cameras/{id}/snapshot`; it never talks to the
 * operator. The relay fetches the upstream still, holds it for a fraction of
 * the camera's own refresh interval, and serves every viewer in that window
 * from the one copy — so a thousand people watching one camera cost its
 * operator one request, and GoWay is a considerate client of every provider.
 *
 * ## Safe by construction
 *
 * The URL is third-party data (`publicHost.ts`): every hop of a redirect is
 * checked to be a public host, the body is capped, and only an image is
 * accepted — never HTML, which would let a hostile upstream put markup on a
 * GoWay origin. What an image IS is read from its bytes, not from the
 * upstream's `Content-Type`: Toronto serves PNG files labelled `image/jpeg`,
 * and a label is the one thing a third party can get wrong.
 *
 * ## One request per camera at a time
 *
 * Concurrent first requests share a single upstream fetch (single flight), and
 * a failed fetch is remembered briefly so a dead camera is not hammered by
 * every viewer.
 */

import { SNAPSHOT_CACHE_MIN_SECONDS } from './config';
import { assertPublicUrl, type Resolver } from './publicHost';

export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
/** The most pictures held at once, and the most bytes across them. */
const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** A failed camera is not asked again for this long. */
const FAILURE_HOLD_MS = 15_000;

/** The image type the first bytes say, or `null` when they are not an image GoWay serves. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (offset: number, ...values: number[]) =>
    values.every((value, i) => bytes[offset + i] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

export interface Snapshot {
  bytes: Uint8Array;
  contentType: string;
  /** When GoWay fetched it. */
  fetchedAt: number;
  /** When the camera took it, from the upstream's `Last-Modified`, when it says. */
  frameAt: Date | null;
  etag: string;
}

export class SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotUnavailableError';
  }
}

export interface SnapshotRelayOptions {
  fetch?: typeof fetch;
  now?: () => number;
  resolve?: Resolver;
  userAgent?: string;
}

export interface RelayTarget {
  id: string;
  upstreamUrl: string;
  refreshSeconds: number;
}

/** How long a copy is served: half the camera's refresh (so a viewer is never more than ~1.5 intervals old), floored. */
export function holdSeconds(refreshSeconds: number): number {
  return Math.max(SNAPSHOT_CACHE_MIN_SECONDS, Math.min(Math.floor(refreshSeconds / 2), 300));
}

export class SnapshotRelay {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly resolve: Resolver | undefined;
  private readonly userAgent: string;
  private readonly cache = new Map<string, Snapshot>();
  private readonly inFlight = new Map<string, Promise<Snapshot>>();
  private readonly failedAt = new Map<string, number>();
  private totalBytes = 0;

  constructor(options: SnapshotRelayOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.resolve = options.resolve;
    this.userAgent = options.userAgent ?? 'GoWay-cameras/1.0 (+https://goway.to)';
  }

  /** The camera's picture: GoWay's copy if it is fresh enough, else a new fetch. */
  async snapshot(target: RelayTarget): Promise<Snapshot> {
    const held = this.cache.get(target.id);
    const ttlMs = holdSeconds(target.refreshSeconds) * 1000;
    if (held && this.now() - held.fetchedAt < ttlMs) {
      this.cache.delete(target.id);
      this.cache.set(target.id, held); // most recently used last
      return held;
    }
    const failed = this.failedAt.get(target.id);
    if (failed !== undefined && this.now() - failed < FAILURE_HOLD_MS) {
      // A fetch just failed: an older copy beats an error, but only for the hold.
      if (held) return held;
      throw new SnapshotUnavailableError('The camera did not answer; try again shortly.');
    }
    const running = this.inFlight.get(target.id);
    if (running) return running;
    const fetching = this.fetchUpstream(target).then(
      (snapshot) => {
        this.failedAt.delete(target.id);
        this.store(target.id, snapshot);
        return snapshot;
      },
      (error: unknown) => {
        this.failedAt.set(target.id, this.now());
        if (held) return held;
        throw error;
      },
    );
    this.inFlight.set(target.id, fetching);
    try {
      return await fetching;
    } finally {
      this.inFlight.delete(target.id);
    }
  }

  private store(id: string, snapshot: Snapshot): void {
    const previous = this.cache.get(id);
    if (previous) this.totalBytes -= previous.bytes.byteLength;
    this.cache.delete(id);
    this.cache.set(id, snapshot);
    this.totalBytes += snapshot.bytes.byteLength;
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= MAX_ENTRIES && this.totalBytes <= MAX_TOTAL_BYTES) break;
      this.cache.delete(key);
      this.totalBytes -= entry.bytes.byteLength;
    }
  }

  private async fetchUpstream(target: RelayTarget): Promise<Snapshot> {
    let url = new URL(target.upstreamUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        await assertPublicUrl(url, this.resolve);
      } catch (error) {
        throw new SnapshotUnavailableError(`Refused ${url.hostname}: ${(error as Error).message}`);
      }
      const response = await this.fetchFn(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': this.userAgent, accept: 'image/*' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new SnapshotUnavailableError('Redirect without a location.');
        url = new URL(location, url);
        continue;
      }
      if (response.status !== 200) {
        throw new SnapshotUnavailableError(`The camera answered ${response.status}.`);
      }
      const bytes = await readCapped(response, MAX_SNAPSHOT_BYTES);
      const contentType = sniffImageType(bytes);
      if (!contentType) {
        throw new SnapshotUnavailableError('The camera sent something that is not an image.');
      }
      const modified = response.headers.get('last-modified');
      const frameAt = modified ? new Date(modified) : null;
      return {
        bytes,
        contentType,
        fetchedAt: this.now(),
        frameAt: frameAt && Number.isFinite(frameAt.getTime()) ? frameAt : null,
        etag: `"${await digest(bytes)}"`,
      };
    }
    throw new SnapshotUnavailableError('Too many redirects.');
  }
}

/** The body, refused (not truncated) past `max` bytes. */
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > max) throw new SnapshotUnavailableError('The picture is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new SnapshotUnavailableError('The camera sent no body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      throw new SnapshotUnavailableError('The picture is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-1', bytes);
  return Buffer.from(hash).toString('base64url').slice(0, 22);
}
