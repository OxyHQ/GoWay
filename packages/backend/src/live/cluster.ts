/**
 * GoWay Live across several API tasks: ONE task polls each feed, every task
 * serves its own sockets.
 *
 * Without this, each backend task polled every feed on its own — N tasks, N×
 * the upstream requests and N× the rate limits (`docs/MAP_LIVE.md` → What
 * production needs). With it, the tasks share a {@link LiveBus} (Valkey, in
 * production `REDIS_URL`):
 *
 * - **Demand** — each task reports the rooms its sockets watch (room tiles ×
 *   kinds: coarse public tiles, never a viewport, no viewer), kept for
 *   {@link DEMAND_TTL_MS}; every task reads the union. A feed is wanted while
 *   ANY task has a viewer in its coverage.
 * - **Leadership** — per source, a lease (`SET NX PX`, renewed by its holder)
 *   picks the one task that polls it. A leader that dies stops renewing; the
 *   lease expires after {@link LEASE_MS} and the next task to look takes it
 *   and polls at once. Nothing is lost but a poll or two.
 * - **Fan-out** — the leader publishes each poll's answer (the enriched
 *   entities, gzip-compressed) and every other task applies it to its own
 *   index exactly as if it had polled, then tells its own sockets. A task that
 *   starts asks the leaders to republish what they hold (`sync`).
 *
 * Positions pass through Valkey's pub/sub and are never stored there: the
 * only keys are the leases and the per-task demand, both with a TTL.
 *
 * When the bus fails (Valkey unreachable), every task falls back to polling
 * on its own — duplicate upstream requests for the duration, but live keeps
 * working; it is logged once per outage.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import type { LiveEntity } from '@goway/contracts';
import { RedisClient } from 'bun';

/** A lease outlives its holder by this long at most. */
export const LEASE_MS = 15_000;
/** How often a task renews its leases, reports its demand and reads everyone's. */
export const COORDINATE_MS = 2_000;
/** A task's reported demand expires after this (it renews every `COORDINATE_MS`). */
export const DEMAND_TTL_MS = 10_000;

export type LiveClusterMessage =
  /** A leader's poll answered: the source's entities, as the leader applied them. */
  | {
      type: 'poll';
      from: string;
      sourceId: string;
      /** A full answer replaces what a follower holds (unless the source's polls are partial). */
      entities: LiveEntity[];
      lastSuccessAt: number;
    }
  /** A leader's poll failed: its status, so every task reports the same. */
  | {
      type: 'status';
      from: string;
      sourceId: string;
      failures: number;
      lastSuccessAt: number | null;
    }
  /** A task started: leaders, republish what you hold. */
  | { type: 'sync'; from: string }
  /** A leader's answer to `sync`: what it holds now. */
  | {
      type: 'state';
      from: string;
      sourceId: string;
      entities: LiveEntity[];
      lastSuccessAt: number | null;
      failures: number;
    };

/** The shared medium. `ValkeyLiveBus` in production, `MemoryLiveBus` in tests. */
export interface LiveBus {
  /** This task's id: unique per process. */
  readonly taskId: string;
  publish(message: LiveClusterMessage): Promise<void>;
  /**
   * Every message from OTHER tasks. Resolves once subscribed. Calling it again
   * replaces the subscription (after one was lost).
   */
  subscribe(handler: (message: LiveClusterMessage) => void): Promise<void>;
  /**
   * Whether the subscription is in place NOW. False before `subscribe`, after
   * it failed, and once its connection dropped — a reconnected Valkey client
   * does not restore its subscriptions, so the hub subscribes again.
   */
  isSubscribed(): boolean;
  /**
   * After a failed or timed-out call: replace connections that are no longer
   * connected. Bun's client gives up after a long outage and stays failed
   * even once Valkey is back (measured: a 10 s stop of redis-server left both
   * clients answering `ERR_REDIS_CONNECTION_CLOSED` for good, while a fresh
   * client answered at once).
   */
  recover(): void;
  /** Take or renew a source's lease; true while this task holds it. */
  lease(sourceId: string, ttlMs: number): Promise<boolean>;
  release(sourceId: string): Promise<void>;
  /** Report this task's watched room keys; returns the union over every live task. */
  exchangeDemand(rooms: readonly string[], ttlMs: number): Promise<Set<string>>;
  close(): Promise<void>;
}

