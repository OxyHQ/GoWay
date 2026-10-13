# Road rules: who may use which road

GoWay's one model of road access — shared by the city tiles, the simulated
traffic, the street renderer and (next) the public API and `@goway.to/sdk` — so
that a car is never drawn in a bus lane, on a service lane of a park or on a
road that is closed to it, and so that a client asking "may this vehicle go
here?" gets the answer the map already uses.

**Status.** Part 1 (road access per way) is built. Zones and per-country rule
sets (low emission zones, environmental labels, speed defaults, driving side),
their sync from official sources and the routing options are specified below
and not built. Nothing here is read by routing yet; city life stays simulated
(`MAP_CITY_LIFE.md`) and consumes the rules, it never feeds them.

## 1. Access per way (built)

**One reader.** `packages/contracts/src/road-access.ts`, shipped as
`@goway.to/sdk/road-access`. Nothing else maps `access=*`, `motor_vehicle=*`,
`bus=*` and friends to a yes or a no.

- **Users** (`ROAD_USERS`): `car`, `taxi`, `bus`, `hgv`, `van`, `delivery`,
  `motorcycle`, `moped`, `bicycle`, `foot`, `emergency`.
- **Values** (`ACCESS_VALUES`): `yes`, `designated`, `permissive` may pass
  through; `destination`, `delivery`, `customers`, `permit` may only arrive
  (`accessLevel` → `local`); `private`, `no` may not.
- **Resolution** (`resolveRoadAccess(highway, tags)`): per user, the first
  readable key of OSM's hierarchy wins — `motorcar` → `motor_vehicle` →
  `vehicle` → `access`; buses and taxis also read `psv`; emergency vehicles
  read only `emergency`, so a general ban never stops them. A user nothing
  speaks for gets the class default (`defaultRoadAccess`); a value that is not
  one of OSM's is treated as absent. Parking aisles, driveways, drive-throughs
  and emergency accesses are closed to every motor user whatever else is
  tagged. Restricted purposes (`agricultural`, `forestry`, `military`) are
  `private`.
- **Tiles** (schema 4, `lib/map/cityRoads.ts`): a road piece carries `access`
  only where it differs from its class (`bus=designated;car=no`), so the
  overwhelming majority of ways pay nothing. A road only buses (or taxis) may
  use is kept, with `car=false`; a v3 reader skips it. The compiler
  (`scripts/citygen/roads.ts`) reads `bus`, `psv`, `taxi`, `goods`, `delivery`,
  `hgv`, `motorcycle`, `moped`, `bicycle` and `emergency` beside the old keys.
  The decoder rebuilds the full access with `roadAccessOf`.
- **Basemap fallback** (`cityLife/omtRoads.ts`): where no road archive covers
  the view, the basemap's `access` and `service` go through the same reader.

### What the simulation does with it

- Every lane has `users` (may pass) and `local` (may only arrive), as bitmasks
  over the simulated users (`sim/vehicleAccess.ts`: car, taxi, van, hgv, bus).
- A **recorded bus lane** — the same band the street renderer paints — is the
  buses' alone. The lane beside it is the kerb lane for everyone else, so cars
  still turn kerb-side from it and never from inside the bus lane.
- A car is never spawned on, and never routed onto, a lane its class may not
  drive; a destination-only street is entered at a fraction of the weight
  (`LOCAL_ENTRY_WEIGHT`) and never a through route.
- **Density follows the class**: a lane's spawn weight is `SPAWN_WEIGHT[class]`
  (primary 1, residential 0.25, service and living street 0.06), so the car
  target — lane-km × 22 — scales with the traffic a road class carries, not
  with its length. These are simulation parameters, not measured flows.

Tests: `sdk/test/roadAccess.test.ts`, `scripts/__tests__/cityRoads.test.ts`,
`components/map/__tests__/cityLifeSim.test.ts` ("who may drive where"),
`cityLifeWorldwide.test.ts`.

### Service roads through parks

