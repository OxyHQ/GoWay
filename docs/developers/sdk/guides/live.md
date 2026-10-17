# Live

GoWay Live re-serves real-time positions of aircraft, public-transport vehicles, bike-share stations and ships. It has two halves: an HTTP half on the client (`client.live`), which lists the feeds a deployment carries with their licences and freshness, and a Socket.IO stream described by the `@goway.to/sdk/live` entry point, which carries the positions. The SDK ships no socket transport; install `socket.io-client` v4 alongside it.

```bash
npm install @goway.to/sdk socket.io-client
```

## Sources: what is available, and how to credit it

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient();
const sources = await goway.live.sources();

for (const source of sources.items) {
  console.log(source.kind, source.name, source.status, source.attribution.label, source.licence.href);
}
```

Each `LiveSource` has an `id` (entities carry it as `sourceId`), a `kind`, `attribution` and `licence` links, its `coverage` box, a `status` (`idle`, `starting`, `live`, `stale`, `unavailable`), `lastUpdatedAt`, `pollIntervalSeconds`, `staleAfterSeconds` and `dropAfterSeconds`. Credit every source whose data you draw, using its `attribution`. A deployment with live switched off answers `sources()` with `GoWayUnavailableError`.

The same list also arrives over the socket as the `live:sources` event, on connect and whenever a status changes.

## Connect and subscribe

The socket lives on the API origin under the namespace `LIVE_SOCKET_NAMESPACE` (`/live`) and is open to signed-out visitors. You tell it what you are looking at (a box, a zoom and the kinds you want); it puts you in the right rooms and sends a snapshot per room, then deltas.

```ts
import { io } from 'socket.io-client';
import { DEFAULT_GOWAY_API_BASE_URL } from '@goway.to/sdk';
import { LIVE_SOCKET_EVENTS, LIVE_SOCKET_NAMESPACE, liveSubscription } from '@goway.to/sdk/live';

const socket = io(`${DEFAULT_GOWAY_API_BASE_URL}${LIVE_SOCKET_NAMESPACE}`, { transports: ['websocket'] });

function subscribe(view: { west: number; south: number; east: number; north: number; zoom: number }) {
  socket.emit(LIVE_SOCKET_EVENTS.subscribe, liveSubscription({ ...view, kinds: ['transit', 'bikeshare'] }));
}

socket.on('connect', () => subscribe(currentView()));
```

- `liveSubscription` checks the message before it leaves and throws `TypeError` for one the server would refuse (`south > north`, an unknown kind, a zoom outside 0 to 24).
- Each subscribe replaces the previous one. Send a new one when the map settles after a pan or zoom, and again after a reconnect.
- An empty `kinds` leaves every room.

## Receive messages

Server messages larger than `LIVE_PACKED_MIN_BYTES` arrive as gzip bytes. Pass every payload through `unpackLivePayload` before parsing. Because inflating is asynchronous, chain messages through one promise so a delta is never applied before the snapshot it follows:

```ts
import {
  parseLiveDelta,
  parseLiveSnapshot,
  parseLiveSources,
  parseLiveSubscriptionState,
  unpackLivePayload,
} from '@goway.to/sdk/live';

let inbox: Promise<void> = Promise.resolve();
function receive(event: string, handle: (payload: unknown) => void) {
  socket.on(event, (raw: unknown) => {
    inbox = inbox.then(() => unpackLivePayload(raw)).then(handle).catch(() => {});
  });
}

receive(LIVE_SOCKET_EVENTS.snapshot, (payload) => {
  const snapshot = parseLiveSnapshot(payload);
  if (snapshot) store.replaceRoom(snapshot.tile, snapshot.kind, snapshot.entities);
});

receive(LIVE_SOCKET_EVENTS.delta, (payload) => {
  const delta = parseLiveDelta(payload);
  if (delta) store.applyDelta(delta);
});
```

Every parser returns `null` for a payload that does not match the contract, rather than throwing; skip those.

### Snapshots and deltas

- A `LiveSnapshot` is every entity of one `kind` in one room (`tile`), as of `at` (the server's clock).
- A `LiveDelta` for the same room carries `upserts` (entities that arrived or changed), `moves` and `removes` (ids that left the room).
- A `LiveMove` is a compact tuple for an entity that only moved: `[id, latitude, longitude, heading, speed, observedAt, alongMeters, offsetMeters]`. Ignore a move for an id you do not hold.

### Subscription state

After every subscribe the server sends `live:subscription`:

```ts
receive(LIVE_SOCKET_EVENTS.subscription, (payload) => {
  const state = parseLiveSubscriptionState(payload);
  if (!state) return;
  switch (state.state) {
    case 'ok':
      store.retain(state.tiles); // drop entities from rooms not listed
      break;
    case 'too_wide':
      showHint('Zoom in to see live vehicles');
      store.retain(state.tiles);
      break;
    case 'rate_limited':
      setTimeout(() => subscribe(currentView()), (state.retryAfterSeconds ?? 1) * 1000);
      break;
    case 'invalid':
      break; // the previous rooms are kept
  }
});
```

`tiles` lists, per kind, the rooms the connection is in now. A kind you asked for that is missing from `tiles` covered more than `LIVE_MAX_ROOM_TILES` rooms and was left out; `too_wide` means every kind was.

## Entities

Every `LiveEntity` has `id`, `sourceId`, `position` (`{ latitude, longitude }`), `headingDegrees`, `speedMetersPerSecond` and `observedAt`, plus fields for its `kind`:

| `kind` | Type | Extra fields |
| --- | --- | --- |
| `aircraft` | `LiveAircraft` | `icao24`, `callsign`, `registration`, `typeCode`, altitude, `onGround` |
| `transit` | `LiveTransitVehicle` | `mode`, `operator`, `line`, `headsign`, `vehicleLabel`, `lineColor`, `lineTextColor`, `track` |
| `bikeshare` | `LiveBikeshareStation` | `operator`, `name`, `bikesAvailable`, `ebikesAvailable`, `docksAvailable`, `capacity`, `renting`, `returning` |
| `vessel` | `LiveVessel` | `mmsi`, `name`, `navigationalStatus`, `destination` |

### Freshness

`observedAt` is when the source observed the position, never when GoWay received it. Measure age against the `at` of the message that delivered it (the server's clock), and draw an entity older than its source's `staleAfterSeconds` as stale, where it was, rather than moving it.

### Track shapes

A transit vehicle on a known track carries `track.shapeId`. From `LIVE_SHAPES_MIN_ZOOM` (12) you can fetch the shape to draw it along its line:

```ts
if (vehicle.track) {
  const shape = await goway.live.shape(vehicle.sourceId, vehicle.track.shapeId);
  // shape.coordinates are [longitude, latitude] pairs in order of travel
}
```

Shapes are cacheable.

## Rooms (advanced)

The server picks rooms for you. If you need the same arithmetic on the client (to prefetch, or to test), `liveTilesFor(box, kind)` gives a kind's room tiles for a box, `liveTileOf` and `liveTilesOf` the rooms a position falls in, `liveTileBounds(tile)` a room's box, and `LIVE_ROOM_ZOOMS` the levels per kind.

## See also

- [Live vehicles example](../examples/live-vehicles.md)
- [API reference: `@goway.to/sdk/live`](../api-reference/live.md)
