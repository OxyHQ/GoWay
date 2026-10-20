# Live vehicles

Stream live public-transport vehicles in a viewport and keep an in-memory table of them, ready to draw. It connects with `socket.io-client`, subscribes with the viewport and zoom, inflates packed payloads in arrival order, applies snapshots, deltas and moves per room, and prints the sources to credit. Install both packages:

```bash
npm install @goway.to/sdk socket.io-client
```

```ts
import { io } from 'socket.io-client';
import { createGoWayClient, DEFAULT_GOWAY_API_BASE_URL } from '@goway.to/sdk';
import {
  LIVE_SOCKET_EVENTS,
  LIVE_SOCKET_NAMESPACE,
  liveSubscription,
  parseLiveDelta,
  parseLiveSnapshot,
  parseLiveSources,
  parseLiveSubscriptionState,
  unpackLivePayload,
  type LiveEntity,
  type LiveKind,
  type LiveSource,
  type LiveSubscriptionState,
} from '@goway.to/sdk/live';

const goway = createGoWayClient();

// What the user is looking at (Barcelona, city zoom).
const view = { west: 2.12, south: 41.36, east: 2.22, north: 41.42, zoom: 14 };
const kinds: LiveKind[] = ['transit'];

// entities by room ("kind/tile"), then by id
const rooms = new Map<string, Map<string, LiveEntity>>();
const sources = new Map<string, LiveSource>();
const roomKey = (kind: LiveKind, tile: string) => `${kind}/${tile}`;

function retain(tiles: LiveSubscriptionState['tiles']) {
  const keep = new Set<string>();
  for (const kind of Object.keys(tiles) as LiveKind[]) {
    for (const tile of tiles[kind] ?? []) keep.add(roomKey(kind, tile));
  }
  for (const key of rooms.keys()) if (!keep.has(key)) rooms.delete(key);
}

const socket = io(`${DEFAULT_GOWAY_API_BASE_URL}${LIVE_SOCKET_NAMESPACE}`, { transports: ['websocket'] });

function subscribe() {
  socket.emit(LIVE_SOCKET_EVENTS.subscribe, liveSubscription({ ...view, kinds }));
}
socket.on('connect', subscribe);

// One queue, so a delta is never applied before the snapshot it follows.
let inbox: Promise<void> = Promise.resolve();
function receive(event: string, handle: (payload: unknown) => void) {
  socket.on(event, (raw: unknown) => {
    inbox = inbox
      .then(() => unpackLivePayload(raw))
      .then(handle)
      .catch((error: unknown) => console.warn('live message dropped', error));
  });
}

receive(LIVE_SOCKET_EVENTS.sources, (payload) => {
  const page = parseLiveSources(payload);
  if (!page) return;
  for (const source of page.items) sources.set(source.id, source);
});

receive(LIVE_SOCKET_EVENTS.subscription, (payload) => {
  const state = parseLiveSubscriptionState(payload);
  if (!state) return;
  if (state.state === 'rate_limited') {
    setTimeout(subscribe, (state.retryAfterSeconds ?? 1) * 1000);
    return;
  }
  if (state.state === 'invalid') return;
  if (state.state === 'too_wide') console.log('Zoom in to see live vehicles');
  retain(state.tiles);
});

receive(LIVE_SOCKET_EVENTS.snapshot, (payload) => {
  const snapshot = parseLiveSnapshot(payload);
  if (!snapshot) return;
  rooms.set(roomKey(snapshot.kind, snapshot.tile), new Map(snapshot.entities.map((entity) => [entity.id, entity])));
});

receive(LIVE_SOCKET_EVENTS.delta, (payload) => {
  const delta = parseLiveDelta(payload);
  if (!delta) return;
  const room = rooms.get(roomKey(delta.kind, delta.tile));
  if (!room) return;
  for (const entity of delta.upserts) room.set(entity.id, entity);
  for (const [id, latitude, longitude, heading, speed, observedAt, alongMeters, offsetMeters] of delta.moves) {
    const entity = room.get(id);
    if (!entity) continue; // a move for an entity we never received
    const moved: LiveEntity = {
      ...entity,
      position: { latitude, longitude },
      headingDegrees: heading,
      speedMetersPerSecond: speed,
      observedAt,
    };
    if (moved.kind === 'transit' && moved.track && alongMeters !== null && offsetMeters !== null) {
      moved.track = { ...moved.track, alongMeters, offsetMeters };
    }
    room.set(id, moved);
  }
  for (const id of delta.removes) room.delete(id);
});

// Print what would be drawn, and who to credit, every five seconds.
setInterval(() => {
  const vehicles = [...rooms.values()].flatMap((room) => [...room.values()]);
  const credited = new Set(vehicles.map((vehicle) => vehicle.sourceId));
  console.log(`${vehicles.length} vehicles`);
  for (const vehicle of vehicles.slice(0, 5)) {
    if (vehicle.kind === 'transit') console.log(` ${vehicle.mode} ${vehicle.line ?? ''} → ${vehicle.headsign ?? ''}`);
  }
  for (const id of credited) {
    const source = sources.get(id);
    if (source) console.log(` Data: ${source.attribution.label} (${source.licence.label})`);
  }
}, 5000);

// The same source list over HTTP, for a credits screen.
goway.live.sources().then((page) => console.log(`${page.items.length} live sources on this deployment`));
```

Notes:

- When the map moves, update `view` and call `subscribe()` again; each subscription replaces the previous one, and `live:subscription` tells you which rooms to keep.
- Every parser returns `null` for a payload that does not match the contract; the stream carries on.
- `observedAt` is when the source saw the vehicle. Draw a vehicle older than its source's `staleAfterSeconds` as stale, where it was.
- Credit every source whose data you draw, using its `attribution` and `licence`.

See the [Live guide](../guides/live.md).
