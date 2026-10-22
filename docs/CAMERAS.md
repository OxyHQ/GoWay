# Public cameras

A catalogue of public cameras from official open-data providers, GoWay's own
copy of each picture, and (next) aggregates counted off the pictures. Built on
the [Data Hub](DATA_HUB.md).

## What a client sees

- `GET /cameras?west&south&east&north[&kind]` — the cameras in a box, keyset
  paged, each with its provider's credit and licence and a `status`.
- `GET /cameras/{id}` — one camera.
- `GET /cameras/{id}/snapshot` — **GoWay's** copy of the picture. A client never
  talks to the operator and never sees the operator's URL.
- `GET /cameras/{id}/observations` — what the video worker counted (below).
- `GET /camera-providers` — who the cameras come from and on what terms.

SDK: `goway.cameras.list | get | observations | providers | snapshotUrl`.

`status` is worked out at read time from the age of the newest frame against the
provider's own windows: `live`, `stale`, `offline`, or `unknown` (listed, no
frame seen yet). Show it, and `lastFrameAt`, with every still: a snapshot is as
old as the camera's last frame.

## How the data gets in

`bun run cameras:sync -- --target-database=<name> [--only=<id>] [--dry-run]`
reads each provider's catalogue and upserts by `(providerId, sourceId)`. A camera
is **retired** only when a read that said it was complete did not list it; a
failed, partial or empty read retires nothing, and a retired camera returns when
it reappears. The command runs every provider before exiting non-zero, and
prunes observations past `OBSERVATION_RETENTION_DAYS`. It is an operator
one-shot like `roadrules:sync`: `oxy-postgres` is not publicly reachable, so on
a schedule it runs as an `ecs run-task` (see `import-osm-pois.yml` for the
shape and for the IAM grant it needs). **No schedule is wired yet.**

## The relay

`cameras/relay.ts` fetches a picture on demand and holds it for half the
camera's refresh interval (5 s to 5 min), so a thousand viewers cost the
operator one request. The URL is third-party data, so:

- every hop of a redirect must resolve only to public addresses
  (`publicHost.ts`): loopback, private, link-local and cloud-metadata addresses
  are refused, literal or by DNS;
- the body is capped at 5 MB;
- the type comes from the **bytes**, not the operator's label (Toronto serves
  PNG files labelled `image/jpeg`), and anything that is not JPEG, PNG, GIF or
  WebP — HTML and SVG included — is refused;
- responses carry `nosniff`;
- one fetch per camera at a time; a failed camera is not asked again for 15 s,
  and an old copy is served through an outage rather than an error.

A provider is relayed only when `redistribution: 'relay'`; otherwise the camera
is listed and `snapshot` answers `not_found`.

## Providers

Enrolled (licence read 2026-10-22; evidence in `cameras/providers.ts`):

| Provider | Cameras | Format | Licence |
| --- | --- | --- | --- |
| Fintraffic Digitraffic (Finland) | 2,271 presets | GeoJSON + times, JPEG 10 min | CC BY 4.0, "even commercially" |
| Transport Department (Hong Kong) | 1,013 | XML, JPEG 2 min | DATA.GOV.HK terms: distribute and reproduce, commercial |
| City of Toronto | 336 | JSONP, PNG | Open Government Licence – Toronto |
| Iowa DOT | 1,263 | ArcGIS layer, JPEG | CC BY 4.0 on the layer. **Its "Additional Terms" (Iowa DOT GIS Data Terms of Use) could not be read — the page refuses automated clients. Confirm.** |

Waiting on a permission or a decision, **not** enrolled:

- **DGT (Spain), Madrid, Catalonia (SCT), TfL JamCams (London)** — workable
  feeds, but the legal notice and the open-data tag disagree or the terms page
  was not read. DGT's notice reserves "reproducción, distribución,
  comercialización" while the portal says CC BY; TfL requires the logo kept and
  forbids cropping. Ask in writing.
- **DriveBC (British Columbia)** — an OGL-BC statement from 2016; the current
  catalogue licence could not be reached.
- **NZTA (New Zealand)** — "all rights reserved"; no licence found.
- **Singapore (LTA via data.gov.sg)** — licence fits (SODL v1.0) but the feed
  fell from 90 to 8 cameras; re-check before depending on it.
- **Austin** — public domain list, but its images answer 403 from here.

Rejected: Norway (registration), Sweden Trafikverket, Transport NSW, QLDTraffic
(keys), Germany Autobahn API (empty), Ireland TII (403), National Highways
(404), Seattle (no terms), the 511 platforms (undocumented site APIs, keyed
official APIs), VicRoads (403), South Tyrol Open Data Hub (metadata only: the
pictures are third-party pages). Not reachable from the research sandbox:
Caltrans, WSDOT, NYC DOT, TxDOT, MD CHART, Houston TranStar — retry from another
network.

Iowa shows why a provider's own id is not always the camera's: a rest area's
CENTER, ENTRY and EXIT views share one `device_id`. Iowa's camera id is the
picture's file name, and the first draft that used `device_id` silently dropped
399 cameras as "duplicates". The live dry run found it; fixtures could not.

## On the map

`features/cameras/`: the `cameras` map feature, on for everyone (`?cameras=0` in
a development tab turns it off). Pins
from zoom 12, fetched for a settled viewport, at most
`QualityProfile.cameras.maxMarkers` nearest the centre, never clustered with
places; each provider's credit is on the map while its pins are drawn. A pin
opens `/camera/<id>`, composed from Bloom (`Screen`, `PageHeader`, `Badge`,
`Admonition`, `GroupedSection`, `EmptyState`, `Loading`): the still on its
camera's own beat, its age, its status in words ("Up to date", never "Live"
for a still), the credit and the licence.

## Privacy

- A frame is processed and discarded. GoWay stores no picture, face, plate or
  identity: `camera_observations` holds counts per class, flow, congestion and
  whether the picture can be trusted — nothing else.
- Viewing needs no account and sends no location. The relay keeps no viewer.
- A camera's picture is the operator's public one; GoWay adds nothing to it.

## Not built yet

- **Video worker and observations.** The contract, table, route and SDK exist;
  nothing writes observations yet. Design: a Python worker outside the Bun
  workspaces (`packages/camera-worker`, like `reconstruction-worker`) reading
  frames from the relay, counting by class across a line, and posting
  aggregates through a versioned contract.
- **Streams (HLS/MJPEG).** Iowa publishes HLS for most cameras. The relay does
  snapshots only; a playlist relay has to rewrite segment URLs and is built when
  a provider needs it.
- **Realtime.** Camera status and observations over the `/live` rooms.
- **A schedule** for `cameras:sync`.
