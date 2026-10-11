/**
 * The live hub: who is watching what, which feeds to poll for it, and what to
 * tell each room when a feed answers.
 *
 * Transport-free on purpose. It never touches Socket.IO: watchers are opaque
 * ids with a set of rooms, and a delta leaves through the `publish` callback.
 * `socket.ts` is the Socket.IO binding; a test drives the hub with a fake
 * clock, a fake fetch and `await hub.tick()`.
 *
 * ## Demand-driven polling
 *
 * A source is polled only while somebody watches a room of its kind inside
 * its coverage — no viewers in New York, no requests to New York's feeds. A
 * source nobody has watched for {@link IDLE_GRACE_MS} drops what it holds, so
 * the next viewer starts from a fresh poll rather than from a stale cache, and
 * an idle process holds nothing.
 *
 * ## Freshness is the feed's, not ours
 *
 * Entities are aged by their own `observedAt`. Anything older than its
 * source's `dropAfterSeconds` is removed on the next tick whatever the feed
 * still says; anything older than `staleAfterSeconds` is still served, and the
 * client draws it as stale. The server never moves an entity.
 *
 * ## Backoff
 *
 * A failed poll waits `interval × 2^failures` (capped at
 * {@link MAX_BACKOFF_MS}, ±20% jitter), or the upstream's `Retry-After` when
 * it gave one and it is longer. One poll per source is in flight at a time,
 * bounded by {@link POLL_TIMEOUT_MS}.
 */

import {
  type GeoBoundingBox,
  type LiveDelta,
  type LiveEntity,
  type LiveKind,
  type LiveSnapshot,
  type LiveSource,
  type LiveSourceStatus,
  liveTileBounds,
} from '@goway/contracts';
import { contains, type IndexChange, LiveTileIndex, roomKey } from './tileIndex';
import {
  type LiveAdapter,
  type LiveAdapterSettings,
  type LiveFetch,
  type LiveSourceDefinition,
  LiveUpstreamError,
} from './types';

/** How long a source nobody watches keeps what it holds. */
export const IDLE_GRACE_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
export const POLL_TIMEOUT_MS = 15_000;
/** How often `start()` ticks. */
export const TICK_MS = 1000;

export interface LiveHubLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
}

export interface LiveHubSource {
  definition: LiveSourceDefinition;
  settings: LiveAdapterSettings;
}

export interface LiveHubOptions {
  sources: readonly LiveHubSource[];
  fetch: LiveFetch;
  now?: () => number;
  /** A room's changes. Called only for rooms somebody watches. */
  publish: (delta: LiveDelta) => void;
  /** The source list changed in a way a client shows (status, freshness, counts). */
  onSourcesChanged?: () => void;
  logger?: LiveHubLogger;
  /** Jitter in `[0, 1)`; injected so a test's backoff is exact. */
  random?: () => number;
}

interface SourceState {
  definition: LiveSourceDefinition;
  adapter: LiveAdapter;
  secrets: string[];
  inFlight: Promise<void> | null;
  abort: AbortController | null;
  nextDueAt: number;
  lastSuccessAt: number | null;
  failures: number;
  /** When it last had demand; `null` while it has demand now. */
  idleSince: number | null;
  everActive: boolean;
}

interface Room {
  tile: string;
  kind: LiveKind;
}

export class LiveHub {
  private readonly index = new LiveTileIndex();
  private readonly states: SourceState[];
  /** watcher id → the room keys it is in. */
  private readonly watchers = new Map<string, Set<string>>();
  /** room key → watcher count. */
  private readonly roomWatchers = new Map<string, number>();
  private readonly now: () => number;
  private readonly random: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastSourcesSignature = '';

  constructor(private readonly options: LiveHubOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.states = options.sources.map(({ definition, settings }) => ({
      definition,
      adapter: definition.create(settings),
      secrets: settings.key ? [settings.key] : [],
      inFlight: null,
      abort: null,
      nextDueAt: 0,
      lastSuccessAt: null,
      failures: 0,
      idleSince: null,
      everActive: false,
    }));
  }

  // ── Watchers ──────────────────────────────────────────────────────────────

  /**
   * Set what a watcher is in, replacing what it was in. Returns the rooms it
   * JOINED (to snapshot) and LEFT. The rooms say nothing about who the watcher
   * is and are never logged.
   */
  watch(watcherId: string, rooms: readonly Room[]): { joined: Room[]; left: Room[] } {
    const next = new Set(rooms.map((room) => roomKey(room.tile, room.kind)));
    const previous = this.watchers.get(watcherId) ?? new Set<string>();
    const joined: Room[] = [];
    const left: Room[] = [];
    for (const key of previous) {
      if (next.has(key)) continue;
      this.decrement(key);
      left.push(parseRoom(key));
    }
    for (const room of rooms) {
      const key = roomKey(room.tile, room.kind);
      if (previous.has(key)) continue;
      this.roomWatchers.set(key, (this.roomWatchers.get(key) ?? 0) + 1);
      joined.push(room);
    }
    if (next.size === 0) this.watchers.delete(watcherId);
    else this.watchers.set(watcherId, next);
    return { joined, left };
  }

