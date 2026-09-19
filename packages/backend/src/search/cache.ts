/**
 * A bounded, TTL'd, in-process cache for upstream geocoder answers.
 *
 * Deliberately small and deliberately dumb. What it is for is the repeated
 * identical question — a user retyping "berlin", ten clients asking for the
 * same city on the same minute — where one cache hit is one request GoWay did
 * not spend against a community instance's fair-use allowance.
 *
 * ## Bounded on BOTH axes
 *
 * Entries expire (`ttlMs`) and the map is capped (`maxEntries`), evicting the
 * least recently used. An unbounded cache in front of a free-text API is a
 * memory leak with a user-controlled key: every distinct typo is a new entry
 * that nothing ever removes.
 *
 * ## What is NOT cached, and why that is a privacy decision
 *
 * The caller decides what to cache; the service (see `searchService.ts`) does
 * not cache any request carrying a precise coordinate — a `near` bias or a
 * reverse lookup. Such a key IS the user's location, and while an in-process
 * entry evicted within a minute is not "history" in the sense the privacy rule
 * forbids, it is a copy of a precise coordinate held past the request that
 * carried it, in a process that also writes logs and dumps heap on a crash. The
 * hit-rate that buys is not worth arguing about it.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface BoundedCacheOptions {
  maxEntries: number;
  ttlMs: number;
  /** Injectable so a test can move time without sleeping. */
  now?: () => number;
}

export class BoundedCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: BoundedCacheOptions) {
    this.maxEntries = Math.max(0, options.maxEntries);
    this.ttlMs = Math.max(0, options.ttlMs);
    this.now = options.now ?? Date.now;
  }

  /** Whether this cache stores anything at all. Either bound at zero turns it off. */
  get enabled(): boolean {
    return this.maxEntries > 0 && this.ttlMs > 0;
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to move the key to the end: `Map` iterates in insertion order,
    // so the first key is the least recently used one to evict below.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Entries currently held, expired ones included. For tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