`scripts/citygen/parkAreas.ts` finds the park-like areas of the extract —
`leisure=park|garden|nature_reserve|golf_course|common|dog_park`,
`landuse=cemetery|recreation_ground|village_green|forest`, closed ways and
multipolygon relations with their holes, by the building compiler's three
passes and the shared `rings.ts` — and the road compiler flags each
`highway=service` piece whose midpoint is inside one (`ROAD_PROPS.park`, tile
schema 4). Decided per piece, so a lane that leaves the park is not flagged
beyond it; only `service`, so a park polygon mapped over the street beside it
cannot quiet a real street; a relation with a member outside the extract is
left out rather than drawn half. The simulation gives such a lane a tenth of a
service road's weight (`PARK_LANE_FACTOR`). Monaco: 13 of its service pieces;
Andorra: 51 (the pass adds ~30 % to the road compile).

### Known limits

- `*:conditional` (time-windowed access) is not read yet; such a way takes its
  unconditional value. A conditional parser that counts what it cannot read is
  the next step, not a guess.
- Park roads are only the ones OSM draws inside a park-like area (below); a
  road that is private, delivery-only or time-restricted without saying so in
  its tags stays what the tags say.
- `hgv`, `bus` and `taxi` restrictions at the segment level are in the tiles
  but simulated vehicles are the five classes above.

## 2. Countries, zones and the API (built)

**Data** (migration `0022_goway_road_rules`, `src/db/schema/roadRules.ts`):

