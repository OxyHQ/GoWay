# GoWay Data Hub

One platform for everything that arrives from outside GoWay and is served on
the map: aircraft, transit, bike share and ships (GoWay Live,
[`MAP_LIVE.md`](MAP_LIVE.md)), public cameras ([`CAMERAS.md`](CAMERAS.md)), and
whatever comes next. A new channel is a new kind of data on the same rails, not
a new stack.

```
Provider (data + licence) -> Source (one per standard) -> Ingest (batch sync, or poll on demand)
  -> Store (Postgres/PostGIS, object store) -> Relay (GoWay's own copy)
  -> Realtime rooms (map tiles) + REST -> SDK -> Map layer
```

## What is shared, and where it lives

| Piece | Where | Used by |
| --- | --- | --- |
| Provider definition and the licence rule | `packages/backend/src/hub/provider.ts` | Live sources, camera providers |
| Rooms: who watches which tile | `packages/backend/src/hub/rooms.ts` | `LiveHub`; the room model for any realtime channel |
| Small XML reader for flat feeds | `packages/backend/src/hub/xml.ts` | SIRI-VM, Hong Kong cameras |
| Credit/licence link and feed text on the wire | `packages/contracts/src/hub.ts` | `live-source.ts`, `cameras.ts` |
| Cursors, validation, errors | `packages/backend/src/http/` | every route |

What is **not** shared is deliberate. `LiveHub` is a demand-driven poller with
cluster leases, backoff and a GTFS join; it exists for feeds that must be asked
continuously. A camera catalogue is synced in batches and its pictures are
fetched when somebody looks, so cameras use the provider definition and the
rooms but not the poller. Forcing both through one scheduler would have put
production's Live path at risk for no gain.

## The licence rule

GoWay re-serves only what its licence allows it to re-serve publicly and
commercially. A provider is data, and it carries how that was established:

```ts
licenceCheck: { verifiedOn: '2026-10-22', quote: '…the words…', source: 'https://…' }
```

`licenceProblems()` (`hub/provider.ts`) refuses a provider without it, a future
date, a non-https source, a keyed provider that does not say where the key is
registered, and data that would be dropped before it goes stale. Each channel's
`licence.test.ts` runs it over its whole registry. The credit travels with the
data and is shown whenever it is drawn.

## Adding a provider to a channel

1. Read the licence. If it does not clearly allow redistribution, stop: it goes
   in the channel's "waiting" list with the reason, not in the registry.
2. Add the provider as data in the channel's `providers.ts` with its
   `licenceCheck`.
3. Write or reuse the source for its standard (a source per standard, not per
   provider: `sources/arcgis.ts` reads any ArcGIS layer given a mapper).
4. Save a trimmed copy of the real feed as a fixture and test the source against
   it with a fake `fetch`.
5. Run the sync dry against the live feed before enrolling it. Fixtures cannot
   see a field the real layer names differently.

## Adding a channel

A contract in `packages/contracts` (zod; `API_OPERATIONS`; `bun run openapi`), a
schema and migration, a repository, sources, routes, an SDK group and a map
layer — the cameras commits are the worked example, in that order.
