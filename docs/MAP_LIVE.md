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
  "Real vehicles from open feeds. Hollow ones are estimated from arrival
  times. Nothing here is simulated."
- **Glyphs** on the map: an aircraft silhouette, a ship hull, a bike-station
  disc with its bike count (from z15), and for trains and buses a **to-scale
  silhouette in the line's colour** (`routes.txt` `route_color`) with the line
  beside it — a five-car Rodalies train is ~100 m long at every zoom past z13,
  a bus 12 m. A glyph turns to its heading; a thing whose feed reports no
  course is drawn as a plain disc, never pointing north by default. Three
  styles say how much a transit position is worth:
  - **solid** — reported by the operator, on its published track;
  - **dashed outline on white** — reported, but *approximate*: farther than
    75 m from every shape the operator publishes (or none is known), drawn
    exactly where reported and never animated;
  - **hollow (a faint wash of the line colour, solid outline)** — *estimated*:
    no position was reported at all; GoWay placed it along its line from the
    operator's arrival predictions (New York's subway, AMB's buses).
- **Tap** a glyph for what it is (callsign, type and registration; line,
  operator and vehicle; bikes, e-bikes and free docks; ship name, status and
  destination), the **age of its position** (for an estimate, "Predictions …
  old"), how it is placed ("Drawn on its line as published by the operator",
  "Approximate: not on a published track…", "Estimated from arrival
  predictions, not a GPS position…"), and its **source and licence** as links.
- **Credits**: each feed whose data is on screen adds its credit to the map's
  data credit, bottom right (`MapAttribution`), and removes it when its data
  leaves the screen.
- **3D**: with the city-3D prototype on (`?city3d=1`), aircraft are drawn at
  their **real altitude** on a thin stalk to the ground point they are over
  (their 2D glyph becomes that ground shadow); trains as their **consist, car
  by car on the track** (each car's centre on the line, its heading the
  line's there, so a train bends round a curve); buses, coaches and ships as
  models from the shared library city life draws with (`Vehicles` below) — all in the
  city engine's scene so buildings occlude them. **Estimated vehicles are
  never drawn in 3D** (`Estimated positions` below).

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
| `mta-subway` | Subway, MTA (GTFS-RT `TripUpdate`s, 8 feeds) → **estimated** positions | New York City | MTA terms | Data: MTA | None | 30 s (8 requests) | Accept with conditions, estimated |
| `amb-bus` | Buses, AMB metropolitan network incl. Nitbus (GTFS-RT `TripUpdate`s only) → **estimated** positions | Àrea Metropolitana de Barcelona | **Reuse under Llei 37/2007** (AMB open-data conditions: reuse incl. commercial; cite the source and the update date; do not alter the data or its meaning) | Font: AMB | None | 30 s (the feed's own cadence) | Accept with conditions, estimated |
| `aisa-bus` | Buses, AISA interurban (GTFS-RT GPS positions, via Spain's NAP) | Comunidad de Madrid | **NAP licence** (free reuse incl. commercial, with the credit) | Powered by MITRAMS | None | 20 s | Accept with conditions |
| `emt-fuenlabrada` | Buses, EMT Fuenlabrada (GTFS-RT GPS positions, via NAP; static GTFS from the same host) | Fuenlabrada (Madrid region) | NAP licence | Powered by MITRAMS | None | 20 s | Accept with conditions |

Static GTFS (routes, trips, shapes, stops) is read once a day per source, from
the operator's own keyless file, under the same licence as its realtime feed:
Renfe's `fomento_transit.zip`, FGC's three files on its Opendatasoft portal,
the MTA's per-borough bus zips, `gtfslirr.zip`, `gtfsmnr.zip` and
`gtfs_subway.zip`, AMB's `google_transit.zip` and EMT Fuenlabrada's Optibus
export. It gives each vehicle its line's name and colour, its track
(`Tracks` below) and, for the estimated networks, the stops' places on the
line. AISA's realtime ids do not join any published static GTFS: its buses are
drawn where reported, as approximate.

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
  subway feeds carry no coordinates; they are used only for estimates
  (`mta-subway`).
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
- **AMB** — cite the source and its update date (the credit, and every
  estimate's "Predictions … old"); do not alter the data: AMB's predictions are
  never re-served as AMB's, and the position GoWay derives from them is labelled
  as GoWay's estimate everywhere it appears (`positionBasis: 'estimated'`, the
  hollow glyph, the card). A derived product is what the reuse conditions
  allow; presenting it as AMB's measurement would not be.
- **MTA subway** — as for MTA above, and the same estimate labelling: the
  subway feeds carry no coordinates, so nothing here is "MTA data, modified"; it
  is GoWay's arithmetic on MTA's predictions, said so on every train.
- **NAP (AISA, EMT Fuenlabrada)** — the credit "Powered by MITRAMS" is
  required on every use and is drawn whenever their buses are.
- **Completeness**: each source says whether it carries a whole network in its
  coverage (`completeness: 'network'`) or only some operators (`partial`:
  adsb.lol, AMB, AISA, EMT Fuenlabrada, Digitraffic). Only whole networks
  count as coverage for other features (`Coverage for other features` below).

### Rejected or deferred

| Source | Why |
| --- | --- |
| **OpenSky Network** | "Any use by a for-profit or commercial entity … requires a written license", and "integration into a live product … requires a written license". |
| **adsb.fi** open data | "for personal, non-commercial use only". |
| **airplanes.live** | API answered 403 asking projects to email for access; terms not readable; secondary sources say non-commercial only. Not verifiable → not used. |
| **Bicing** (operator GBFS, `barcelona.publicbikesystem.net`) | Answers without a key but states **no licence**; data without a grant is not ours to redistribute. The licensed route is **Open Data BCN** (CC BY 4.0, tokenised "securitzat" resource), whose portal refused connections all day — **deferred**: the GBFS adapter will carry it once the token flow is confirmed (it needs a two-URL/no-discovery mode). So Barcelona has no bike share today. |
| **TMB** (Barcelona city buses, iBus; metro, iMetro) | No vehicle positions anywhere; arrival predictions only, behind an `app_id`/`app_key` registration. The terms allow derived works and commercial use, but a key is issued "solely for the application indicated" — so it is **deferred to GoWay registering its own key**, not built on a borrowed one. With a key, both join `arrivalEstimates.ts` as estimates (the `tmb-bus`, `tmb-bus-articulated` and `tmb-metro` fleets are ready). Barcelona's red city buses and its metro are therefore **not on the map**. |
| **EMT Madrid** (MobilityLabs) | Arrival predictions only, ODbL; registration required and the per-account quota cannot feed a city-wide poll. Deferred. |
| **CRTM** (Madrid region) | Static GTFS only; no open realtime. |
| **Generalitat de Catalunya**, **Moventis**, **Sagalés** | No open realtime feed found. (Nitbus is AMB's and comes with `amb-bus`.) |
| **Bicing via Open Data BCN** | CC BY 4.0 but the resource needs a registered token; registration pending. |
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
reference: GNSS or barometric), callsign, line, mode, availability, MMSI. A
transit vehicle also carries its line's colours, its `track` (`shapeId`,
`alongMeters`, `offsetMeters`) with `trackStatus` (`on_track | off_track |
unknown`), and `positionBasis` (`reported | estimated`).
`LiveSource` carries the licence, credit, coverage, status
(`idle | starting | live | stale | unavailable`), `completeness` (`network | partial`), last successful update and the
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
| `gtfsRealtime.ts` + `protobuf.ts` | Renfe, MTA Bus, LIRR, Metro-North, AISA, EMT Fuenlabrada | A ~250-line bounds-checked protobuf reader for the `VehiclePosition` and `TripUpdate` subset (no protobufjs, and `pbf` is ESM-only); a truncated body throws rather than half-reads; per-operator line/label mapping |
| `arrivalEstimates.ts` | MTA subway, AMB | Estimated positions from `TripUpdate`s along the static shape (`Estimated positions` below) |
| `../staticGtfs.ts` + `../zip.ts` | Every source with a static GTFS | A zip reader (central directory, `inflateRawSync`, only the four files needed), a CSV parser, shapes with their running length, trip → shape, track matching |
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
- Limits (`LIVE_POLICY`, `config/live.ts`): 2,000 sockets per process
  (handshake refused with `live_capacity`), and a token bucket per socket for
  subscriptions (a burst of 10, 60 a minute) — beyond it,
  `rate_limited` with `retryAfterSeconds`, and the previous rooms are kept.
- **Nothing about the viewer is kept**: the box is used to pick rooms and
  dropped — not stored on the socket, not counted per address, not logged. A
  viewport is not the viewer's location, but it is often near it.

### The client

| Piece | Where |
| --- | --- |
| Switch | The map-feature registry's `live` (`lib/map/mapFeatures.ts`, `docs/MAP_FEATURES.md`): the person's choice in the settings dialog (development builds), and `?live=1` in development only |
| Gate | `features/explore/ExploreScreen.tsx`: `useMapFeature('live')` mounts the lazy `LiveHost` in the top-right stack, under the settings button, the time of day and the Landmarks control; off, it unmounts and the layer, its credits and the coverage go with it |
| HTTP | `lib/live/client.ts`: one SDK client for `live.sources()` and `live.shape()`, always the real API (never the fixture transport) — shared by the shape cache and the settings dialog's **Live data sources** |
| Socket client | `features/live/liveClient.ts` (`socket.io-client`, debounced subscriptions, honours `rate_limited`) |
| State and motion (pure, tested) | `features/live/liveStore.ts`, `motion.ts` |
| Panel and copy | `features/live/LivePanel.tsx`, `format.ts`, `messages.ts` (en/es), `kinds.ts` (data colours) |
| Map seam | `MapCanvasProps.live` (`MapLiveLayer`, a pull interface: no React render per frame), `MapAttribution` `extra` credits |
| MapLibre adapter | `components/map/liveLayer.web.ts` — one GeoJSON source, a symbol layer with canvas-drawn glyphs (directional and still variants), a selection ring, picking; moving things are re-set on the map's ONE animation clock (`perf/animationClock.ts`, at the quality profile's rate, paused when hidden or idle) and at most every 50–250 ms by zoom, and at most the profile's `live.maxEntities` are drawn, nearest first (`docs/MAP_PERFORMANCE.md`) |
| 3D | `components/map/engine/live3d/livePass.ts` (three.js, instanced meshes, stalks) as a **pass of the city engine** (`CityEngine.renderPass`, `City3dHandle.addPass`): one renderer, one scene stratum, MapLibre's depth buffer — "One engine, one scene" (`MAP_3D_CITY.md`). `anchorMath.ts` places a shape at its real altitude, pinned against MapLibre's `MercatorCoordinate` |

**Motion, honestly.** Ages are measured on the server's clock (every message
carries `at`). Then:

- A train or bus **on its track** is placed by one number, its distance along
  the shape, and moved by changing that number (`track.ts`): between two
  reports it walks along the LINE from where it was drawn to the new report —
  round the curve, never across it. A shape change (a new trip) jumps.

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
are never scaled**. Altitude is above mean sea level, and so is the ground the
map draws: 0 on the flat map, the elevation model's height with relief's 3D
terrain on — right to within the model's accuracy, as long as terrain is not
exaggerated.

## Tracks

A reported train or bus position is noisy, often snapped to a station, and a
glyph walked in a straight line between two of them cuts every curve. So the
hub puts each transit vehicle **on its operator's own published track**
(`staticGtfs.ts → matchTrack`):

1. The trip's shape: the realtime trip id looked up in `trips.txt` (exactly,
   then without a trailing `_<n>`, then by train number — LIRR and
   Metro-North name trips by it), else the route's shapes.