export function encodeMessage(message: LiveClusterMessage): string {
  return gzipSync(Buffer.from(JSON.stringify(message))).toString('base64');
}

export function decodeMessage(text: string): LiveClusterMessage | null {
  try {
    const value = JSON.parse(gunzipSync(Buffer.from(text, 'base64')).toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const message = value as { type?: unknown; from?: unknown };
    if (typeof message.from !== 'string') return null;
    if (!['poll', 'status', 'sync', 'state'].includes(String(message.type))) return null;
    return value as LiveClusterMessage;
  } catch {
    return null;
  }
}

export function newTaskId(): string {
  return `${process.pid.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Valkey
// ---------------------------------------------------------------------------

/** The Valkey commands used, as Bun's built-in client speaks them. */
interface RedisLike {
  send(command: string, args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<unknown>;
  close(): void;
  /** Called on every (re)connect. */
  onconnect?: (() => void) | null;
  /** Called when the connection closes (Bun: once it has given up reconnecting). */
  onclose?: ((error?: unknown) => void) | null;
  /** Whether the connection is up now. */
  readonly connected?: boolean;
}

const LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export class ValkeyLiveBus implements LiveBus {
  readonly taskId: string;
  private readonly channel: string;
  private commands: RedisLike;
  private subscriber: RedisLike | null = null;
  private subscribed = false;

  constructor(
    /** A new connection: the command one, and one per subscription. */
    private readonly connect: () => RedisLike,
    private readonly prefix = 'goway:live',
    taskId = newTaskId(),
  ) {
    this.taskId = taskId;
    this.channel = `${prefix}:bus`;
    this.commands = connect();
  }

  /** Connections to `url`, made lazily (a subscriber cannot send commands, so it has its own). */
  static fromUrl(url: string, prefix?: string): ValkeyLiveBus {
    return new ValkeyLiveBus(() => new RedisClient(url) as unknown as RedisLike, prefix);
  }

  isSubscribed(): boolean {
    return this.subscribed && this.subscriber?.connected !== false;
  }

  recover(): void {
    if (this.commands.connected === false) {
      this.commands.close();
      this.commands = this.connect();
    }
    // A dead subscriber is not listening; `subscribe` replaces it.
    if (this.subscriber?.connected === false) this.subscribed = false;
  }

  async publish(message: LiveClusterMessage): Promise<void> {
    await this.commands.publish(this.channel, encodeMessage(message));
  }

  async subscribe(handler: (message: LiveClusterMessage) => void): Promise<void> {
    // A fresh connection every time: Bun's client reconnects by itself but
    // does NOT restore subscriptions (measured: a Redis restart left the old
    // subscriber connected and deaf), and re-subscribing on it would double
    // the listener.
    this.subscribed = false;
    this.subscriber?.close();
    const subscriber = this.connect();
    this.subscriber = subscriber;
    let connects = 0;
    subscriber.onconnect = () => {
      connects++;
      // Any connect after the first is a reconnect: the subscription is gone.
      if (connects > 1 && this.subscriber === subscriber) this.subscribed = false;
    };
    subscriber.onclose = () => {
      if (this.subscriber === subscriber) this.subscribed = false;
    };
    await subscriber.subscribe(this.channel, (text) => {
      const message = decodeMessage(text);
      if (message && message.from !== this.taskId) handler(message);
    });
    if (this.subscriber === subscriber) this.subscribed = true;
  }

  async lease(sourceId: string, ttlMs: number): Promise<boolean> {
    const held = await this.commands.send('EVAL', [
      LEASE_SCRIPT,
      '1',
      `${this.prefix}:lease:${sourceId}`,
      this.taskId,
      String(ttlMs),
    ]);
    return Number(held) === 1;
  }

  async release(sourceId: string): Promise<void> {
    await this.commands.send('EVAL', [
      RELEASE_SCRIPT,
      '1',
      `${this.prefix}:lease:${sourceId}`,
      this.taskId,
    ]);
  }

  async exchangeDemand(rooms: readonly string[], ttlMs: number): Promise<Set<string>> {
    const now = Date.now();
    const tasks = `${this.prefix}:tasks`;
    await this.commands.send('SET', [
      `${this.prefix}:demand:${this.taskId}`,
      JSON.stringify(rooms),
      'PX',
      String(ttlMs),
    ]);
    await this.commands.send('ZADD', [tasks, String(now), this.taskId]);
    await this.commands.send('ZREMRANGEBYSCORE', [tasks, '-inf', String(now - ttlMs)]);
    // The set expires too, should every task stop.
    await this.commands.send('PEXPIRE', [tasks, String(ttlMs * 3)]);
    const ids = (await this.commands.send('ZRANGEBYSCORE', [
      tasks,
      String(now - ttlMs),
      '+inf',
    ])) as string[];
    const out = new Set(rooms);
    if (!Array.isArray(ids) || ids.length === 0) return out;
    const values = (await this.commands.send(
      'MGET',
      ids.map((id) => `${this.prefix}:demand:${id}`),
    )) as (string | null)[];
    for (const value of values ?? []) {
      if (typeof value !== 'string') continue;
      try {
        for (const room of JSON.parse(value) as unknown[])
          if (typeof room === 'string') out.add(room);
      } catch {
        // A malformed entry is somebody else's bug; it adds no demand.
      }
    }
    return out;
  }

  async close(): Promise<void> {
    this.subscribed = false;
    const subscriber = this.subscriber;
    // Cleared first: its `onclose` then finds it is no longer ours.
    this.subscriber = null;
    this.commands.close();
    subscriber?.close();
  }
}

// ---------------------------------------------------------------------------
// In memory (tests): one "Valkey" shared by several buses in one process
// ---------------------------------------------------------------------------

export class MemoryLiveNetwork {
  readonly leases = new Map<string, { owner: string; until: number }>();
  readonly demand = new Map<string, { rooms: string[]; until: number }>();
  readonly handlers = new Map<string, (message: LiveClusterMessage) => void>();
  /** Buses closed, by task id. */
  readonly closed = new Set<string>();
  /** Set false to simulate Valkey being unreachable (calls fail at once). */
  up = true;
  /** Set true to simulate a silent partition: calls never answer. */
  hang = false;
  /** Times a bus asked to recover its connections. */
  recoveries = 0;

  /** Valkey goes away: every connection drops, and with it every subscription. */
  disconnect(): void {
    this.up = false;
    this.handlers.clear();
  }

  constructor(readonly now: () => number = Date.now) {}

  bus(taskId: string): LiveBus {
    const network = this;
    const check = async () => {
      if (network.hang) await new Promise(() => {});
      if (!network.up) throw new Error('bus down');
    };
    return {
      taskId,
      async publish(message) {
        await check();
        // Through the wire format, as Valkey would carry it.
        const text = encodeMessage(message);
        for (const [id, handler] of network.handlers) {
          if (id === taskId) continue;
          const decoded = decodeMessage(text);
          if (decoded) handler(decoded);
        }
      },
      async subscribe(handler) {
        await check();
        network.handlers.set(taskId, handler);
      },
      isSubscribed() {
        return network.up && network.handlers.has(taskId);
      },
      recover() {
        network.recoveries++;
      },
      async lease(sourceId, ttlMs) {
        await check();
        const now = network.now();
        const current = network.leases.get(sourceId);
        if (current && current.owner !== taskId && current.until > now) return false;
        network.leases.set(sourceId, { owner: taskId, until: now + ttlMs });
        return true;
      },
      async release(sourceId) {
        await check();
        if (network.leases.get(sourceId)?.owner === taskId) network.leases.delete(sourceId);
      },
      async exchangeDemand(rooms, ttlMs) {
        await check();
        const now = network.now();
        network.demand.set(taskId, { rooms: [...rooms], until: now + ttlMs });
        const out = new Set<string>();
        for (const entry of network.demand.values())
          if (entry.until > now) for (const room of entry.rooms) out.add(room);
        return out;
      },
      async close() {
        network.handlers.delete(taskId);
        network.demand.delete(taskId);
        network.closed.add(taskId);
      },
    };
  }
}
