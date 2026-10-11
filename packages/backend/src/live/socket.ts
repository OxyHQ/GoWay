/**
 * The live layer's Socket.IO binding: the `/live` namespace.
 *
 * ## Signed out is the normal case
 *
 * The map opens without an account and browsing it is public (AGENTS.md →
 * Privacy), so this namespace has NO auth middleware. That is not a hole in
 * `realtime.ts`'s rule — "rooms derive from the authenticated user, never
 * from the client" — because nothing here is per-user: a room is a public
 * tile and a kind, computed BY THE SERVER from a box it validated
 * (`liveTilesFor`), and every room holds the same public data for everyone.
 * `io.use(oxyClient.middleware.socket())` guards the default namespace only,
 * which is exactly the per-user surface.
 *
 * ## What is never kept
 *
 * The viewport a client subscribes with is used to pick rooms and dropped.
 * It is not stored beside the socket, not counted per address and never
 * logged — a map viewport is not the viewer's location, but it is often near
 * it, and it is nobody's business either way.
 *
 * ## Limits
 *
 *  - connections: `LIVE_MAX_CONNECTIONS` per process; beyond it the handshake
 *    is refused with `live_capacity`;
 *  - subscriptions: a token bucket per socket (`LIVE_SUBSCRIBE_BURST`,
 *    `LIVE_SUBSCRIBE_PER_MINUTE`) — a client pans continuously, and should
 *    debounce; one that does not is told `rate_limited` and keeps its rooms;
 *  - size: a box covering more than `LIVE_MAX_ROOM_TILES` rooms is `too_wide`.
 */

import {
  LIVE_SOCKET_EVENTS,
  LIVE_SOCKET_NAMESPACE,
  type LiveKind,
  type LiveSubscriptionState,
  liveSubscriptionSchema,
  liveTilesFor,
} from '@goway/contracts';
import type { Namespace, Server as SocketIOServer, Socket } from 'socket.io';
import type { LiveConfig } from '../config/live';
import type { LiveHub } from './hub';

export function liveRoomName(tile: string, kind: LiveKind): string {
  return `live:${tile}:${kind}`;
}

/** A token bucket: `capacity` at most, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  /** Spend one; `0` when granted, else the seconds until one is available. */
  take(): number {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.updatedAt) / 1000) * this.perSecond,
    );
    this.updatedAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - this.tokens) / this.perSecond));
  }
}

export interface AttachLiveOptions {
  hub: LiveHub;
  config: Pick<LiveConfig, 'maxConnections' | 'subscribeBurst' | 'subscribePerMinute'>;
  now?: () => number;
}

export function attachLiveNamespace(io: SocketIOServer, options: AttachLiveOptions): Namespace {
  const { hub, config } = options;
  const namespace = io.of(LIVE_SOCKET_NAMESPACE);

  namespace.use((_socket, next) => {
    // `sockets` holds the connected ones; this handshake is not among them yet.
    if (namespace.sockets.size >= config.maxConnections) {
      next(new Error('live_capacity'));
      return;
    }
    next();
  });

  namespace.on('connection', (socket: Socket) => {
    const bucket = new TokenBucket(
      config.subscribeBurst,
      config.subscribePerMinute / 60,
      options.now,
    );
    // What this socket is in, as the server decided it — never the box.
    let tiles: string[] = [];
    let kinds: LiveKind[] = [];

    const answer = (state: LiveSubscriptionState) =>
      socket.emit(LIVE_SOCKET_EVENTS.subscription, state);

    socket.emit(LIVE_SOCKET_EVENTS.sources, { items: hub.sources(), nextCursor: null });

    socket.on(LIVE_SOCKET_EVENTS.subscribe, (payload: unknown) => {
      const wait = bucket.take();
      if (wait > 0) {
        answer({ state: 'rate_limited', tiles, kinds, retryAfterSeconds: wait });
        return;
      }
      const parsed = liveSubscriptionSchema.safeParse(payload);
      if (!parsed.success) {
        answer({ state: 'invalid', tiles, kinds, retryAfterSeconds: null });
        return;
      }
      const subscription = parsed.data;
      const nextKinds = [...new Set(subscription.kinds)];
      // No kinds: leave everything, whatever the box.
      const covered = nextKinds.length === 0 ? [] : liveTilesFor(subscription);
      const nextTiles = covered ?? [];
      const rooms = nextTiles.flatMap((tile) => nextKinds.map((kind) => ({ tile, kind })));
      const { joined, left } = hub.watch(socket.id, rooms);
      for (const room of left) void socket.leave(liveRoomName(room.tile, room.kind));
      for (const room of joined) void socket.join(liveRoomName(room.tile, room.kind));
      tiles = nextTiles;
      kinds = covered ? nextKinds : [];
      answer({
        state: covered ? 'ok' : 'too_wide',
        tiles,
        kinds,
        retryAfterSeconds: null,
      });
      // After the answer, so a client knows which rooms the snapshots belong to.
      for (const room of joined)
        socket.emit(LIVE_SOCKET_EVENTS.snapshot, hub.snapshot(room.tile, room.kind));
    });

    socket.on('disconnect', () => hub.unwatch(socket.id));
  });

  return namespace;
}
