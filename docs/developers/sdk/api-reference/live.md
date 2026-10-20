# @goway.to/sdk/live

The GoWay Live socket protocol: the Socket.IO namespace and event names, the room-tile arithmetic, and a parser for every message. It carries no transport; bring your own `socket.io-client` v4. It is a separate entry point so an HTTP-only app never loads the live schemas.

Import from it like this: `import { LIVE_SOCKET_EVENTS, LIVE_SOCKET_NAMESPACE, liveSubscription, parseLiveDelta } from '@goway.to/sdk/live';`

The HTTP half (`client.live.sources()` and `client.live.shape()`) is on the root client; see [`@goway.to/sdk`](./index.md#clientlive-gowayliveapi). For a walkthrough, see the [live guide](../guides/live.md).

## Protocol

| Name | Value | Description |
| --- | --- | --- |
| `LIVE_SOCKET_NAMESPACE` | `'/live'` | The Socket.IO namespace on the API origin. Open to signed-out visitors. |
| `LIVE_SOCKET_EVENTS` | see below | Event names, in both directions. |
| `LIVE_PACKED_MIN_BYTES` | `2048` | A server payload larger than this travels as gzip bytes instead of JSON. Inflate it with `unpackLivePayload`. |

`LIVE_SOCKET_EVENTS`:

| Key | Event | Direction | Payload |
| --- | --- | --- | --- |
| `subscribe` | `'live:subscribe'` | client to server | `LiveSubscription`. Replaces the previous one. |
| `subscription` | `'live:subscription'` | server to client | `LiveSubscriptionState`, after every subscribe. |
| `snapshot` | `'live:snapshot'` | server to client | `LiveSnapshot`, one per room joined. |
| `delta` | `'live:delta'` | server to client | `LiveDelta`, per room, as feeds answer. |
| `sources` | `'live:sources'` | server to client | `LiveSourcePage`, on connect and as statuses change. |

## Functions

### Messages

Every parser returns the contract value, or `null` when the payload does not match it. They never throw, so one bad message does not end a stream.

| Function | Signature | Description |
| --- | --- | --- |
| `unpackLivePayload` | `unpackLivePayload(payload: unknown): Promise<unknown>` | A payload as sent: JSON as is, or gzip bytes (`ArrayBuffer` or a typed array) inflated and parsed. Resolves `null` for bytes that are not gzip JSON, or where the runtime lacks `Blob`, `DecompressionStream` or `Response`. Inflating is asynchronous, so chain messages to keep them in arrival order. |
| `parseLiveSnapshot` | `parseLiveSnapshot(payload: unknown): LiveSnapshot \| null` | A `live:snapshot` payload. |
| `parseLiveDelta` | `parseLiveDelta(payload: unknown): LiveDelta \| null` | A `live:delta` payload. |
| `parseLiveSubscriptionState` | `parseLiveSubscriptionState(payload: unknown): LiveSubscriptionState \| null` | A `live:subscription` payload. |
| `parseLiveSources` | `parseLiveSources(payload: unknown): LiveSourcePage \| null` | A `live:sources` payload. |
| `liveSubscription` | `liveSubscription(input: LiveSubscription): LiveSubscription` | A subscription checked before it is sent. Throws `TypeError` for one the server would refuse (`south > north`, an unknown kind, a zoom outside 0 to 24). |

### Room tiles

Entities are grouped into rooms keyed on map tiles. A subscription joins, per kind, the finest level whose tiles cover the viewport in at most `LIVE_MAX_ROOM_TILES`. The server does this for you; these functions are for a client that wants to reason about rooms itself.

| Function | Signature | Description |
| --- | --- | --- |
| `liveTilesFor` | `liveTilesFor(box: GeoBoundingBox, kind: LiveKind): string[] \| null` | A kind's room tiles for a box, or `null` when even the coarsest level needs more than `LIVE_MAX_ROOM_TILES`. A box with `west > east` crosses the antimeridian. |
| `liveTileOf` | `liveTileOf(position: { latitude: number; longitude: number }, kind: LiveKind, zoom?: number): string` | The room tile a position falls in at one level (default: the finest). |
| `liveTilesOf` | `liveTilesOf(position: { latitude: number; longitude: number }, kind: LiveKind, mode?: LiveTransitMode): string[]` | The room tiles a position falls in, one per level, coarsest first. |
| `liveTileBounds` | `liveTileBounds(tile: string): GeoBoundingBox` | The box a room tile covers. |
| `liveRoomZoomsOf` | `liveRoomZoomsOf(entity: { kind: LiveKind; mode?: LiveTransitMode }): readonly number[]` | The room levels an entity is in, coarsest first. A street-level transit mode is only in the finest. |
| `isRegionalTransitMode` | `isRegionalTransitMode(mode: LiveTransitMode): boolean` | Whether a transit mode is in the regional room levels. |

## Constants

| Name | Value | Description |
| --- | --- | --- |
| `LIVE_KINDS` | `['aircraft', 'transit', 'bikeshare', 'vessel']` | What a live entity is. |
| `LIVE_TRANSIT_MODES` | `['bus', 'tram', 'subway', 'rail', 'ferry', 'cable', 'other']` | A transit vehicle's mode, in GTFS `route_type` terms. |
| `LIVE_REGIONAL_TRANSIT_MODES` | modes from `LIVE_TRANSIT_MODES` | The modes a regional (zoomed-out) view carries: trains and metros. |
| `LIVE_SOURCE_STATUSES` | `['idle', 'starting', 'live', 'stale', 'unavailable']` | How a source is doing as of the server's last look. |
| `LIVE_ROOM_ZOOMS` | per kind, `readonly number[]` | The tile zooms each kind's rooms are keyed on, coarsest first. |
| `LIVE_MAX_ROOM_TILES` | `20` | The most rooms one subscription may cover per kind. |
| `LIVE_SHAPES_MIN_ZOOM` | `12` | The map zoom from which a client asks for track shapes (`client.live.shape`). |

## Types

### Messages

| Type | Description |
| --- | --- |
| `LiveSubscription` | `{ west; south; east; north; zoom; kinds: LiveKind[] }`: what the client is looking at. Empty `kinds` leaves every room. |
| `LiveSubscriptionState` | `{ state: 'ok' \| 'too_wide' \| 'rate_limited' \| 'invalid'; tiles; retryAfterSeconds }`. `tiles` lists, per kind, the rooms the connection is in now; drop anything you hold for other rooms. |
| `LiveSnapshot` | `{ tile; kind; at; entities: LiveEntity[] }`: every entity of one kind in one room. `at` is the server's clock. |
| `LiveDelta` | `{ tile; kind; at; upserts: LiveEntity[]; moves: LiveMove[]; removes: string[] }`: what changed in one room. |
| `LiveMove` | `[id, latitude, longitude, heading, speed, observedAt, alongMeters, offsetMeters]`: an entity that only moved. |
| `LiveSourcePage` | `{ items: LiveSource[]; nextCursor }`. |

### Entities

Every entity has `id`, `sourceId`, `position` (`GeoCoordinate`), `headingDegrees`, `speedMetersPerSecond` and `observedAt` (when the source observed it).

| Type | Description |
| --- | --- |
| `LiveEntity` | Any of the four entity types, discriminated by `kind`. |
| `LiveAircraft` | `kind: 'aircraft'`: `icao24`, `callsign`, `registration`, `typeCode`, altitude fields, `onGround`, and more. |
| `LiveTransitVehicle` | `kind: 'transit'`: `mode`, `operator`, `line`, `headsign`, `vehicleLabel`, `lineColor`, `lineTextColor`, `track`, `trackStatus`, `positionBasis`. |
| `LiveBikeshareStation` | `kind: 'bikeshare'`: `operator`, `name`, `bikesAvailable`, `ebikesAvailable`, `docksAvailable`, `capacity`, `renting`, `returning`. |
| `LiveVessel` | `kind: 'vessel'`: `mmsi`, `name`, `navigationalStatus`, `destination`. |
| `LiveKind` | One of `LIVE_KINDS`. |
| `LiveTransitMode` | One of `LIVE_TRANSIT_MODES`. |

### Sources

| Type | Description |
| --- | --- |
| `LiveSource` | One feed: `id`, `kind`, `name`, `attribution`, `licence`, `coverage`, `completeness`, `status`, `lastUpdatedAt`, `pollIntervalSeconds`, `staleAfterSeconds`, `dropAfterSeconds`, `entityCount`. |
| `LiveSourceStatus` | One of `LIVE_SOURCE_STATUSES`. |
| `LiveLink` | `{ label; href }`: an attribution or licence link. |
| `LiveShape` | An operator's route shape: `sourceId`, `id`, `coordinates` (`[longitude, latitude][]`), `alongMeters`, `lengthMeters`. |

### Geography

| Type | Description |
| --- | --- |
| `GeoCoordinate` | `{ latitude: number; longitude: number }`. |
| `GeoBoundingBox` | `{ west: number; south: number; east: number; north: number }`. |
