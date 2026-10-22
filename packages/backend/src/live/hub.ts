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
 *
 * ## Several tasks
 *
 * With a {@link LiveBus} (`cluster.ts`), demand is the union of every task's
 * watchers, one task (the lease holder) polls each source and publishes what
 * it got, and every other task applies that as if it had polled. Without
 * one — or while it is unreachable — this process polls on its own.
 */

import { meetsSource } from './areas';
import {
  type GeoBoundingBox,
  isRegionalTransitMode,
  LIVE_ROOM_ZOOMS,
  type LiveDelta,
  type LiveEntity,
  type LiveKind,
  type LiveShape,
  type LiveSnapshot,
  type LiveSource,
  type LiveSourceStatus,
  liveTileBounds,
} from '@goway/contracts';
import {
  COORDINATE_MS,
  DEMAND_TTL_MS,
  LEASE_MS,
  type LiveBus,
  type LiveClusterMessage,
} from './cluster';
import { getBytes } from './normalise';
import {
  loadStaticGtfs,
  type MatchHint,
  matchTrack,
  type PreviousMatch,
  type StaticGtfs,
} from './staticGtfs';
import { type Room, RoomRegistry, parseRoom } from '../hub/rooms';
import { contains, type IndexChange, LiveTileIndex, moveOf } from './tileIndex';
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
  /** Shared with the other API tasks (`cluster.ts`); absent, this process is alone. */
  bus?: LiveBus | null;
  /** Lease and demand timings (`cluster.ts`); tests shorten them. */
  cluster?: {
    leaseMs?: number;
    demandTtlMs?: number;
    coordinateMs?: number;
    /** A bus call unanswered for this long counts as the bus being down (default lease ÷ 3). */
    callTimeoutMs?: number;
  };
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
  /** The operator's static GTFS, when the definition names one (`staticGtfs.ts`). */
  gtfs: StaticGtfs | null;
  gtfsLoading: Promise<void> | null;
  /** When the next load may start (a refresh, or a retry after failure). */
  gtfsDueAt: number;
  gtfsFailures: number;
  /** Since when this task has had no use for the static GTFS it holds. */
  gtfsUnneededSince: number | null;
  /** Each vehicle's last match, to keep it on its direction's shape. */
  matches: Map<string, PreviousMatch>;
  settings: LiveAdapterSettings;
  /** Whether this task holds the source's lease (always, without a bus). */
  leader: boolean;
  /** This task's lease epoch while it leads (`LiveBus.lease`); 0 otherwise. */
  epoch: number;
  /** The newest leader epoch heard for this source: older messages are dropped. */
  heardEpoch: number;
  /** When a message at {@link heardEpoch} last arrived. */
  heardAt: number;
}

/** Static GTFS is re-read this often while a source is watched. */
export const STATIC_GTFS_REFRESH_MS = 24 * 3600_000;
/**
 * A static GTFS this task has had no use for this long is let go: with the
 * worldwide catalogue a task would otherwise end the day holding every
 * network anyone looked at. Read again when someone looks again.
 */
export const STATIC_GTFS_IDLE_MS = 15 * 60_000;
/** The largest static GTFS download (Renfe Cercanías' zip is ~14 MB). */
export const MAX_STATIC_GTFS_BYTES = 120 * 1024 * 1024;