  unwatch(watcherId: string): void {
    for (const key of this.watchers.get(watcherId) ?? []) this.decrement(key);
    this.watchers.delete(watcherId);
  }

  private decrement(key: string): void {
    const count = (this.roomWatchers.get(key) ?? 0) - 1;
    if (count <= 0) this.roomWatchers.delete(key);
    else this.roomWatchers.set(key, count);
  }

  /** Everything in one room, now. */
  snapshot(tile: string, kind: LiveKind): LiveSnapshot {
    return {
      tile,
      kind,
      at: new Date(this.now()).toISOString(),
      entities: this.index.inRoom(tile, kind),
    };
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  sources(): LiveSource[] {
    const now = this.now();
    return this.states.map((state) => {
      const { definition } = state;
      return {
        id: definition.id,
        kind: definition.kind,
        name: definition.name,
        attribution: definition.attribution,
        licence: definition.licence,
        coverage: definition.coverage,
        status: this.statusOf(state, now),
        lastUpdatedAt:
          state.lastSuccessAt === null ? null : new Date(state.lastSuccessAt).toISOString(),
        pollIntervalSeconds: definition.pollIntervalSeconds,
        staleAfterSeconds: definition.staleAfterSeconds,
        dropAfterSeconds: definition.dropAfterSeconds,
        entityCount: this.index.countOfSource(definition.id),
      };
    });
  }

  private statusOf(state: SourceState, now: number): LiveSourceStatus {
    const active = state.idleSince === null && state.everActive;
    if (!active && state.inFlight === null) return 'idle';
    if (state.failures >= 2 || (state.lastSuccessAt === null && state.failures >= 1)) {
      return 'unavailable';
    }
    if (state.lastSuccessAt === null) return 'starting';
    const interval = state.definition.pollIntervalSeconds * 1000;
    return now - state.lastSuccessAt > 3 * interval + POLL_TIMEOUT_MS ? 'stale' : 'live';
  }

  /** The watched room boxes inside a source's coverage, of its kind. */
  private demandFor(definition: LiveSourceDefinition): GeoBoundingBox[] {
    const boxes: GeoBoundingBox[] = [];
    for (const key of this.roomWatchers.keys()) {
      const room = parseRoom(key);
      if (room.kind !== definition.kind) continue;
      const box = liveTileBounds(room.tile);
      if (definition.coverage && !intersects(box, definition.coverage)) continue;
      boxes.push(box);
    }
    return boxes;
  }

  // ── The clock ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Never what keeps the process alive: shutdown closes the server and exits.
    const handle: unknown = this.timer;
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      const unref = (handle as { unref?: unknown }).unref;
      if (typeof unref === 'function') unref.call(handle);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const state of this.states) state.abort?.abort();
  }

  /**
   * One step: start the polls that are due, age entities out, release idle
   * sources. Resolves when the polls it STARTED have been applied — which is
   * what a test awaits; the interval in `start()` does not.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const started: Promise<void>[] = [];
    for (const state of this.states) {
      const demand = this.demandFor(state.definition);
      if (demand.length === 0) {
        if (state.idleSince === null && state.everActive) state.idleSince = now;
        if (state.idleSince !== null && now - state.idleSince > IDLE_GRACE_MS) {
          this.release(state);
        }
        continue;
      }
      state.idleSince = null;
      state.everActive = true;
      if (state.inFlight || now < state.nextDueAt) continue;
      started.push(this.poll(state, demand));
    }
    this.sweep(now);
    this.notifySources();
    await Promise.all(started);
  }

  private poll(state: SourceState, demand: GeoBoundingBox[]): Promise<void> {
    const startedAt = this.now();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS);
    state.abort = abort;
    const run = state.adapter
      .poll({ signal: abort.signal, fetch: this.options.fetch, now: this.now, demand })
      .then(
        (result) => {
          if (this.stopped) return;
          state.failures = 0;
          state.lastSuccessAt = this.now();
          state.nextDueAt =
            startedAt +
            Math.max(state.definition.pollIntervalSeconds, result.backoffSeconds ?? 0) * 1000;
          this.apply(state, result.entities);
        },
        (error: unknown) => {
          if (this.stopped) return;
          state.failures++;
          const base = state.definition.pollIntervalSeconds * 1000;
          let delay = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(state.failures, 10));
          delay *= 0.8 + 0.4 * this.random();
          if (error instanceof LiveUpstreamError && error.retryAfterSeconds !== null) {
            delay = Math.max(delay, error.retryAfterSeconds * 1000);
          }
          state.nextDueAt = this.now() + delay;
          // The source and why — never a URL (it may carry a key) and never
          // anything about who is watching.
          this.options.logger?.warn(
            {
              source: state.definition.id,
              failures: state.failures,
              retryInSeconds: Math.round(delay / 1000),
              reason: redact(describe(error), state.secrets),
            },
            'Live source poll failed',
          );
        },
      )
      .finally(() => {
        clearTimeout(timeout);
        state.inFlight = null;
        state.abort = null;
        this.notifySources();
      });
    state.inFlight = run;
    return run;
  }

  /** Apply one poll's answer and publish what changed. */
  private apply(state: SourceState, entities: readonly LiveEntity[]): void {
    const { definition } = state;
    const now = this.now();
    const changes: IndexChange[] = [];
    const seen = new Set<string>();
    for (const entity of entities) {
      // A feed can hand back a fix older than the drop bound; it is not served.
      if (now - Date.parse(entity.observedAt) > definition.dropAfterSeconds * 1000) continue;
      if (entity.sourceId !== definition.id) continue;
      seen.add(entity.id);
      changes.push(...this.index.upsert(entity));
    }
    if (!definition.partialPolls) {
      // A full snapshot: whatever it no longer lists is gone.
      for (const id of this.index.idsOfSource(definition.id)) {
        if (!seen.has(id)) changes.push(...this.index.remove(id));
      }
    }
    this.flush(changes);
  }

  /** Remove everything older than its source's drop bound. */
  private sweep(now: number): void {
    const bounds = new Map(
      this.states.map((state) => [state.definition.id, state.definition.dropAfterSeconds * 1000]),
    );
    const expired: string[] = [];
    for (const entity of this.index.all()) {
      const bound = bounds.get(entity.sourceId);
      if (bound !== undefined && now - Date.parse(entity.observedAt) > bound)
        expired.push(entity.id);
    }
    if (expired.length === 0) return;
    const changes: IndexChange[] = [];
    for (const id of expired) changes.push(...this.index.remove(id));
    this.flush(changes);
  }

  private release(state: SourceState): void {
    state.everActive = false;
    state.idleSince = null;
    state.lastSuccessAt = null;
    state.failures = 0;
    state.nextDueAt = 0;
    const changes: IndexChange[] = [];
    for (const id of this.index.idsOfSource(state.definition.id))
      changes.push(...this.index.remove(id));
    this.flush(changes);
  }

  /** Group changes per room and publish the watched ones. */
  private flush(changes: readonly IndexChange[]): void {
    if (changes.length === 0) return;
    const at = new Date(this.now()).toISOString();
    const perRoom = new Map<string, { upserts: Map<string, LiveEntity>; removes: Set<string> }>();
    for (const change of changes) {
      if (!this.roomWatchers.has(change.room)) continue;
      let room = perRoom.get(change.room);
      if (!room) {
        room = { upserts: new Map(), removes: new Set() };
        perRoom.set(change.room, room);
      }
      if (change.type === 'upsert') {
        room.removes.delete(change.entity.id);
        room.upserts.set(change.entity.id, change.entity);
      } else {
        room.upserts.delete(change.id);
        room.removes.add(change.id);
      }
    }
    for (const [key, room] of perRoom) {
      if (room.upserts.size === 0 && room.removes.size === 0) continue;
      const { tile, kind } = parseRoom(key);
      this.options.publish({
        tile,
        kind,
        at,
        upserts: [...room.upserts.values()],
        removes: [...room.removes],
      });
    }
  }

  private notifySources(): void {
    if (!this.options.onSourcesChanged) return;
    const signature = JSON.stringify(
      this.sources().map((source) => [source.status, source.lastUpdatedAt, source.entityCount]),
    );
    if (signature === this.lastSourcesSignature) return;
    this.lastSourcesSignature = signature;
    this.options.onSourcesChanged();
  }

  /** Test seam: entities in a box. */
  query(box: GeoBoundingBox, kinds: readonly LiveKind[]): LiveEntity[] | null {
    return this.index.query(box, kinds);
  }

  /** Whether a position is inside a source's coverage; exported for tests. */
  static covers(
    definition: LiveSourceDefinition,
    point: { latitude: number; longitude: number },
  ): boolean {
    return definition.coverage === null || contains(definition.coverage, point);
  }
}

function parseRoom(key: string): Room {
  const [tile, kind] = key.split('|') as [string, LiveKind];
  return { tile, kind };
}

function intersects(a: GeoBoundingBox, b: GeoBoundingBox): boolean {
  if (a.north < b.south || a.south > b.north) return false;
  // Neither of GoWay's coverages crosses the antimeridian; a room tile never does.
  return a.west <= b.east && a.east >= b.west;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200);
  return String(error).slice(0, 200);
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out;
}
