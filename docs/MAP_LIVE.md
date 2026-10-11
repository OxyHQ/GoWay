# GoWay Live: real things moving on the map

Aircraft, public-transport vehicles, bike-share stations and ships, drawn on
the map from open real-time feeds, moving as the feeds report them. **Built,
off by default, web only, served nowhere but a developer's machine.**

Unlike a simulation, this is real data, so three things decide every design
choice below: **licence** (may GoWay re-serve it, publicly, from a service that
may be commercial?), **provenance** (whose data is this, and is that on
screen?) and **freshness** (how old is this position, and does the map say
so?).

## What it looks like

- A **Live** panel (top right; a pill on a phone) with per-kind toggles —
  Aircraft, Transit, Bikes, Ships — one line per feed in view with its
  freshness ("updated 3 s ago", or `stale` / `unavailable`), and the sentence
  "Real positions from open feeds. Nothing here is simulated."
- **Glyphs** on the map: an aircraft silhouette, a vehicle pointer coloured by
  mode with its line beside it, a ship hull, a bike-station disc with its bike
  count (from z15). A glyph turns to its heading; a thing whose feed reports no
  course is drawn as a plain disc, never pointing north by default.
- **Tap** a glyph for what it is (callsign, type and registration; line,
  operator and vehicle; bikes, e-bikes and free docks; ship name, status and
  destination), the **age of its position**, and its **source and licence**
  as links.
- **Credits**: each feed whose data is on screen adds its credit to the map's
  data credit, bottom right (`MapAttribution`), and removes it when its data
  leaves the screen.
- **3D**: with the city-3D prototype on (`?city3d=1`), aircraft are drawn at
  their **real altitude** on a thin stalk to the ground point they are over
  (their 2D glyph becomes that ground shadow), ships and vehicles as simple
  shapes on the ground, all in the city engine's scene so buildings occlude
  them.

Screenshots and frame sequences from the verification run are in the PR.

## Sources

Every source was chosen by licence first. The question is not "is it free to
read" but "may GoWay re-serve it, publicly, from a possibly commercial
service". Terms were read on 2026-10-11; each endpoint was probed live the
same day.

### Accepted (in `packages/backend/src/live/catalogue.ts`)

| Id | What | Coverage | Licence | Attribution shown | Key | Polled | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `adsb-lol` | Aircraft (ADS-B/MLAT), adsb.lol `/v2` | Worldwide, by region | **ODbL 1.0** ("The license for the API as well as all data ADSB.lol makes public is ODbL") | © adsb.lol contributors (ODbL 1.0) | None today; "in the future, you will require an API key which you can get by feeding" | 15 s per region, ≤ 4 regions/poll | Accept with conditions |
| `renfe-cercanias` | Trains, Renfe Cercanías and **Rodalies de Catalunya** (GTFS-RT) | Spain | **CC BY 4.0** + Spanish public-sector reuse conditions ("permiten la reutilización … para fines comerciales y no comerciales") | Origen de los datos: Renfe Operadora | None | 20 s (Renfe republishes every 20 s) | Accept |
| `fgc-geotren` | Trains, FGC (Geotren, Opendatasoft) | Catalonia | **CC BY 4.0** | Ferrocarrils de la Generalitat de Catalunya | None; 5,000 calls/day/IP | 60 s (2 calls → 2,880/day) | Accept |
| `mta-bus` | Buses, MTA Bus Time (GTFS-RT) | New York City | **MTA data feed terms**: "authorizes you to download and host the data on a non-MTA server … and to make the data available to others" | Data: MTA | Documented as required (free); answered without one on 2026-10-11 | 15 s | Accept with conditions |
| `mta-lirr` | Trains, Long Island Rail Road (GTFS-RT) | NY region | MTA terms | Data: MTA | None | 20 s | Accept with conditions |
| `mta-mnr` | Trains, Metro-North (GTFS-RT) | NY region | MTA terms | Data: MTA | None | 20 s | Accept with conditions |
| `nyc-bikeshare` | Bike-share stations (GBFS 2.3) | New York City | **Bikeshare Data License Agreement**: "distribute in your product or service and use the Data for any lawful purpose" | NYC bike share data (generic, by licence) | None | 60 s (GBFS `ttl`) | Accept with conditions |
| `digitraffic-ais` | Ships (AIS), Fintraffic Digitraffic | Finnish and Baltic waters | **CC BY 4.0** ("even commercially") | Source: Fintraffic / digitraffic.fi, CC 4.0 BY | None; `Digitraffic-User` header sent, gzip required | 30 s | Accept |

Conditions that come with the accepted ones:

- **adsb.lol** — the operator asks production users to get in touch ("If you
  want to use the API for production purposes, please contact me so I do not
  break your application by accident"); rate limits are "dynamic" (measured:
  polling every 10 s from one IP drew a 429 about once a minute, so the poller
  stops at the first 429 and backs off). An API key for non-feeders is
  announced: **production should run an ADS-B feeder**. ODbL share-alike: the
  aircraft positions GoWay re-serves are a database under ODbL, and the
  source's licence is published with every source (`GET /live/sources`).
  **Privacy**: aircraft in the FAA's LADD and PIA programmes (`dbFlags` 8 and
  4) are dropped before they reach the map — their owners asked public
  displays not to show them.
- **Renfe** — no distortion of meaning, no implied endorsement, cite the
  last-update date: the panel shows each feed's age and each position's age.
- **MTA** — never imply MTA endorsement, no MTA logos (the layer uses generic
  glyphs; the credit is the words "Data: MTA"), do not modify the data
  (positions, routes and timestamps are re-served as reported; only the format
  changes), and show a not-real-time notice when the lag exceeds a minute: every
  position states its age, and anything past its bound is drawn stale.
  **Production registers a Bus Time key** (`LIVE_SOURCE_MTA_BUS_KEY`). The
  subway feeds carry no coordinates and are not used.
- **NYC bike share (Citi Bike)** — the licence forbids distributing the data
  "as a stand-alone dataset" and using the CITI BIKE / Lyft marks. So the layer
  is named generically, credits generically, and draws the stations only inside
  the map. **Open question for production**: the `/live` socket is publicly
  reachable; whether that counts as a stand-alone feed is for Lyft (or counsel)
  to answer before `nyc-bikeshare` is enabled anywhere public. The SDK's live
  protocol (`@goway.to/sdk/live`) must not advertise this source to third
  parties until then.
- **Digitraffic** — Finland and the Baltic only; useful to prove the ship path,
  not for Barcelona or New York.

### Rejected or deferred

| Source | Why |
| --- | --- |
| **OpenSky Network** | "Any use by a for-profit or commercial entity … requires a written license", and "integration into a live product … requires a written license". |
| **adsb.fi** open data | "for personal, non-commercial use only". |
| **airplanes.live** | API answered 403 asking projects to email for access; terms not readable; secondary sources say non-commercial only. Not verifiable → not used. |
| **Bicing** (operator GBFS, `barcelona.publicbikesystem.net`) | Answers without a key but states **no licence**; data without a grant is not ours to redistribute. The licensed route is **Open Data BCN** (CC BY 4.0, tokenised "securitzat" resource), whose portal refused connections all day — **deferred**: the GBFS adapter will carry it once the token flow is confirmed (it needs a two-URL/no-discovery mode). So Barcelona has no bike share today. |
| **TMB** (Barcelona metro and buses) | Permissive terms, but no vehicle-position API (iBus is arrival predictions). |
| **FGC GTFS-RT** vehicle positions | Licence fine (CC BY 4.0); the file served 0 bytes on three tries. Geotren is used instead; switch when the GTFS-RT file is live. |
| **NYC Ferry** vehicle positions | Endpoint not on the published developer tools; the grant is "to test, design, and support your products", not to redistribute. Held. |
| **HSL** (Helsinki, GTFS-RT, CC BY 4.0) | Licence fine, adapter is the generic GTFS-RT one — but a `VehiclePosition` names a route id, not its mode, and HSL's ids do not encode it reliably; a bus drawn as a tram is wrong data. Needs the static GTFS `routes.txt` join first. |
| **aisstream.io** | Publishes no licence or terms. |
| **AISHub** | Display allowed, but raw positions may not be passed on, a key requires running a receiver, 1 request/min. Barcelona/NYC ships need our own receivers and AISHub's written OK. |
| **NOAA / USCG AIS** | Historical archives only. |

## Architecture

```
 feeds ──► adapters ──► LiveHub (index, demand, backoff) ──► /live namespace ──► browser
            (live/adapters)   (live/hub.ts, tileIndex.ts)      (live/socket.ts)
                                       │
                                       └──► GET /api/v1/live/sources (routes/live.ts)
```

### Contracts (`packages/contracts/src/live-source.ts`, `live.ts`)