- `road_countries` — a border per country (Natural Earth 1:10m, public domain,
  simplified to ~110 m and rounded to ~1 m; territories carrying their
  sovereign's code join its polygons). `countryIndex.ts` holds them in process
  and puts a position in a country, or in none over open water.
- `road_rule_sets` — per country: `drivingSide` and the km/h an implicit
  `maxspeed=CC:urban|rural|trunk|motorway|living_street` means.
- `road_zones` — a low emission, congestion charge or restricted access zone:
  GeoJSON geometry (authoritative, as published), its stored bounding box (the
  SQL prefilter; the exact test is the contract's `geoGeometryContains`, the
  function the SDK uses), timezone, weekly schedule, effective dates and a
  policy of ordered rules over `(vehicle users, label scheme, labels) → allowed
  | fee | permit | denied` with an `otherwise` that may be `unknown`.
- `road_rule_events` — append-only: every created / updated / withdrawn /
  restored rule with the value it replaced. A sync that re-reads an unchanged
  source refreshes `source.retrievedAt` and records nothing.
- Every row carries `source` (`attribution`, `licence`, `retrievedAt`); no rule
  is served without its credit.

**Evaluation** is in the contract (`road-rules.ts`), shared by the server, the
SDK and the simulation:

- `environmentalLabelOf(scheme, vehicle)` derives Spain's DGT label, France's
  Crit'Air, Germany's Plakette and London's ULEZ standard from fuel and emission
  standard — or `undefined` when it cannot be told. Never `none` by default: an
  undescribed vehicle is not an unlabelled one.
- `evaluateZone` / `decideAccess` answer `allowed | fee | permit | denied`, or
  `unknown` when the vehicle is not described well enough for a rule — never a
  silent "allowed" — and say which scheme and label decided.
- `zoneInForce` honours the zone's schedule and effective dates in its own
  timezone.
- `parseMaxspeedKmh('ES:urban', ruleSets)` reads an implicit speed from the
  country's rule set.

**Public API** (signed out, `Cache-Control: public, max-age=300` except the
vehicle one): `GET /roads/rule-sets`, `GET /roads/rules?latitude&longitude[&country]`
(country, rule set and zones at a position), `GET /roads/zones` (box or
country, kind; paged), `POST /roads/access` (a position and a `VehicleProfile`;
`no-store`, never logged or stored). SDK: `goway.roads.{ruleSets,rules,zones,access}`
and the pure functions above, from `@goway.to/sdk`.

**Routing** (`POST /routes`, `drive` only): `vehicle`, `exclude`
(`toll|motorway|ferry`) and `departureAt`. A described vehicle drives as that
kind of vehicle (Valhalla `auto | taxi | bus | truck | motorcycle |
motor_scooter`) and the route goes around the zones in force that refuse it
(`denied`, or `permit`: a permit is not assumed), except a zone that holds the
origin, destination or a waypoint. Unknown rules are reported, never enforced.
Every route carries `zones`: the in-force zones it enters with the verdict for
the vehicle (`unknown` if none was described). An exclusion the costing cannot
honour is `validation_failed`, never ignored. The engine's
`service_limits.max_exclude_polygons_length` is raised to 2,000 km in
`packages/routing-engine/build-tiles.sh` (Valhalla's 10 km default is under one
city's zone); that takes a tile rebuild and an engine rollout to reach
production.

### Syncs (`bun run roadrules:sync -- --target-database=<name> [--only=<id>] [--dry-run]`)

An operator one-shot, like `import:osm`, meant to run weekly (rules change a few
times a year). Each source is a reader behind `RoadRuleSync`; `applySync` writes.
A zone is withdrawn only when a sync read its country **completely** and did not
list it — a failed or partial read withdraws nothing, and the command exits
non-zero if any unit failed, after running the rest.

| Sync | Source | Licence |
| --- | --- | --- |
| `natural-earth-countries` | Natural Earth 1:10m admin-0 | Public domain |
| `osm-country-rules` | `driving_side` on OSM country boundaries; implicit speeds from the OSM wiki "Default speed limits" via `westnordost/osm-legal-default-speeds` | ODbL 1.0; CC BY-SA 2.0 (speeds) — credited in `source` |
| `osm-low-emission-zones` | `boundary=low_emission_zone`, 27 countries | ODbL 1.0 |

Measured 2026-10-13: 238 borders, 114 rule sets (58 right, 56 left), and in
Spain 29 of 29 mapped zones drawn, 17 with a policy (Barcelona's metropolitan
ZBEs: `access:note=B,C,ECO,0` → the DGT labels admitted, everything else refused;
`opening_hours` → schedule). The other 12 — Madrid's among them, which tags no
hours — are shown with `otherwise: unknown`.

What OpenStreetMap does not carry is the regulation, so a policy is derived
only where the mapping states it in a form read without guessing (Spain's
`access:note`, together with hours this can parse) and is `unknown` everywhere
else. `PH off` clauses are ignored and so a zone is shown in force on holidays
(the cautious error for a driver). Country-specific readers are one table
(`POLICY_READERS`); adding Germany's Umweltzone or France's ZFE is a reader and a
test, and an official dataset (Málaga's CC BY 4.0 GeoJSON, Madrid's open data)
is a further sync with its own credit.

### Checking a deployment

`bun run check:road-rules` (`GOWAY_API_URL=…`) probes the live API signed out
and fails when the data is not there: a position not put in its country, the
wrong side of the road (Hong Kong left beside Shenzhen right), no Spanish
zones, no credit on a zone, an access decision that does not refuse a diesel
Euro 3 car in Barcelona's zone on a weekday, answers "allowed" to a vehicle too
little described, or a route that enters a zone that refuses its vehicle. Its
gate test (`scripts/test-check-road-rules.mjs`, in `test:gates`) shows it fails
an unsynced deployment. It is not wired into the deploy workflow, because a
deploy whose database has not yet been through `roadrules:sync` would fail it;
run it after the first sync.

### Not built yet

- The simulation does not avoid zones: simulated cars have no environmental
  label, and a fleet composition per country would be invented without data.
- `engine/roads/drivingSide.ts` and the paint-colour boxes in
  `cityStreets/lanes.ts` still decide the side in the client; they should read
  `goway.roads.rules(...)`. Held back because `lanes.ts` carries uncommitted
  work.
- `*:conditional`, park polygons, and a `check:routing` trip. (`check:road-rules`
  covers the zone avoidance, but cannot prove it on a trip that crosses no
  zone: it says so.)
