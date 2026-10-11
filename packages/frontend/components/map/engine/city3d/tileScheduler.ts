/**
 * Which tiles the city-3D engine asks the worker for, when it retries, and
 * which cached tiles it lets go — the engine's bookkeeping, without three.js,
 * so it is testable (`__tests__/city3dTileScheduler.test.ts`).
 *
 * ## Two defects this exists to fix (PR #119 review)
 *
 *  1. **A failed tile was never retried while the view stood still.** The
 *     engine only scheduled requests when the SET of wanted tiles changed, and
 *     a failure merely forgot the request — so a tile whose fetch failed once
 *     stayed missing until the user panned, while `building-3d` (which would
 *     have drawn it) was hidden. {@link TileScheduler.plan} now runs every
 *     frame over the wanted tiles and re-requests a failed one once its
 *     backoff has passed — bounded (see {@link RETRY}), so a tile that fails
 *     for good costs a handful of requests, never a hot loop.
 *  2. **Empty tiles were refetched on every revisit.** A tile with no
 *     buildings (sea, fields, a 204/404) meshes to nothing and was not
 *     remembered, so every time it came back into view it was fetched,
 *     decoded and found empty again. The engine now caches an empty entry
 *     (`bytes: 0`), under the same eviction — which is why
 *     {@link pickEvictions} caps the entry COUNT as well as the bytes: a
 *     byte budget alone would never evict a zero-byte entry.
 */
import { type TileId, tileKey } from './tileMath';

/** Retry policy for a tile whose request failed. */
export const RETRY = {
  /** Delay before the first retry. */
  baseMs: 1_000,
  /** Ceiling of the exponential backoff. */
  maxMs: 30_000,
  /** Failures before the tile is given up on for {@link RETRY.cooldownMs}. */
  maxAttempts: 5,
  /** How long a given-up tile is left alone before one more try. */
  cooldownMs: 5 * 60_000,
} as const;

/**
 * Milliseconds to wait after the `attempts`-th consecutive failure: 1 s, 2 s,
 * 4 s, 8 s, then the cooldown. At most {@link RETRY.maxAttempts} requests per
 * cooldown for a tile that never succeeds.
 */
export function retryDelayMs(attempts: number): number {
  if (attempts >= RETRY.maxAttempts) return RETRY.cooldownMs;
  return Math.min(RETRY.baseMs * 2 ** Math.max(0, attempts - 1), RETRY.maxMs);
}

interface Failure {
  attempts: number;
  retryAt: number;
}

export interface Plan<T extends TileId = TileId> {
  /** Tiles to request now, nearest first. */
  request: T[];
  /** Request ids to cancel: in flight for tiles no longer wanted. */
  cancel: number[];
}

/**
 * The request bookkeeping for one engine. Request ids are the engine's (they
 * travel to the worker and back); the scheduler only remembers them.
 *
 * `T` is what is requested — a tile, or a tile at a level of detail — and
 * `keyOf` names it; by default a tile is its `tileKey`.
 */
export class TileScheduler<T extends TileId = TileId> {
  private readonly pending = new Map<string, number>();
  private readonly failures = new Map<string, Failure>();
  private wanted: string[] = [];

  constructor(private readonly keyOf: (tile: T) => string = tileKey) {}

