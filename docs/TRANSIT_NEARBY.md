# Transit near a place

`GET /api/v1/transit/nearby?latitude=&longitude=&radiusMeters=&maxStops=&maxDepartures=`
answers the public-transport stops around a point and the next departures from
each, for the place details (Bloom's `PlaceTransit`). SDK:
`goway.transit.nearby(query)`. Contract: `packages/contracts/src/transit.ts`.
Engine: `packages/backend/src/live/transit/`.

Phase 1 of public transport: stops and departures. No journey planning, no
alerts, no vehicle-to-stop tracking.

## What it answers

- `stops`, nearest first (at most 10): station name and place, straight-line
  `distanceMeters`, `modes`, every `line` that calls there (the operator's own
  short and long name, mode and `route_color` / `route_text_color`, `null`
  when it publishes none — a colour is never invented), and the next
  `departures` (soonest first, at most 10 per stop).
- Every departure carries `basis`: **`scheduled`** (the operator's published
  timetable for that service day) or **`realtime`** (the operator's own
  prediction for that trip, with `delaySeconds`). A schedule is never presented
  as live: the app draws the live dot, tone and spoken "live" only for
  `realtime`, and a timetable time is a clock time, not a countdown.
- `operators`: every served operator covering the point, with its `attribution`
  and `licence` (the text and links its data is re-served under, shown while its
  stops are drawn), `availability` (`ready` / `preparing` / `unavailable`),
  `realtime` (`none` / `live` / `unavailable`) and when the timetable was read
  and the predictions were stamped.
- **No coverage is an answer**: a point no served operator covers is
  `{ stops: [], operators: [] }` with 200. Errors are the shared closed codes:
  `bad_request` (unknown or repeated parameter), `validation_failed` (a value
  outside the bounds: radius 50-1000 m, stops 1-10, departures 1-10, never
  clamped), `service_unavailable` (no live layer on the deployment) and
  `rate_limited`.

The app shows the section only when the answer has a stop: while loading, on any
failure, with no coverage and with no stop in range it draws nothing.

## Which operators are served, and why

Only sources that are already in the live catalogue, whose licence was read to
allow public, commercial redistribution (`licenceCheck`, held by
`licence.test.ts`), that the deployment configured (`LIVE_SOURCES`; one still
`awaiting` a permission or missing its key is not configured), and that the
catalogue **enrols** with a `departures` entry after its archive was measured.
`isServable` repeats the licence test at the point of serving, so a source
without a read licence, an https credit and licence, or a whole-archive static
GTFS never appears (`transitService.test.ts`).

| Source | Timetable (measured 2026-10-20) | Predictions |
| --- | --- | --- |
| `amb-bus` (Barcelona area, buses) | 952 k stop times, 4,972 stops | **Yes** — `TripUpdates` at `trips.bin`; trip ids join the timetable (425 of 425) |
| `mta-subway` (New York) | 565 k, 1,489 stops | No — realtime ids (`126800_A..N04R`) do not equal static ids (`ASP26GEN-1038-Sunday-00_000600_1..S03R`); GoWay does not guess which trip they are |
| `mta-lirr` | 24 k | No — GoWay reads this feed for positions only; whether its `TripUpdates` ids join the timetable is unmeasured |
| `mta-mnr` (Metro-North) | 467 k | No — same, unmeasured |
| `renfe-cercanias` (Rodalies and Cercanías, plus long distance) | 1.85 M + 66 k | No — the catalogued feed is vehicle positions only |
| `emt-fuenlabrada` | 80 k | No |

Not served, and why: every source in the live catalogue not listed above is not
enrolled (its archive was not measured, or it publishes a routes-only subset,
or its static GTFS is not a whole archive: `fgc-geotren` is three separate
files, `mta-bus` is one zip per borough). `providers.ts` entries (73 feeds)
were not enrolled either: each is one `departures` line once its archive is
measured and its static file's licence confirmed to be the feed's. The
sources the live layer refuses for their licence (`docs/MAP_LIVE.md` →
Excluded) are refused here for the same reason.

## What it costs

A timetable is read when the first request in an operator's coverage arrives,
kept in typed arrays (about 50 bytes per stop time; the six operators together
are 3.5 M rows and measured 177 MB resident, Renfe's Cercanías alone ~90 MB),
refreshed daily while it is used and let go after two hours unused. A global
budget of 4 M rows (~200 MB) lets the least recently used operator go first.
Reading a big timetable takes seconds (Renfe: ~4 s, AMB 1.3 s, MTA subway
0.8 s) in slices that yield to the event loop, with one block of about 0.7 s
at the worst; a request that arrives meanwhile waits up to 8 s, then answers
that operator as `preparing` (the app asks again every 8 s). A failed read
retries with backoff and after three failures reports `unavailable`.

Predictions are fetched on demand, at most once per catalogued interval (30 s
for AMB) per API task, and only while someone asks about that operator. They
are older than 5 minutes by the feed's own header → ignored, every departure
`scheduled`, the operator `realtime: 'unavailable'`. With several API tasks,
each task asks AMB's feed itself (the live layer's lease does not cover this
path): the load is tasks × one request per 30 s while requests arrive.

## Rules it keeps

- **Never guessed.** A stop time with no time is dropped, not interpolated; a
  feed with `frequencies.txt` rows or without `agency_timezone` is refused; a
  prediction whose trip id is not in the timetable is not applied; a prediction
  more than three hours from any service day of its trip is not applied.
- A trip's last stop is not a departure; `pickup_type=1` is not boardable. A
  stop before the first predicted stop of a trip has been passed and is not
  served; a canceled trip and a skipped stop are dropped.
- Lines listed at a stop are every line the timetable calls there, whichever day
  it runs (a Sunday-only line is listed on a Tuesday); departures are the ones
  that run today.
- A headsign is the trip's `trip_headsign`, else the name of the station it
  ends at; otherwise `null`.
- Platforms with a `parent_station` are answered as that station.
- Service days follow GTFS (noon minus twelve hours local time, times past 24:00),
  so the two daylight-saving days are right.

## Privacy

The requested point is used for the answer and forgotten: no cache is keyed by
it, no log line carries it (the only lines name an operator and a reason; a
test holds that), validation errors name the field and never the value, and the
answer is `Cache-Control: private, max-age=15`. In the app the point is the
**place's** public location, never the reader's. The app's query key rounds it
to about 11 m in memory.

## Limits and open decisions

- **Realtime coverage is one operator.** More needs, per operator: its
  `TripUpdates` URL under the same licence (a catalogue line,
  `departures.realtimeUrls`), and either static ids that equal the realtime ids or a
  written join rule. The MTA subway's rule is derivable (the realtime id's
  tail equals the static `shape_id`, its head is the origin time) but is a
  guess about someone else's id scheme; it needs the owner's decision.
- Only absolute prediction times are read (not bare `delay` values), and
  `schedule_relationship` only for canceled / skipped / no data.
- Enrolling an operator measures first: rows, build time, whether it has
  `frequencies.txt` (refused), whether its static GTFS licence is its feed's.
- `other` mode (an operator that says nothing) is drawn with Bloom's default bus
  glyph; the line badges still name the lines.
- Tapping a stop does not yet pan the map to it.