zod 4, like every GoWay contract. One `LiveEntity` discriminated union by kind
(`aircraft`, `transit`, `bikeshare`, `vessel`) sharing `id` (`<sourceId>:<the
provider's id>`), `sourceId`, `position`, `headingDegrees`,
`speedMetersPerSecond` and **`observedAt` — when the SOURCE observed it**, never
when GoWay received it. Kind-specific fields carry altitude (with its
reference: GNSS or barometric), callsign, line, mode, availability, MMSI.
`LiveSource` carries the licence, credit, coverage, status
(`idle | starting | live | stale | unavailable`), last successful update and the
two freshness bounds clients must honour (`staleAfterSeconds`,
`dropAfterSeconds`). The Socket.IO messages (`LiveSubscription`,
`LiveSubscriptionState`, `LiveSnapshot`, `LiveDelta`) are schemas too, and
published as JSON Schema in the OpenAPI document's components.

The HTTP half (`GET /live/sources`, `goway.live.sources()`) is in
`@goway.to/sdk`. The socket protocol is a **separate entry point,
`@goway.to/sdk/live`** — namespace, events, room-tile arithmetic and a parser
per message that returns `null` rather than throwing — bundled on its own, so
no HTTP-only consumer (and not GoWay's own first paint) loads the live schemas.
The contracts were split in two files for the same reason: esbuild keeps every
schema of a module it reaches.

### Adapters (`packages/backend/src/live/adapters/`)

One interface (`LiveAdapter.poll(context) → { entities, rejected }`), one
source definition per feed (`catalogue.ts`: licence, credit, coverage, default
endpoint, intervals, bounds). Each adapter turns an upstream record into a
contract value **or refuses it**: no coordinate, `(0,0)`, outside the
operator's coverage, no timestamp, an impossible value, a malformed body. Every
accepted value is re-checked with `liveEntitySchema` before it leaves
(`normalise.ts → accept`). Units are converted (knots, feet, ft/min → SI), AIS
"not available" codes (102.3 kn, 360°, 511) read as `null`.

| Adapter | Feeds | Notes |
| --- | --- | --- |
| `readsb.ts` | adsb.lol (same JSON as other readsb aggregators) | Regional: one circle per watched z6 tile (≤ 250 nm), most-watched first, the rest rotated; sequential; stops at the first 429 and returns a backoff |
| `gtfsRealtime.ts` + `protobuf.ts` | Renfe, MTA Bus, LIRR, Metro-North | A ~200-line bounds-checked protobuf reader for the `VehiclePosition` subset (no protobufjs, and `pbf` is ESM-only); a truncated body throws rather than half-reads; per-operator line/label mapping |
| `geotren.ts` | FGC | Records carry no time: every train is dated by the dataset's `data_processed` |
| `gbfs.ts` | NYC bike share | v2 and v3 discovery; station information cached an hour; e-bikes from `num_ebikes_available` or `vehicle_types` |
| `digitraffic.ts` | Fintraffic AIS | Positions with `from` = the drop bound; names and destinations from static reports, incrementally |

### The hub (`hub.ts`, `tileIndex.ts`)

- **In-memory spatial index**: the latest fix per entity, bucketed by **room**
  = a z7 web-mercator tile × a kind. Rooms ARE the index: a subscription is
  answered from the buckets its tiles cover, a delta is addressed to the bucket
  an entity is in, a box query walks only the buckets it touches. Replacing an
  entry discards the old fix: **positions are never stored as history**, and
  nothing is written to a database.
- **Demand-driven polling**: a source is polled only while somebody watches a
  room of its kind inside its coverage. No viewers in New York, no requests to
  New York's feeds. A source unwatched for 60 s drops what it holds.
- **Freshness is the feed's**: anything older than its source's
  `dropAfterSeconds` (by its own `observedAt`) is removed on the next tick,
  whatever the feed still lists. Full-snapshot feeds also remove whatever a poll
  no longer lists; the regional aircraft feed (`partialPolls`) only ages out.
- **Backoff**: `interval × 2^failures`, capped at 5 min, ±20 % jitter; a
  `Retry-After` wins if longer; a partly rate-limited poll applies what arrived
  and waits as asked. One poll per source in flight, 15 s timeout. Logs name
  the source and the reason, never a URL (keys are redacted) and never a
  viewport.
- **Deltas** per room, only for rooms somebody watches: upserts (new or
  changed, by value) and removes. An entity crossing a room boundary is a
  remove in one and an upsert in the other; the client resolves the race.

### The socket (`socket.ts`)

`/live` is a Socket.IO **namespace with no auth middleware**: the map is
public. This is not a hole in `realtime.ts`'s rule (rooms derive from the
authenticated user, never from the client) — nothing here is per-user: rooms
are public tiles × kinds, computed **by the server** from a box it validated.
The default namespace keeps its Oxy auth; a test proves both.