export class LiveHub {
  private readonly index = new LiveTileIndex();
  private readonly states: SourceState[];
  private readonly rooms = new RoomRegistry<LiveKind>();
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
      gtfs: null,
      gtfsLoading: null,
      gtfsDueAt: 0,
      gtfsFailures: 0,
      gtfsUnneededSince: null,
      matches: new Map(),
      settings,
      leader: !options.bus,
      epoch: 0,
      heardEpoch: 0,
      heardAt: 0,
    }));
    this.bus = options.bus ?? null;
  }

  private readonly bus: LiveBus | null;
  /** Every task's watched room keys, as of the last {@link coordinate}. */
  /** Every task's demand entries (`demandEntries`), as of the last {@link coordinate}. */
  private clusterDemand = new Set<string>();
  /** The bus failed: this process polls on its own until it answers again. */
  private busDown = false;
  private coordinateTimer: ReturnType<typeof setInterval> | null = null;
  private coordinating: Promise<void> | null = null;

  /** Whether this process polls a source: it holds the lease, or there is nobody to share with. */
  private leads(state: SourceState): boolean {
    return !this.bus || this.busDown || state.leader;
  }

  /** Whether this task currently polls a source (tests, `GET /live/sources` diagnostics). */
  isLeader(sourceId: string): boolean {
    const state = this.states.find((candidate) => candidate.definition.id === sourceId);
    return state ? this.leads(state) : false;
  }

  /**
   * A bus call, bounded. Unanswered within a third of the lease it counts as
   * a failure — the task polls on its own — rather than leaving a follower
   * neither polling nor hearing for as long as the client takes to give up
   * (measured: ~10.7 s per command with Valkey stopped; minutes on a silent
   * partition, long enough for the lease to pass to a second poller).
   */
  private leaseMs(): number {
    return this.options.cluster?.leaseMs ?? LEASE_MS;
  }

  private bounded<T>(work: Promise<T>): Promise<T> {
    const ms = this.options.cluster?.callTimeoutMs ?? Math.round(this.leaseMs() / 3);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`live bus: no answer within ${ms} ms`)), ms);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private busFailed(error: unknown): void {
    // Replace connections the client has given up on (Bun's never come back).
    this.bus?.recover();
    if (!this.busDown) {
      this.options.logger?.warn(
        { reason: describe(error) },
        'Live bus unreachable; polling locally until it answers',
      );
    }
    this.busDown = true;
  }

  /**
   * Share demand, take or renew the leases of the sources somebody watches,
   * give up the others. Runs every {@link COORDINATE_MS} from `start()`; a test
   * awaits it.
   */
  coordinate(): Promise<void> {
    if (!this.bus || this.stopped) return Promise.resolve();
    if (this.coordinating) return this.coordinating;
    const bus = this.bus;
    const run = (async () => {
      try {
        // Not listening (the first connect failed, or the subscriber's
        // connection dropped and came back deaf): listen again and catch up
        // BEFORE giving up local polling — a follower that cannot hear the
        // leader must not stop polling.
        if (!bus.isSubscribed()) await this.join(bus);
        this.clusterDemand = await this.bounded(
          bus.exchangeDemand(
            demandEntries(
              this.states.map((state) => state.definition),
              (definition) => this.localDemandFor(definition),
            ),
            this.options.cluster?.demandTtlMs ?? DEMAND_TTL_MS,
          ),
        );
        for (const state of this.states) {
          const wanted = this.demandFor(state.definition).length > 0;
          if (wanted) {
            state.epoch = await this.bounded(bus.lease(state.definition.id, this.leaseMs()));
            state.leader = state.epoch > 0;
            if (state.leader) state.heardEpoch = Math.max(state.heardEpoch, state.epoch);
          } else if (state.leader) {
            await this.bounded(bus.release(state.definition.id));
            state.leader = false;
            state.epoch = 0;
          }
        }
        // The heartbeat: every source this task holds, with its epoch.
        const epochs: Record<string, number> = {};
        for (const state of this.states)
          if (state.leader) epochs[state.definition.id] = state.epoch;
        if (Object.keys(epochs).length > 0)
          await this.bounded(bus.publish({ type: 'epochs', from: bus.taskId, epochs }));
        if (this.busDown) {
          this.options.logger?.info({}, 'Live bus answering again; sharing polls');
          this.busDown = false;
          // While down, every task polled; now the leases decide again.
        }
      } catch (error) {
        this.busFailed(error);
      }
    })().finally(() => {
      this.coordinating = null;
    });
    this.coordinating = run;
    return run;
  }

  /** Join the other tasks: listen, then ask the leaders for what they hold. */
  async connect(): Promise<void> {
    if (!this.bus) return;
    try {
      await this.join(this.bus);
    } catch (error) {
      this.busFailed(error);
    }
  }

  private async join(bus: LiveBus): Promise<void> {
    await this.bounded(bus.subscribe((message) => this.receive(message)));
    await this.bounded(bus.publish({ type: 'sync', from: bus.taskId }));
  }

  /** Another task's message. */
  receive(message: LiveClusterMessage): void {
    if (this.stopped || !this.bus) return;
    if (message.type === 'sync') {
      for (const state of this.states) {
        if (!state.leader || this.busDown) continue;
        const entities = this.index
          .idsOfSource(state.definition.id)
          .map((id) => this.index.get(id))
          .filter((entity): entity is LiveEntity => entity !== undefined);
        void this.bounded(
          this.bus.publish({
            type: 'state',
            from: this.bus.taskId,
            sourceId: state.definition.id,
            entities,
            lastSuccessAt: state.lastSuccessAt,
            failures: state.failures,
            epoch: state.epoch,
          }),
        ).catch((error: unknown) => this.busFailed(error));
      }
      return;
    }
    if (message.type === 'epochs') {
      for (const [sourceId, epoch] of Object.entries(message.epochs)) {
        const state = this.states.find((candidate) => candidate.definition.id === sourceId);
        if (state && !this.leads(state)) this.hear(state, epoch);
      }
      return;
    }
    const state = this.states.find((candidate) => candidate.definition.id === message.sourceId);
    // Not configured here, or this task polls it itself.
    if (!state || this.leads(state)) return;
    if (!this.hear(state, message.epoch)) return;
    if (message.type === 'status') {
      state.failures = message.failures;
      state.lastSuccessAt = message.lastSuccessAt;
    } else {
      state.failures = message.type === 'state' ? message.failures : 0;
      state.lastSuccessAt = message.lastSuccessAt;
      this.apply(state, message.entities);
    }
    this.notifySources();
  }

  /**
   * Whether a message stamped `epoch` is from the current holder, marking it
   * heard. One from a holder older than one already heard — a publish
   * abandoned at its deadline and delivered late, after the lease moved on —
   * is not, unless the newer holder has been silent (no poll, no heartbeat)
   * for a whole lease: then the counter went backwards (a Valkey failover
   * lost it) and the mark goes with it, rather than leave this task deaf to
   * the only leader there is. A live leader heartbeats every round, so the
   * window never opens while it lives.
   */
  private hear(state: SourceState, epoch: number): boolean {
    const silentFor = this.now() - state.heardAt;
    if (epoch < state.heardEpoch && silentFor < this.leaseMs()) return false;
    state.heardEpoch = epoch;
    state.heardAt = this.now();
    return true;
  }

  // ── Watchers ──────────────────────────────────────────────────────────────

  /**
   * Set what a watcher is in, replacing what it was in. Returns the rooms it
   * JOINED (to snapshot) and LEFT. The rooms say nothing about who the watcher
   * is and are never logged.
   */
  watch(
    watcherId: string,
    rooms: readonly Room<LiveKind>[],
  ): { joined: Room<LiveKind>[]; left: Room<LiveKind>[] } {
    return this.rooms.watch(watcherId, rooms);
  }

  unwatch(watcherId: string): void {
    this.rooms.unwatch(watcherId);
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
        completeness: definition.completeness,
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

  /**
   * The rooms THIS task's sockets watch inside a source's coverage, of its
   * kind: exact, never shared. A regional transit room counts only for a
   * source that may carry rail (the only vehicles in it, `liveRoomZoomsOf`);
   * for `shapes`, only the rooms a client asks shapes in
   * (`LIVE_SHAPES_MIN_ZOOM`: the finest transit level).
   */
  private localDemandFor(
    definition: LiveSourceDefinition,
    purpose: 'poll' | 'shapes' = 'poll',
  ): GeoBoundingBox[] {
    const boxes: GeoBoundingBox[] = [];
    const levels = LIVE_ROOM_ZOOMS[definition.kind];
    const finest = levels[levels.length - 1];
    const regional =
      !definition.transitModes || definition.transitModes.some(isRegionalTransitMode);
    for (const key of this.rooms.keys()) {
      const room = parseRoom<LiveKind>(key);
      if (room.kind !== definition.kind) continue;
      if (room.kind === 'transit') {
        const zoom = Number(room.tile.slice(0, room.tile.indexOf('/')));
        if (zoom !== finest && (purpose === 'shapes' || !regional)) continue;
      }
      const box = liveTileBounds(room.tile);
      // Its operator's stops, not one box round them all (`areas.ts`).
      if (!meetsSource(definition, box)) continue;
      boxes.push(box);
    }
    return boxes;
  }

  /**
   * Where a source is wanted: this task's rooms, and — with a bus — what the
   * other tasks said they want (`demandEntries`): the source by id, or for a
   * regional feed its z6 regions.
   */
  private demandFor(definition: LiveSourceDefinition): GeoBoundingBox[] {
    const boxes = this.localDemandFor(definition);
    for (const entry of this.clusterDemand) {
      const [id, region] = entry.split('@') as [string, string | undefined];
      if (id !== definition.id) continue;
      // A whole-feed source needs no region; its coverage stands for "wanted".
      boxes.push(region ? liveTileBounds(region) : (definition.coverage ?? WORLD));
    }
    return boxes;
  }

  // ── The clock ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = unref(setInterval(() => void this.tick(), TICK_MS));
    if (this.bus) {
      void this.connect().then(() => this.coordinate());
      this.coordinateTimer = unref(
        setInterval(
          () => void this.coordinate(),
          this.options.cluster?.coordinateMs ?? COORDINATE_MS,
        ),
      );
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.coordinateTimer) clearInterval(this.coordinateTimer);
    this.timer = null;
    this.coordinateTimer = null;
    for (const state of this.states) state.abort?.abort();
    // Hand the leases over now rather than after they expire (when the bus
    // answers), and close its connections whatever its state.
    const bus = this.bus;
    if (bus) {
      const releases = this.busDown
        ? []
        : this.states
            .filter((state) => state.leader)
            .map((state) => bus.release(state.definition.id).catch(() => {}));
      void Promise.all(releases).finally(() => void bus.close().catch(() => {}));
    }
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
        this.keepStatic(state, false, now);
        if (state.idleSince === null && state.everActive) state.idleSince = now;
        if (state.idleSince !== null && now - state.idleSince > IDLE_GRACE_MS) {
          this.release(state);
        }
        continue;
      }
      state.idleSince = null;
      state.everActive = true;
      // The static GTFS is read by the leader (to put vehicles on their
      // tracks) and by a task whose own viewers are close enough to ask it
      // for shapes — not by every task the source is wanted somewhere for,
      // nor for a regional view, which never asks.
      const needsStatic =
        this.leads(state) || this.localDemandFor(state.definition, 'shapes').length > 0;
      this.keepStatic(state, needsStatic, now);
      if (
        needsStatic &&
        state.definition.staticGtfs &&
        !state.gtfsLoading &&
        now >= state.gtfsDueAt
      ) {
        started.push(this.loadStatic(state));
      }
      // Another task polls it and publishes what it gets (`receive`).
      if (!this.leads(state)) continue;
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
      .poll({
        signal: abort.signal,
        fetch: this.options.fetch,
        now: this.now,
        demand,
        staticGtfs: state.gtfs,
      })
      .then(
        (result) => {
          if (this.stopped) return;
          state.failures = 0;
          state.lastSuccessAt = this.now();
          state.nextDueAt =
            startedAt +
            Math.max(state.definition.pollIntervalSeconds, result.backoffSeconds ?? 0) * 1000;
          const entities = this.enrich(state, result.entities, result.hints);
          this.apply(state, entities);
          this.share({
            type: 'poll',
            sourceId: state.definition.id,
            entities,
            lastSuccessAt: state.lastSuccessAt,
            epoch: state.epoch,
          });
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
          this.share({
            type: 'status',
            sourceId: state.definition.id,
            failures: state.failures,
            lastSuccessAt: state.lastSuccessAt,
            epoch: state.epoch,
          });
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

  /** Publish a leader's news to the other tasks; a failure falls back to polling locally. */
  private share(
    message:
      | Omit<Extract<LiveClusterMessage, { type: 'poll' }>, 'from'>
      | Omit<Extract<LiveClusterMessage, { type: 'status' }>, 'from'>,
  ): void {
    if (!this.bus || this.busDown) return;
    void this.bounded(
      this.bus.publish({ ...message, from: this.bus.taskId } as LiveClusterMessage),
    ).catch((error: unknown) => this.busFailed(error));
  }

  /** Let a source's static GTFS go once this task has not needed it for {@link STATIC_GTFS_IDLE_MS}. */
  private keepStatic(state: SourceState, needed: boolean, now: number): void {
    if (needed || !state.gtfs) {
      state.gtfsUnneededSince = null;
      return;
    }
    state.gtfsUnneededSince ??= now;
    if (now - state.gtfsUnneededSince < STATIC_GTFS_IDLE_MS || state.gtfsLoading) return;
    state.gtfs = null;
    state.gtfsDueAt = 0;
    state.gtfsUnneededSince = null;
    state.matches.clear();
  }

  /** Fetch (or refresh) a source's static GTFS; a failure retries with backoff and never stops the feed. */
  private loadStatic(state: SourceState): Promise<void> {
    const location = state.definition.staticGtfs;
    if (!location) return Promise.resolve();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    const read = (url: string) =>
      getBytes(
        this.options.fetch,
        url,
        abort.signal,
        { 'user-agent': state.settings.userAgent },
        MAX_STATIC_GTFS_BYTES,
      );
    // A ranged GET: 206 with the part asked for, or 200 with the whole file
    // from a server that ignores ranges (bounded like any static download).
    const readRange = async (url: string, range: string) => {
      const response = await this.options.fetch(url, {
        signal: abort.signal,
        // A range of the archive itself: a server that gzips on the fly
        // (TransLink Queensland's) otherwise ranges over its gzip stream.
        headers: { 'user-agent': state.settings.userAgent, range, 'accept-encoding': 'identity' },
      });
      if (response.status !== 206 && (response.status < 200 || response.status >= 300))
        throw new LiveUpstreamError(`upstream answered ${response.status}`, null, response.status);
      const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(length) && length > MAX_STATIC_GTFS_BYTES)
        throw new LiveUpstreamError(`upstream body too large (${length} bytes)`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_STATIC_GTFS_BYTES)
        throw new LiveUpstreamError(`upstream body too large (${bytes.byteLength} bytes)`);
      return { bytes, partial: response.status === 206 };
    };
    const run = loadStaticGtfs(location, read, readRange)
      .then(
        (gtfs) => {
          state.gtfs = gtfs;
          state.gtfsFailures = 0;
          state.gtfsDueAt = this.now() + STATIC_GTFS_REFRESH_MS;
          this.options.logger?.info(
            { source: state.definition.id, shapes: gtfs.shapes.size, trips: gtfs.trips.size },
            'Live source static GTFS loaded',
          );
        },
        (error: unknown) => {
          state.gtfsFailures++;
          state.gtfsDueAt =
            this.now() + Math.min(STATIC_GTFS_REFRESH_MS, 60_000 * 2 ** state.gtfsFailures);
          this.options.logger?.warn(
            { source: state.definition.id, reason: redact(describe(error), state.secrets) },
            'Live source static GTFS failed to load',
          );
        },
      )
      .finally(() => {
        clearTimeout(timer);
        state.gtfsLoading = null;
      });
    state.gtfsLoading = run;
    return run;
  }

  /** Line colours and track matches from the static GTFS; the reported position is never changed. */
  private enrich(
    state: SourceState,
    entities: readonly LiveEntity[],
    hints: Map<string, MatchHint> | undefined,
  ): LiveEntity[] {
    const gtfs = state.gtfs;
    if (!gtfs) return [...entities];
    return entities.map((entity) => {
      // An estimate is already on its shape, by construction.
      if (entity.kind !== 'transit' || entity.positionBasis === 'estimated') return entity;
      const match = matchTrack(
        gtfs,
        hints?.get(entity.id) ?? {},
        entity.position,
        state.matches.get(entity.id) ?? null,
      );
      if (match.track)
        state.matches.set(entity.id, {
          shapeId: match.track.shapeId,
          along: match.track.alongMeters,
        });
      else state.matches.delete(entity.id);
      return {
        ...entity,
        line: entity.line ?? match.route?.shortName ?? match.route?.longName?.slice(0, 32) ?? null,
        // The route's own mode when its static file says it (a multimodal
        // feed: Helsinki's buses, trams, metro and ferries in one).
        mode: match.route?.mode ?? entity.mode,
        lineColor: match.route?.color ?? null,
        lineTextColor: match.route?.textColor ?? null,
        track: match.track,
        trackStatus: match.trackStatus,
      };
    });
  }

  /** One of a source's static shapes, as the operator published it; `null` when unknown. */
  shape(sourceId: string, shapeId: string): LiveShape | null {
    const state = this.states.find((candidate) => candidate.definition.id === sourceId);
    const shape = state?.gtfs?.shapes.get(shapeId);
    if (!shape) return null;
    const coordinates: [number, number][] = [];
    const alongMeters: number[] = [];
    for (let i = 0; i < shape.lat.length; i++) {
      coordinates.push([round6(shape.lon[i] as number), round6(shape.lat[i] as number)]);
      alongMeters.push(Math.round((shape.along[i] as number) * 10) / 10);
    }
    return {
      sourceId,
      id: shapeId,
      coordinates,
      alongMeters,
      lengthMeters: Math.round(shape.length * 10) / 10,
    };
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
      for (const id of state.matches.keys()) if (!seen.has(id)) state.matches.delete(id);
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
    state.matches.clear();
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
    const perRoom = new Map<
      string,
      { upserts: Map<string, LiveEntity>; moves: Map<string, LiveEntity>; removes: Set<string> }
    >();
    for (const change of changes) {
      if (!this.rooms.has(change.room)) continue;
      let room = perRoom.get(change.room);
      if (!room) {
        room = { upserts: new Map(), moves: new Map(), removes: new Set() };
        perRoom.set(change.room, room);
      }
      if (change.type === 'upsert') {
        room.removes.delete(change.entity.id);
        room.moves.delete(change.entity.id);
        room.upserts.set(change.entity.id, change.entity);
      } else if (change.type === 'move') {
        // A move after an upsert in the same batch is still news the client
        // has not had: it rides in the upsert.
        if (room.upserts.has(change.entity.id)) room.upserts.set(change.entity.id, change.entity);
        else room.moves.set(change.entity.id, change.entity);
      } else {
        room.upserts.delete(change.id);
        room.moves.delete(change.id);
        room.removes.add(change.id);
      }
    }
    for (const [key, room] of perRoom) {
      if (room.upserts.size === 0 && room.moves.size === 0 && room.removes.size === 0) continue;
      const { tile, kind } = parseRoom<LiveKind>(key);
      this.options.publish({
        tile,
        kind,
        at,
        upserts: [...room.upserts.values()],
        moves: [...room.moves.values()].map(moveOf),
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

const WORLD: GeoBoundingBox = { west: -180, south: -85, east: 180, north: 85 };

/**
 * The zoom a REGIONAL feed's demand is shared at (the aircraft feed, polled
 * per z6 region by `readsb.ts → planRegions`): ~5.6° of longitude.
 */
export const SHARED_REGION_ZOOM = 6;

/**
 * What a task tells the others it wants — computed from its exact rooms,
 * which never leave the process:
 *
 * - `<sourceId>` for every source one of its rooms falls in (a source id
 *   says no more than the source's coverage, ~a city or a country);
 * - `<sourceId>@<z6 tile>` for a regional feed (`partialPolls`), whose leader
 *   polls one region per z6 tile anyway.
 *
 * So a viewer in Philadelphia asks for no New York feed: the decision is made
 * on the exact rooms, here, not on a coarse tile somewhere else.
 */
export function demandEntries(
  definitions: readonly LiveSourceDefinition[],
  localDemandFor: (definition: LiveSourceDefinition) => readonly GeoBoundingBox[],
): string[] {
  const out = new Set<string>();
  for (const definition of definitions) {
    const boxes = localDemandFor(definition);
    if (boxes.length === 0) continue;
    if (!definition.partialPolls) {
      out.add(definition.id);
      continue;
    }
    for (const box of boxes) {
      const lat = (box.south + box.north) / 2;
      const lon = (box.west + box.east) / 2;
      out.add(`${definition.id}@${regionTileOf(lat, lon)}`);
    }
  }
  return [...out];
}

function regionTileOf(latitude: number, longitude: number): string {
  const n = 2 ** SHARED_REGION_ZOOM;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((longitude + 180) / 360) * n)));
  const radians = (Math.max(-85.05, Math.min(85.05, latitude)) * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.max(
      0,
      Math.floor(((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * n),
    ),
  );
  return `${SHARED_REGION_ZOOM}/${x}/${y}`;
}

/** A timer that never keeps the process alive: shutdown closes the server and exits. */
function unref<T>(handle: T): T {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    const fn = (handle as { unref?: unknown }).unref;
    if (typeof fn === 'function') fn.call(handle);
  }
  return handle;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
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
