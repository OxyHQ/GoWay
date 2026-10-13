/**
 * The live socket: one Socket.IO connection to `<API_URL>/live`, signed out.
 *
 * It owns the connection and the subscription; the data goes straight into a
 * {@link LiveStore}. Every message is parsed with the SDK's contract parsers
 * (`@goway.to/sdk/live`) and a message that does not parse is dropped — one
 * bad message must not take the layer down.
 *
 * ## Subscribing politely
 *
 * The map reports a viewport on every settled frame; a user panning fires
 * many. Subscriptions are debounced ({@link SUBSCRIBE_DEBOUNCE_MS}), skipped
 * when nothing would change, and held back for as long as the server asks
 * after a `rate_limited` answer. A viewport wider than the server serves is
 * still SENT (that is how the client leaves its old rooms) and is shown as
 * "zoom in" at once, without waiting for the answer.
 *
 * Nothing about the viewer is sent: the subscription is the visible box, the
 * zoom and the kinds — no location, no session, no identifier.
 *
 * ## Asking only for what is drawn
 *
 * Bike-share docks are drawn from z{@link BIKESHARE_MIN_ZOOM}: below it they
 * are not asked for at all (New York's 2,500 docks were most of a city view's
 * traffic). Large messages arrive as gzip bytes and are inflated
 * (`unpackLivePayload`); because that is asynchronous, every message goes
 * through one queue, so they apply in the order they arrived.
 */

import type { Socket } from 'socket.io-client';
import {
  LIVE_SOCKET_EVENTS,
  LIVE_SOCKET_NAMESPACE,
  type LiveKind,
  liveSubscription,
  liveTilesFor,
  parseLiveDelta,
  unpackLivePayload,
  parseLiveSnapshot,
  parseLiveSources,
  parseLiveSubscriptionState,
} from '@goway.to/sdk/live';

import type { LiveStore } from './liveStore';

export const SUBSCRIBE_DEBOUNCE_MS = 350;
/** Bike-share docks are drawn, and so asked for, from this zoom. */
export const BIKESHARE_MIN_ZOOM = 15;

/** The kinds worth asking for at a zoom. Exported for the tests. */
export function kindsAtZoom(kinds: readonly LiveKind[], zoom: number): LiveKind[] {
  return kinds.filter((kind) => kind !== 'bikeshare' || zoom >= BIKESHARE_MIN_ZOOM);
}

export type LiveConnectionState = 'connecting' | 'connected' | 'offline';
export type LiveCoverageState = 'ok' | 'too_wide' | 'waiting';

export interface LiveClientState {
  connection: LiveConnectionState;
  coverage: LiveCoverageState;
}

export interface LiveView {
  bounds: { west: number; south: number; east: number; north: number };
  zoom: number;
}

export interface LiveClient {
  setView(view: LiveView): void;
  setKinds(kinds: readonly LiveKind[]): void;
  state(): LiveClientState;
  /** Data or state changed. */
  subscribe(listener: () => void): () => void;
  close(): void;
}

/** Clamp a viewport box to valid coordinates: MapLibre reports longitudes past ±180 when the world repeats. */
export function normaliseBounds(bounds: LiveView['bounds']): LiveView['bounds'] {
  const clampLat = (value: number) => Math.max(-85, Math.min(85, value));
  const width = bounds.east - bounds.west;
  if (width >= 360)
    return { west: -180, east: 180, south: clampLat(bounds.south), north: clampLat(bounds.north) };
  const wrap = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;
  return {
    west: wrap(bounds.west),
    east: wrap(bounds.east),
    south: clampLat(bounds.south),
    north: clampLat(bounds.north),
  };
}

