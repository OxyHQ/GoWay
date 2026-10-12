/**
 * `@goway.to/sdk/live` — the GoWay Live socket protocol.
 *
 * Positions of real aircraft, transit vehicles, bike-share stations and ships
 * stream over Socket.IO, namespace {@link LIVE_SOCKET_NAMESPACE} on the GoWay
 * API origin. This entry point carries what a client needs to speak it — the
 * event names, the room-tile arithmetic and a parser per message — and no
 * transport: bring your own `socket.io-client` (v4), so this package keeps its
 * one dependency.
 *
 * A separate entry point, not part of `@goway.to/sdk`, so an HTTP-only
 * consumer (and GoWay's own first paint) never loads the live schemas.
 *
 *     import { io } from 'socket.io-client';
 *     import { LIVE_SOCKET_EVENTS, LIVE_SOCKET_NAMESPACE, liveSubscription, parseLiveDelta } from '@goway.to/sdk/live';
 *
 *     const socket = io(`https://api.goway.to${LIVE_SOCKET_NAMESPACE}`, { transports: ['websocket'] });
 *     socket.emit(LIVE_SOCKET_EVENTS.subscribe, liveSubscription({ ...viewportBox, zoom, kinds: ['transit'] }));
 *     socket.on(LIVE_SOCKET_EVENTS.delta, (payload) => {
 *       const delta = parseLiveDelta(payload);
 *       if (delta) render(delta);
 *     });
 *
 * ## Real data, with its age and its source
 *
 * Every entity says when its SOURCE observed it (`observedAt`) and which source
 * that was (`sourceId`; credits and licences come from `goway.live.sources()`
 * or the `sources` event). Draw an entity older than its source's
 * `staleAfterSeconds` as stale, where it was — never move it — and credit every
 * source whose data you draw. Some sources' licences allow display only
 * inside a map; `docs/MAP_LIVE.md` in the GoWay repository has each one's terms.
 *
 * ## Parsers return `null` rather than throw
 *
 * A stream must survive one bad message: each `parseLive…` returns the
 * contract value, or `null` when the payload does not match it.
 */

import {
  LIVE_KINDS,
  LIVE_MAX_ROOM_TILES,
  LIVE_PACKED_MIN_BYTES,
  LIVE_ROOM_ZOOMS,
  LIVE_SOCKET_EVENTS,
  LIVE_SOCKET_NAMESPACE,
  LIVE_SOURCE_STATUSES,
  LIVE_TRANSIT_MODES,
  liveDeltaSchema,
  liveSnapshotSchema,
  liveSourcePageSchema,
  liveSubscriptionSchema,
  liveSubscriptionStateSchema,
  liveTileBounds,
  liveTileOf,
  liveTilesFor,
  liveTilesOf,
} from './contract';
import type {
  LiveDelta,
  LiveSnapshot,
  LiveSourcePage,
  LiveSubscription,
  LiveSubscriptionState,
} from './contract';

export {
  LIVE_KINDS,
  LIVE_MAX_ROOM_TILES,
  LIVE_PACKED_MIN_BYTES,
  LIVE_ROOM_ZOOMS,
  LIVE_SOCKET_EVENTS,
  LIVE_SOCKET_NAMESPACE,
  LIVE_SOURCE_STATUSES,
  LIVE_TRANSIT_MODES,
  liveTileBounds,
  liveTileOf,
  liveTilesFor,
  liveTilesOf,
};

export type {
  GeoBoundingBox,
  GeoCoordinate,
  LiveAircraft,
  LiveBikeshareStation,
  LiveDelta,
  LiveEntity,
  LiveKind,
  LiveLink,
  LiveMove,
  LiveShape,
  LiveSnapshot,
  LiveSource,
  LiveSourcePage,
  LiveSourceStatus,
  LiveSubscription,
  LiveSubscriptionState,
  LiveTransitMode,
  LiveTransitVehicle,
  LiveVessel,
} from './contract';

function parsed<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  payload: unknown,
): T | null {
  const result = schema.safeParse(payload);
  return result.success ? (result.data as T) : null;
}

/**
 * A server → client payload as sent: JSON as is, or gzip bytes (a payload over
 * {@link LIVE_PACKED_MIN_BYTES}) inflated and parsed. Resolves `null` for bytes
 * that are not gzip JSON. Feed the result to the `parseLive*` functions — and
 * keep messages in arrival order: inflating is asynchronous, so a client
 * should chain them (`liveClient.ts` does).
 */
export async function unpackLivePayload(payload: unknown): Promise<unknown> {
  const bytes =
    payload instanceof ArrayBuffer
      ? new Uint8Array(payload)
      : ArrayBuffer.isView(payload)
        ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
        : null;
  if (!bytes) return payload;
  // The web streams API, present in browsers and Node ≥ 18; typed locally so
  // the SDK keeps compiling without the DOM library.
  const web = globalThis as unknown as {
    Blob?: new (parts: unknown[]) => { stream(): { pipeThrough(transform: unknown): unknown } };
    DecompressionStream?: new (format: 'gzip') => unknown;
    Response?: new (body: unknown) => { text(): Promise<string> };
  };
  if (!web.Blob || !web.DecompressionStream || !web.Response) return null;
  try {
    const stream = new web.Blob([bytes]).stream().pipeThrough(new web.DecompressionStream('gzip'));
    return JSON.parse(await new web.Response(stream).text()) as unknown;
  } catch {
    return null;
  }
}

/** A `live:snapshot` payload, or `null`. */
export function parseLiveSnapshot(payload: unknown): LiveSnapshot | null {
  return parsed<LiveSnapshot>(liveSnapshotSchema, payload);
}

/** A `live:delta` payload, or `null`. */
export function parseLiveDelta(payload: unknown): LiveDelta | null {
  return parsed<LiveDelta>(liveDeltaSchema, payload);
}

/** A `live:subscription` payload, or `null`. */
export function parseLiveSubscriptionState(payload: unknown): LiveSubscriptionState | null {
  return parsed<LiveSubscriptionState>(liveSubscriptionStateSchema, payload);
}

/** A `live:sources` payload, or `null`. */
export function parseLiveSources(payload: unknown): LiveSourcePage | null {
  return parsed<LiveSourcePage>(liveSourcePageSchema, payload);
}

/**
 * A subscription to send, checked before it leaves: a box that would be
 * refused (`south > north`, an unknown kind) throws `TypeError` here rather
 * than coming back as `invalid`.
 */
export function liveSubscription(input: LiveSubscription): LiveSubscription {
  const result = liveSubscriptionSchema.safeParse(input);
  if (!result.success) {
    throw new TypeError(`not a live subscription: ${result.error.issues[0]?.message ?? 'invalid'}`);
  }
  return result.data;
}