- `live:subscribe` `{ west, south, east, north, zoom, kinds }` → the server
  computes the z7 tiles (refusing more than 20 as `too_wide`: below ~z8 the
  map is a continent and tens of thousands of dots are noise), joins/leaves
  rooms, answers `live:subscription` with the rooms it is in, then one
  `live:snapshot` per new room. Empty `kinds` leaves everything.
- Limits: `LIVE_MAX_CONNECTIONS` per process (handshake refused with
  `live_capacity`), and a token bucket per socket for subscriptions
  (`LIVE_SUBSCRIBE_BURST`, `LIVE_SUBSCRIBE_PER_MINUTE`) — beyond it,
  `rate_limited` with `retryAfterSeconds`, and the previous rooms are kept.
- **Nothing about the viewer is kept**: the box is used to pick rooms and
  dropped — not stored on the socket, not counted per address, not logged. A
  viewport is not the viewer's location, but it is often near it.

### The client

| Piece | Where |
| --- | --- |
| Flag | `lib/map/liveFlag.ts` (`EXPO_PUBLIC_MAP_LIVE`, `?live=1` in development only) |
| Gate | `features/explore/ExploreScreen.tsx`: `React.lazy(() => import('@/features/live/LiveHost'))` when the flag is on, on web |
| Socket client | `features/live/liveClient.ts` (`socket.io-client`, debounced subscriptions, honours `rate_limited`) |
| State and motion (pure, tested) | `features/live/liveStore.ts`, `motion.ts` |
| Panel and copy | `features/live/LivePanel.tsx`, `format.ts`, `messages.ts` (en/es), `kinds.ts` (data colours) |
| Map seam | `MapCanvasProps.live` (`MapLiveLayer`, a pull interface: no React render per frame), `MapAttribution` `extra` credits |
| MapLibre adapter | `components/map/liveLayer.web.ts` — one GeoJSON source, a symbol layer with canvas-drawn glyphs (directional and still variants), a selection ring, frame loop throttled by zoom, picking |
| 3D | `components/map/engine/live3d/livePass.ts` (three.js, instanced meshes, stalks) as a **pass of the city engine** (`CityEngine.renderPass`, `City3dHandle.addPass`): one renderer, one scene stratum, MapLibre's depth buffer — "One engine, one scene" (`MAP_3D_CITY.md`). `anchorMath.ts` places a shape at its real altitude, pinned against MapLibre's `MercatorCoordinate` |

**Motion, honestly.** Ages are measured on the server's clock (every message
carries `at`). Then:

- A thing that **reports speed and course** (aircraft, AIS ships) is moved past
  its fix by dead reckoning for at most a short bound (aircraft 20 s, transit
  25 s, ships 60 s, never more than its source's stale bound), then held.
  Corrections are eased over 0.9 s.
- A thing that **reports no speed** (Renfe, FGC, MTA buses, LIRR) is **never
  predicted**: when its next fix arrives it walks, at constant pace, from where
  it was drawn to that fix, over the time the source took between the two (≤ 30
  s). It is always somewhere it really was within that interval; its glyph turns
  to the course between the two real fixes.
- Older than `staleAfterSeconds`: drawn **faded at its last real fix** (eased
  back from any prediction), never moved, and its card says "Stale". Older than
  `dropAfterSeconds`: gone.
- Nothing simulated is mixed in, anywhere.

The 3D shapes are generic and scaled up to stay visible (aircraft ≥ 30 px,
ships ≥ 22 px, vehicles ≥ 12 px on screen); **position, heading and altitude
are never scaled**. Altitude is above mean sea level and the basemap is flat at
0, which is right within metres away from terrain.

## Gates

- **Backend** `LIVE_ENABLED` (default off) and `LIVE_SOURCES` (each feed opted
  into by id; an unknown id fails the boot parse). Off: no poller, no `/live`
  namespace, `GET /live/sources` → `503 service_unavailable`.
- **Frontend** `EXPO_PUBLIC_MAP_LIVE=1` (a build decision; no production
  deployment sets it), or `?live=1` in a development build only.

### What the flag costs when off

Measured with `expo export --platform web`, no flags set, `origin/main` against
this branch (separate Metro caches, `--clear`); numbers in the PR. What is
pinned by test rather than by measurement:
`components/__tests__/liveChunk.test.ts` (the socket client and the live
protocol are imported only in `features/live`; the feature is reached only by
one `import()`; the adapter only by `import()` from `MapCanvas.web.tsx`) and
`engine3dChunk.test.ts` (three.js only in the engine chunk, the live adapter
importing the engine folders type-only).

## Running it locally

```bash
# Backend (needs its Postgres as always; live itself stores nothing)
LIVE_ENABLED=1 \
LIVE_SOURCES=adsb-lol,renfe-cercanias,fgc-geotren,mta-bus,mta-lirr,mta-mnr,nyc-bikeshare,digitraffic-ais \
CORS_APP_ORIGINS=http://localhost:8081 \
  bun run --cwd packages/backend dev

# Frontend against it
EXPO_PUBLIC_API_URL=http://localhost:3000 bun run --cwd packages/frontend web
# → http://localhost:8081/?live=1&lat=41.39&lng=2.16&zoom=12          Barcelona
# → http://localhost:8081/?live=1&lat=40.7545&lng=-73.9845&zoom=15.3  Midtown
# → http://localhost:8081/?live=1&city3d=1&lat=40.757&lng=-73.889&zoom=14.6&pitch=60&bearing=212
#   LaGuardia's runway-4 approach in 3D
```

## Rate limits and cost

| Source | Our request rate while watched | Their limit |
| --- | --- | --- |
| adsb.lol | ≤ 4 requests / 15 s (one per watched z6 region), stops at a 429 | "dynamic"; 429 about once a minute at 10 s from one IP |
| Renfe | 1 / 20 s | none published |
| FGC | 2 / 60 s = 2,880 / day | 5,000 / day / IP |
| MTA (×3) | 1 / 15–20 s each | none published (`Cache-Control: max-age=10`) |
| NYC GBFS | 1 status / 60 s, information hourly | `ttl` 60 |
| Digitraffic | ≤ 1 / 30 s (+ static reports every 30 min) | 60 / min / IP without the header; higher with it |

Polling is per PROCESS and demand-driven, so cost scales with the number of
backend tasks and the areas watched, not with viewers. Upstream data is free.
Egress is the cost: a dense room (all of New York: ~1,400 buses, ~2,500
stations) is ~1.3 MB per snapshot and ~25–30 KB/s of deltas per viewer
uncompressed. Bandwidth, not CPU, is the first limit.

## What production needs

1. **Licence follow-ups** — email adsb.lol before production use and plan a
   feeder (their key requirement is coming); register an MTA Bus Time key; get
   Lyft's (or counsel's) answer on `nyc-bikeshare` over a public socket, or do
   not enable it; get an Open Data BCN token for Bicing and add the
   no-discovery GBFS mode; publish the ODbL notice for re-served aircraft data
   alongside the map's (the `GET /live/sources` licence link is the start).
2. **One poller, many servers** — today every backend task polls on its own and
   holds its own index. With more than one task, move polling to one worker (or
   elect one) and fan out through the Socket.IO Redis/Valkey adapter
   (ElastiCache Valkey is already in the stack) — otherwise N tasks multiply
   upstream load by N and rate limits by N.
3. **Bandwidth** — enable per-message deflate for `/live` (or send deltas as a
   compact binary), and thin dense rooms by zoom (a z12 view does not need
   2,500 bike stations; the client already hides them below z15 but still
   receives them).
4. **CORS / embeds** — the socket honours `CORS_APP_ORIGINS` for long-polling;
   WebSocket upgrades are not CORS-checked by browsers. Decide whether
   third-party embeds get `/live` (it needs the public lane and the licence
   answers above).
5. **Native** — `MapCanvas.native.tsx` ignores `live` today (and
   `ExploreScreen` gates the host to web). MapLibre Native can draw the same
   GeoJSON symbol layer with a `ShapeSource`; the pull interface would need a
   ~2–4 Hz React update there instead of a frame loop. The 3D pass stays web
   only, as the city engine does.
6. **Observability** — per-source poll latency, failure counts and entity
   counts as metrics (they are in `GET /live/sources` and the logs today).
7. **Flip** `LIVE_ENABLED` with the vetted subset of `LIVE_SOURCES`, then
   `EXPO_PUBLIC_MAP_LIVE`.

## Limits, honestly

- **Coverage is patchy by nature**: Barcelona has aircraft, Rodalies and FGC
  trains, but no buses (TMB publishes none), no bike share (licence pending)
  and no ships; New York has aircraft, buses, LIRR, Metro-North and bike share,
  but no subway positions (the MTA's subway feeds carry none) and no ships.
- Renfe, FGC, LIRR and Metro-North positions are coarse (often snapped to
  stations or published once a minute); MTA bus fixes are typically 20–40 s old
  on arrival. The UI states every age; it cannot make them younger.
- adsb.lol's dynamic rate limit means aircraft can go stale for a poll or two
  under load; they are shown stale, not extrapolated.
- One process holds everything in memory; a restart starts from empty and
  refills within one poll interval.
- HSL, Bicing, NYC Ferry and Baltic-only ships are documented above as next
  sources, not built.