export function createLiveClient(options: { apiUrl: string; store: LiveStore }): LiveClient {
  const { store } = options;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  let connection: LiveConnectionState = 'connecting';
  let coverage: LiveCoverageState = 'waiting';
  let view: LiveView | null = null;
  let kinds: LiveKind[] = [];
  let sent = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let holdUntil = 0;
  let closed = false;

  let socket: Socket | null = null;

  const send = () => {
    timer = null;
    if (closed || !view || connection !== 'connected') return;
    const wait = holdUntil - Date.now();
    if (wait > 0) {
      timer = setTimeout(send, wait);
      return;
    }
    const bounds = normaliseBounds(view.bounds);
    const wanted = kindsAtZoom(kinds, view.zoom);
    const subscription = liveSubscription({
      ...bounds,
      zoom: Math.max(0, Math.min(24, view.zoom)),
      kinds: wanted,
    });
    const key = JSON.stringify(subscription);
    if (key === sent) return;
    sent = key;
    // Too wide only when no kind asked for fits (the server keeps the ones that do).
    coverage =
      wanted.length === 0 || wanted.some((kind) => liveTilesFor(bounds, kind))
        ? 'waiting'
        : 'too_wide';
    notify();
    socket?.emit(LIVE_SOCKET_EVENTS.subscribe, subscription);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(send, SUBSCRIBE_DEBOUNCE_MS);
  };

  // `import()`, not a static import: `@oxy.so/core` already loads
  // socket.io-client lazily, and a module two lazy chunks share statically is
  // hoisted into the first-paint `__common` chunk (measured: +54 KB with the
  // live flag off). As its own `import()` target it stays one lazy chunk.
  void import('socket.io-client')
    .then(({ io }) => {
      if (closed) return;
      const live: Socket = io(`${options.apiUrl}${LIVE_SOCKET_NAMESPACE}`, {
        // WebSocket only. Long-polling would need every request of a session
        // to reach the same API task (ALB stickiness); a WebSocket is one
        // connection to one task, whichever it is (`docs/MAP_LIVE.md`).
        transports: ['websocket'],
        withCredentials: false,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30_000,
      });
      socket = live;
      live.on('connect', () => {
        connection = 'connected';
        sent = '';
        notify();
        schedule();
      });
      live.on('disconnect', () => {
        connection = 'offline';
        notify();
      });
      live.on('connect_error', () => {
        connection = 'offline';
        notify();
      });

      // One queue for every message: inflating is asynchronous, and a delta
      // applied before the snapshot it follows would be lost.
      let inbox: Promise<void> = Promise.resolve();
      const receive = (event: string, handle: (payload: unknown) => void) =>
        live.on(event, (raw: unknown) => {
          inbox = inbox
            .then(() => unpackLivePayload(raw))
            .then((payload) => {
              if (!closed) handle(payload);
            })
            .catch(() => {});
        });
      receive(LIVE_SOCKET_EVENTS.sources, (payload: unknown) => {
        const page = parseLiveSources(payload);
        if (!page) return;
        store.setSources(page.items);
        notify();
      });
      receive(LIVE_SOCKET_EVENTS.subscription, (payload: unknown) => {
        const state = parseLiveSubscriptionState(payload);
        if (!state) return;
        if (state.state === 'rate_limited') {
          holdUntil = Date.now() + (state.retryAfterSeconds ?? 1) * 1000;
          sent = '';
          schedule();
          return;
        }
        if (state.state === 'invalid') return;
        store.retain(state.tiles);
        coverage = state.state === 'too_wide' ? 'too_wide' : 'ok';
        notify();
      });
      receive(LIVE_SOCKET_EVENTS.snapshot, (payload: unknown) => {
        const snapshot = parseLiveSnapshot(payload);
        if (!snapshot) return;
        store.applySnapshot(snapshot);
        notify();
      });
      receive(LIVE_SOCKET_EVENTS.delta, (payload: unknown) => {
        const delta = parseLiveDelta(payload);
        if (!delta) return;
        store.applyDelta(delta);
        notify();
      });
    })
    .catch(() => {
      connection = 'offline';
      notify();
    });

  return {
    setView(next) {
      view = next;
      schedule();
    },
    setKinds(next) {
      kinds = [...next];
      schedule();
    },
    state: () => ({ connection, coverage }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      listeners.clear();
      socket?.close();
    },
  };
}