2. The reported position projected onto it (a local equirectangular
   projection per segment; metres). Within **75 m** (`SNAP_TOLERANCE_METERS`)
   it is `on_track`, with `track = { shapeId, alongMeters, offsetMeters }`.
   With several candidate shapes (a route's two directions, its branches), the
   nearest wins, and among near-ties (±5 m) the one whose direction agrees
   with the vehicle's last position.
3. Farther than 75 m from every candidate, or no shape known:
   `trackStatus: 'off_track'` / `'unknown'`. The vehicle is drawn **exactly
   where reported, never animated, styled approximate**, and its card says so.

The client fetches each shape once (`GET /live/sources/{sourceId}/shapes/{shapeId}`,
`LiveShape`: positions and the running length at each, cached a day) and
draws the vehicle at `alongMeters` on it.

**This is a display correction, not data**: the reported position is still
what the contract carries in `position`, unchanged; `track.offsetMeters` says
how far the drawing moved it. Nothing is snapped by more than 75 m, and nothing
off a track is moved at all. Measured on 2026-10-11: Renfe 124 of 124 Rodalies
trains on track (offsets ~0 m — Renfe's own positions are on its shapes), FGC
33 of 38, MTA buses mostly within 10 m.

## Estimated positions

New York's subway runs underground and publishes no coordinates; AMB publishes
arrival predictions and no positions. Where a network publishes only
**predictions**, GoWay may estimate where each vehicle is — only because the
licence allows a derived product (MTA terms; AMB's Llei 37/2007 conditions) and
only labelled as an estimate everywhere (`adapters/arrivalEstimates.ts`):

- Each predicted stop's place along the trip's shape (`stops.txt`, projected;
  a stop farther than 150 m from the shape is ignored). With the next stop A
  due at `tA` and the one after, B, at `tB`, the vehicle is
  `sA − (sB − sA)·(tA − now)/(tB − tA)` along the line — short of A by the
  distance it covers at the A→B pace in the time left, never more than one
  spacing back. A train the feed says is STOPPED AT a stop is at that stop.
- **Nothing is said when nothing honest can be**: a next stop due more than
  10 min away, a trip that has not left its first stop, or a last stop more
  than 90 s away → no vehicle. A trip with no shape (New York's realtime-only
  patterns) takes the one of its route's shapes its stops lie along in order,
  or is dropped.
- Every such entity has `positionBasis: 'estimated'`, `speedMetersPerSecond:
  null` and `track` on its shape. The map draws it **hollow**, the card says
  "Estimated from arrival predictions, not a GPS position: placed along its
  line between stops", and the age shown is the predictions' age.
- **Never in 3D.** A model in the scene reads as a sighting; an estimate is
  not one. And the subway would stand on the street above its tunnel — the
  city engine has no underground. So estimates stay a flat, hollow glyph,
  still to scale (a ten-car subway train is ~160–190 m long) and still in its
  line's colour.

Measured on 2026-10-11 at ~15:15 UTC: 246 subway trains and 244 AMB buses
estimated, from 8 + 1 feeds.

## Underground

Reported trains run in tunnels too — Madrid's Cercanías under Sol, Barcelona's
Rodalies under the Eixample and La Sagrera. A model standing on the street
above a tunnel is as wrong as a subway train on it, so a train in a tunnel is
**never drawn in 3D**: its flat glyph stays, dimmed to
`UNDERGROUND_ICON_OPACITY` (0.55) at every zoom — below the street, not on it.

Which track is underground is OpenStreetMap's, read from the basemap the map
already draws (`components/map/railTunnels.ts`, `liveLayer.web.ts`): every
railway in OpenMapTiles' `transportation` layer (`class` `rail` or `transit`)
with `brunnel=tunnel` or a negative `layer`. The railway NEAREST the train
(within 35 m of its on-track position) decides, so a surface line beside a
tunnel portal wins where the train is on it. The basemap carries tunnels in
its z13–14 tiles; where none is loaded the train keeps its last verdict
(unknown at first: drawn as on the surface). GTFS says nothing about it:
Renfe's, AMB's, the MTA subway's and LIRR's static files have no
`levels.txt` (checked 2026-10-11), and Renfe's `stops.txt` carries only a name,
a position and wheelchair access — so OSM is the source. Buses are not classified (road tunnels are short and rare on
their routes).

**Glyph and model.** With the 3D city on, from z15 a train's, bus's or ship's
model REPLACES its glyph (blended over z14–15): a flat to-scale symbol over a
3D street reads as a second vehicle floating above it, which is what was seen
at Sol. Farther out, where a model is a few pixels, the glyph stays. The
train glyph is 1:8 (a 100 m train ~12 m wide at street zoom), a bus 1:3.4.
The models themselves are real size — one unit is one metre, pinned per fleet
in `fleets.test.ts`, and the anchor's metre in `liveAnchor.test.ts` against
MapLibre's `MercatorCoordinate` at Madrid's latitude.

## Vehicles (`features/live/fleets.ts`)

A **registry**, so a new operator or fleet is a line of data: each fleet is a
generic form (`emu`, `bus`, `double-deck`, `coach`, `aircraft`, `vessel`) with
real proportions (cars, car length, gap, width, height) and a **livery as flat
colour bands** (lower body, stripe, body, windows, roof), approximating the
operator's vehicles as seen in public photographs. Rules map a vehicle to its
fleet from what the feed says (source, line, label), first match wins, falling
back to a generic train or bus:

| Fleet | Matched by |
| --- | --- |
| `rodalies-civia`, `cercanias-civia` | Renfe, `R…` lines vs. the rest |
| `fgc-bv`, `fgc-lla` | FGC S1/S2/L6/L7/L12 vs. the rest |
| `lirr-emu`, `mnr-emu` | LIRR, Metro-North |
| `mta-bus`, `mta-bus-articulated`, `mta-coach`, `mta-double-deck` | MTA bus; SBS `+` lines, express `X/BM/BXM/QM`, `SIM` |
| `mta-subway-a`, `mta-subway-b` | Subway numbered lines (51-ft cars) vs. lettered (60-ft) — glyph length only, never 3D |
| `amb-bus` | AMB |
| `tmb-bus`, `tmb-bus-articulated`, `tmb-metro` | Ready for a TMB feed |

**No logos, wordmarks, emblems, numbers or text are ever drawn on a vehicle**
— they are the operators' trademarks, and none of them is data. Colours and
proportions only; the line's colour lives on the 2D glyph and its label.

The models come from the shared model library (`MODEL_LIBRARY.md`), the
same one city life draws with — there is no live-only model set. Geometry
comes from ONE function, `engine/live3d/liveModels.ts → buildLiveModel(model,
detail, source)`: each form is one library model (`emu` → `train.commuter`,
`bus`/`coach` → `vehicle.bus`, `double-deck` → `vehicle.bus-double`,
`aircraft` → `aircraft.airliner`, `vessel` → `vessel.cargo`), stretched per
axis to the fleet's real length, width and height; the fleet's
`livery.body` paints the library's tintable body (an aircraft's fin wears
`livery.stripe`), everything else keeps the library's colours. Light is baked
into vertex colours, one `InstancedMesh` per fleet and detail. Budgets,
pinned by `fleets.test.ts` (≤ 1,500 triangles near, ≤ 200 far): an EMU car
522 / 36, a bus 540 / 60, a double-decker 596 / 84, an aircraft 320 / 136,
a ship 1,060 / 36. Below z14.5 every car is drawn in its far form. The pass
draws nothing until the library has loaded.

The registry is the interface — operator/fleet → a model (`form`, with its
proportions) + a livery; the pass and the matching rules know nothing of the
geometry.

## Coverage for other features (`lib/live/coverage.ts`)

City life draws SIMULATED buses and trains; where GoWay Live draws the real
network, it should not draw both. The live layer publishes where real
vehicles are drawn, on a tiny channel with no imports (so reading it loads
nothing of GoWay Live, and live never depends on city life):

```ts
import {
  getLiveCoverage, subscribeLiveCoverage, liveCoverageTileOf,
  LIVE_COVERAGE_KINDS, LIVE_COVERAGE_ZOOM, // ['bus','tram','train','metro','ferry'], 12
  type LiveCoverage, type LiveCoverageKind,
} from '@/lib/live/coverage';

// LiveCoverage = { kinds: Record<LiveCoverageKind, { tiles: ReadonlySet<string /* z12 "x/y" */>; fresh: boolean }> }
const stop = subscribeLiveCoverage((coverage) => {         // called at once, then on change
  const bus = coverage.kinds.bus;
  if (bus.fresh && bus.tiles.has(liveCoverageTileOf(lat, lon))) { /* real buses here */ }
});
```

A tile is in a kind's set when a **whole-network** source of that kind
(`completeness: 'network'`) is live, has sent vehicles of that kind, and its
coverage meets the (padded) visible map; at most 1,024 tiles per kind.
`fresh` is false while no such source is live — then a reader must not treat
anything as covered. With live off, or its transit toggle off, coverage is
empty. Kinds come from the transit mode (`rail` → `train`, `subway` → `metro`).

## Gates

- **Backend** `LIVE_SOURCES` (each feed opted into by id; an unknown id fails
  the boot parse). There is no other switch: live runs when a usable source is
  listed. None: no poller, no `/live` namespace, `GET /live/sources` →
  `503 service_unavailable`.
- **Frontend** the registry's `live` (`docs/MAP_FEATURES.md`): the switch in
  the settings dialog's Labs (offered in development builds only, until
  goway.to has a live backend), or `?live=1` in a development build.

### What the flag costs when off

Measured with `expo export --platform web`, no flags set, `origin/main`
(`37af504`, with the map-feature registry that already registers `live`)
against this branch (separate Metro caches, `--clear`):

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,994,290 B (1,765,294 gz) | 6,997,484 B (1,766,298 gz) | **+3,194 B (+1,004 B gz)**: the SDK's HTTP contract for `live.sources()` and `live.shape()`, the `MapCanvas` live seam (the gated `import()`, picking, credits, the 3D pass hand-off), `ExploreScreen` mounting the host from the registry |
| `__common` (first paint) | 81,774 B | 81,774 B | identical |
| `LiveHost` (lazy) | — | 47,915 B | the feature: store, tracks, fleets, client, panel, the SDK's live protocol |
| `liveLayer` (lazy) | — | 8,061 B | the MapLibre adapter |
| `client` (lazy) | — | 271 B | the live HTTP client, shared by the feature and the settings dialog |
| `MapSettingsPanel` (lazy) | 62,465 B | 64,039 B | the **Live data sources** credits |
| `lazyChunk` (lazy, three.js) | 3,735,775 B | 3,744,527 B | the 3D pass and its models |

So the flag off costs ~1 KB gzipped of seam and contract on first paint and
nothing else. The first export put **socket.io-client into `__common`** (+54
KB): `@oxy.so/core` already `import()`s it, and a static import from a second
lazy chunk made it shared. It is now `import()`ed in `liveClient.ts`. A Bloom
icon the flyover also uses was hoisted the same way (+578 B); the toggles use
colour dots instead; and the live HTTP client, shared by two lazy chunks, was
hoisted (+272 B) until both reach it by `import()`. What is pinned by test rather than by measurement:
`components/__tests__/liveChunk.test.ts` (the socket client and the live
protocol are imported only in `features/live`; the feature is reached only by
one `import()`; the live HTTP client only by `import()`; the adapter only by `import()` from `MapCanvas.web.tsx`) and
`engine3dChunk.test.ts` (three.js only in the engine chunk, the live adapter
importing the engine folders type-only).

## Running it locally

```bash
# Backend (needs its Postgres as always; live itself stores nothing)
LIVE_SOURCES=adsb-lol,renfe-cercanias,fgc-geotren,mta-bus,mta-lirr,mta-mnr,mta-subway,amb-bus,aisa-bus,emt-fuenlabrada,nyc-bikeshare,digitraffic-ais \
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
| MTA subway | 8 / 30 s | none published |
| AMB | 1 / 30 s | none published |
| AISA, EMT Fuenlabrada | 1 / 20 s each | none published |
| Static GTFS | each file once a day per process (≤ 120 MB) | — |

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
   the registry offers `live` on web only). MapLibre Native can draw the same
   GeoJSON symbol layer with a `ShapeSource`; the pull interface would need a
   ~2–4 Hz React update there instead of a frame loop. The 3D pass stays web
   only, as the city engine does.
6. **Observability** — per-source poll latency, failure counts and entity
   counts as metrics (they are in `GET /live/sources` and the logs today).
7. **Turn it on**: set `LIVE_SOURCES` to the vetted subset, then drop
   `offer: 'development'` from the registry's `live` entry.

## Limits, honestly

- **Coverage is patchy by nature**: Barcelona has aircraft, Rodalies and FGC
  trains and AMB's metropolitan buses (estimated), but not TMB's city buses or
  its metro (key pending), no bike share (token pending) and no ships; New
  York has aircraft, buses, LIRR, Metro-North, the subway (estimated) and bike
  share, but no ships; Madrid has two bus operators' real positions only.
- Estimates are only as good as the predictions: a delayed train the operator
  has not re-predicted is drawn on time. The hollow style and the card say
  so; the map never shows an estimate as a sighting.
- Renfe, FGC, LIRR and Metro-North positions are coarse (often snapped to
  stations or published once a minute); MTA bus fixes are typically 20–40 s old
  on arrival. The UI states every age; it cannot make them younger.
- adsb.lol's dynamic rate limit means aircraft can go stale for a poll or two
  under load; they are shown stale, not extrapolated.
- One process holds everything in memory; a restart starts from empty and
  refills within one poll interval.
- HSL, Bicing, TMB, EMT Madrid, NYC Ferry and Baltic-only ships are
  documented above as next sources, not built.
