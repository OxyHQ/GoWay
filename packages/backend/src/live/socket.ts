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
 *  - connections: `maxConnections` per process (`LIVE_POLICY`); beyond it the
 *    handshake is refused with `live_capacity`;
 *  - subscriptions: a token bucket per socket (`subscribeBurst`,
 *    `subscribePerMinute`) — a client pans continuously, and should
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
import { packLivePayload } from './pack';

export function liveRoomName(tile: string, kind: LiveKind): string {
  return `live:${tile}:${kind}`;
}

/** The socket.io room of the sockets told of one source's changes. */
export function liveSourceRoomName(sourceId: string): string {
  return `live-source:${sourceId}`;
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

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.updatedAt) / 1000) * this.perSecond,
    );
    this.updatedAt = now;
  }

  /** `0` when one is available now, else the seconds until one is — spending nothing. */
  peek(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - this.tokens) / this.perSecond));
  }

  /** Spend one; `0` when granted, else the seconds until one is available. */
  take(): number {
    const wait = this.peek();
    if (wait === 0) this.tokens -= 1;
    return wait;
  }
}

/**
 * The client's address: the one the load balancer saw (the last
 * `X-Forwarded-For` hop, as `app.set('trust proxy', 1)` reads it), else the
 * socket's peer. Held in memory only while a socket is open; never logged.
 */
export function clientAddress(socket: Pick<Socket, 'handshake'>): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  const list = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return list[list.length - 1] ?? socket.handshake.address;
}

export interface AttachLiveOptions {
  hub: LiveHub;
  config: Pick<
    LiveConfig,
    | 'maxConnections'
    | 'subscribeBurst'
    | 'subscribePerMinute'
    | 'maxConnectionsPerAddress'
    | 'addressSubscribeBurst'
    | 'addressSubscribePerMinute'
  >;
  now?: () => number;
}

export function attachLiveNamespace(io: SocketIOServer, options: AttachLiveOptions): Namespace {
  const { hub, config } = options;
  const namespace = io.of(LIVE_SOCKET_NAMESPACE);

  // Per address: its sockets, and one subscription bucket they share. An
  // address is held only while it has a socket open, and never logged.
  const addresses = new Map<string, { sockets: number; bucket: TokenBucket }>();
  namespace.use((socket, next) => {
    // `sockets` holds the connected ones; this handshake is not among them yet.
    if (namespace.sockets.size >= config.maxConnections) {
      next(new Error('live_capacity'));
      return;
    }
    const held = addresses.get(clientAddress(socket));
    if (held && held.sockets >= config.maxConnectionsPerAddress) {
      next(new Error('live_address_capacity'));
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
    const address = clientAddress(socket);
    let held = addresses.get(address);
    if (!held) {
      held = {
        sockets: 0,
        bucket: new TokenBucket(
          config.addressSubscribeBurst,
          config.addressSubscribePerMinute / 60,
          options.now,
        ),
      };
      addresses.set(address, held);
    }
    held.sockets++;
    const shared = held;
    // What this socket is in, as the server decided it — never the box.
    let tiles: LiveSubscriptionState['tiles'] = {};
    let sourceRooms = new Set<string>();

    const answer = (state: LiveSubscriptionState) =>
      socket.emit(LIVE_SOCKET_EVENTS.subscription, state);

    socket.emit(
      LIVE_SOCKET_EVENTS.sources,
      packLivePayload({ items: hub.sources(), nextCursor: null }),
    );

    socket.on(LIVE_SOCKET_EVENTS.subscribe, (payload: unknown) => {
      // The socket's own bucket, then its address's: both must allow it.
      const wait = Math.max(bucket.peek(), shared.bucket.peek());
      if (wait === 0) {
        bucket.take();
        shared.bucket.take();
      }
      if (wait > 0) {
        answer({ state: 'rate_limited', tiles, retryAfterSeconds: wait });
        return;
      }
      const parsed = liveSubscriptionSchema.safeParse(payload);
      if (!parsed.success) {
        answer({ state: 'invalid', tiles, retryAfterSeconds: null });
        return;
      }
      const subscription = parsed.data;
      const asked = [...new Set(subscription.kinds)];
      // Each kind's rooms at its own zoom; a kind covering too many is left out.
      const rooms: { tile: string; kind: LiveKind }[] = [];
      const nextTiles: LiveSubscriptionState['tiles'] = {};
      for (const kind of asked) {
        const covered = liveTilesFor(subscription, kind);
        if (!covered) continue;
        nextTiles[kind] = covered;
        for (const tile of covered) rooms.push({ tile, kind });
      }
      const { joined, left } = hub.watch(socket.id, rooms);
      for (const room of left) void socket.leave(liveRoomName(room.tile, room.kind));
      for (const room of joined) void socket.join(liveRoomName(room.tile, room.kind));
      // And the sources those rooms meet, to hear of their status.
      const meeting = new Set(hub.sourcesMeeting(rooms));
      for (const id of sourceRooms) if (!meeting.has(id)) void socket.leave(liveSourceRoomName(id));
      for (const id of meeting) if (!sourceRooms.has(id)) void socket.join(liveSourceRoomName(id));
      sourceRooms = meeting;
      tiles = nextTiles;
      answer({
        // No kinds asked: leave everything, whatever the box — that is `ok`.
        state: asked.length > 0 && rooms.length === 0 ? 'too_wide' : 'ok',
        tiles,
        retryAfterSeconds: null,
      });
      // After the answer, so a client knows which rooms the snapshots belong to.
      for (const room of joined)
        socket.emit(
          LIVE_SOCKET_EVENTS.snapshot,
          packLivePayload(hub.snapshot(room.tile, room.kind)),
        );
    });

    socket.on('disconnect', () => {
      hub.unwatch(socket.id);
      shared.sockets--;
      if (shared.sockets <= 0) addresses.delete(address);
    });
  });

  return namespace;
}