  /** The keys last planned for, nearest first. */
  get wantedKeys(): readonly string[] {
    return this.wanted;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * What to do this frame for `tiles` (the view's wanted set). Cheap enough
   * to run every frame — a handful of map lookups — which is the point: a
   * retry comes due on a frame where nothing else changed.
   *
   * @param isCached - whether a tile (empty or not) is already in the cache.
   */
  plan(tiles: readonly T[], now: number, isCached: (key: string) => boolean): Plan<T> {
    const keys = tiles.map(this.keyOf);
    this.wanted = keys;
    const wanted = new Set(keys);

    const cancel: number[] = [];
    for (const [key, id] of this.pending) {
      if (wanted.has(key)) continue;
      cancel.push(id);
      this.pending.delete(key);
    }

    const request: T[] = [];
    tiles.forEach((tile, i) => {
      const key = keys[i];
      if (isCached(key) || this.pending.has(key)) return;
      const failure = this.failures.get(key);
      if (failure && now < failure.retryAt) return;
      request.push(tile);
    });
    return { request, cancel };
  }

  /** A request for `tile` went out as `id`. */
  started(tile: T, id: number): void {
    this.pending.set(this.keyOf(tile), id);
  }

  /**
   * The worker answered `id` for `tile` with a mesh or an empty tile. Returns
   * whether the answer is still wanted (`false` for a superseded request).
   */
  succeeded(tile: T, id: number): boolean {
    const key = this.keyOf(tile);
    if (this.pending.get(key) !== id) return false;
    this.pending.delete(key);
    this.failures.delete(key);
    return true;
  }

  /**
   * The worker reported `id` for `tile` failed. Returns the delay before it
   * may be retried, or `null` for a superseded request (nothing to retry).
   */
  failed(tile: T, id: number, now: number): number | null {
    const key = this.keyOf(tile);
    if (this.pending.get(key) !== id) return null;
    this.pending.delete(key);
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    const delay = retryDelayMs(attempts);
    // After the cooldown the count restarts, so the next round is again
    // bounded by `maxAttempts` — never an unbounded stream of requests.
    this.failures.set(key, {
      attempts: attempts >= RETRY.maxAttempts ? 0 : attempts,
      retryAt: now + delay,
    });
    return delay;
  }
}

/** One cache entry, as eviction sees it. */
export interface CacheEntryInfo {
  key: string;
  bytes: number;
  lastUsed: number;
}

/**
 * Keys to evict so the cache fits BOTH budgets, least recently used first,
 * never a wanted tile. Empty tiles weigh 0 bytes and are bounded by the count.
 */
export function pickEvictions(
  entries: readonly CacheEntryInfo[],
  wanted: ReadonlySet<string>,
  maxBytes: number,
  maxEntries: number,
): string[] {
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let count = entries.length;
  const evicted: string[] = [];
  const candidates = entries
    .filter((entry) => !wanted.has(entry.key))
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const entry of candidates) {
    if (bytes <= maxBytes && count <= maxEntries) break;
    evicted.push(entry.key);
    bytes -= entry.bytes;
    count--;
  }
  return evicted;
}

/**
 * The engine's tile cache, renderer-agnostic: `T` is whatever the engine
 * draws (a three.js mesh), `null` an EMPTY tile — remembered, so a revisit
 * does not fetch it again, and bounded by the entry budget like any other.
 */
export class TileCache<T> {
  private readonly entries = new Map<
    string,
    { value: T | null; bytes: number; lastUsed: number }
  >();

  /** @param release - frees a value the cache lets go (GPU buffers). */
  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries: number,
    private readonly release: (value: T) => void,
  ) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The value (`null` for an empty tile), or `undefined` when not cached. */
  get(key: string): T | null | undefined {
    return this.entries.get(key)?.value;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Total bytes of cached (non-empty) values. */
  get bytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  *values(): IterableIterator<T> {
    for (const entry of this.entries.values()) if (entry.value !== null) yield entry.value;
  }

  /** Store a tile (or `null`: empty), then evict down to budget, sparing `wanted`. */
  put(key: string, value: T | null, bytes: number, now: number, wanted: ReadonlySet<string>): void {
    const previous = this.entries.get(key);
    if (previous?.value != null && previous.value !== value) this.release(previous.value);
    this.entries.set(key, { value, bytes: value === null ? 0 : bytes, lastUsed: now });
    this.evict(wanted);
  }

  /** Mark a tile used now (it is in view). */
  touch(key: string, now: number): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsed = now;
  }

  evict(wanted: ReadonlySet<string>): void {
    const infos = [...this.entries.entries()].map(([key, entry]) => ({
      key,
      bytes: entry.bytes,
      lastUsed: entry.lastUsed,
    }));
    for (const key of pickEvictions(infos, wanted, this.maxBytes, this.maxEntries)) {
      const value = this.entries.get(key)?.value;
      if (value != null) this.release(value);
      this.entries.delete(key);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) if (entry.value !== null) this.release(entry.value);
    this.entries.clear();
  }
}
