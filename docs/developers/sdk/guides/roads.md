# Road rules

`client.roads` answers what differs on the road from one country or city to the next: which side people drive on, what an implicit speed limit such as `ES:urban` means, and which low emission, congestion charge and restricted access zones apply. It can also decide whether a described vehicle may enter a position at a given time. Everything here is public and needs no account; the vehicle you describe is used for the one answer and not stored.

For who may use an individual road according to its OpenStreetMap tags, see [Road access](./road-access.md).

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient();
```

## The rules at a position

```ts
const rules = await goway.roads.rules({ latitude: 40.4168, longitude: -3.7038 });

console.log(rules.countryCode);             // 'ES', or null over open water
console.log(rules.ruleSet?.drivingSide);    // 'right'
console.log(rules.ruleSet?.speedLimitsKmh); // { urban, rural, trunk, motorway, living_street } where known
for (const zone of rules.zones) console.log(zone.kind, zone.name);
```

- Pass `country` (ISO 3166-1 alpha-2) when you already know it, for example from a reverse geocode's `context.countryCode`.
- `ruleSet` is `null` where GoWay holds none. Every rule set and zone carries a `source` with attribution, licence and retrieval date.

`roads.ruleSets()` lists every country's rule set, paged (`limit` up to `MAX_ROAD_LIST_LIMIT`).

## Zones in an area

```ts
const zones = await goway.roads.zones({
  west: -3.75,
  south: 40.38,
  east: -3.65,
  north: 40.47,
  kind: 'low_emission',
});
```

Name a box (all four edges) or a `country`; one of them is required. `kind` is one of `ROAD_ZONE_KINDS`. Each `RoadZone` has a `geometry` (Polygon or MultiPolygon), a `boundingBox`, its `timezone`, a `policy`, an optional `schedule`, `effectiveFrom`/`effectiveUntil` and `rulesUrl`. Label a kind with `ROAD_ZONE_KIND_LABELS[kind]` and `localizedLabel`.

## May this vehicle enter?

```ts
const answer = await goway.roads.access({
  latitude: 40.4168,
  longitude: -3.7038,
  vehicle: { user: 'car', fuel: 'diesel', standard: 'euro_4' },
});

switch (answer.decision) {
  case 'allowed': break;
  case 'fee': case 'permit': case 'denied':
    for (const verdict of answer.verdicts) console.log(verdict.name, verdict.decision);
    break;
  case 'unknown':
    askForMoreVehicleDetails();
    break;
}
```

- `decision` is the strictest of the zones' decisions (`denied` over `permit` over `fee` over `allowed`), or `unknown` when the vehicle was not described well enough for a zone's rules. `unknown` is never a silent "allowed".
- `allowed` with no `verdicts` means no zone GoWay holds covers the position, not that none exists.
- `vehicle` defaults to `{ user: 'car' }`. A `VehicleProfile` can carry `user` (`VEHICLE_USERS`), `fuel` (`VEHICLE_FUELS`), `standard` (`EMISSION_STANDARDS`), `electricRangeKm`, and `labels` you already know per scheme (`ENVIRONMENTAL_LABEL_SCHEMES`).
- `at` is an ISO 8601 instant for scheduled zones; default now.

## Decide offline

The server's evaluation is exported, so a client holding zones (from `roads.zones` or `roads.rules`) can answer without a request:

```ts
import { decideAccess, environmentalLabelOf, zoneInForce } from '@goway.to/sdk';

const vehicle = { user: 'car' as const, fuel: 'petrol' as const, standard: 'euro_6' as const };
const decision = decideAccess(zones.items, { latitude: 40.4168, longitude: -3.7038 }, vehicle, new Date());

environmentalLabelOf('es_dgt', vehicle); // the vehicle's DGT label, or undefined when it cannot be told
zoneInForce(zones.items[0]!, new Date());  // true, false, or undefined when the schedule cannot be evaluated
```

`evaluateZone(zone, vehicle, at)` gives one zone's verdict and `strictestDecision(decisions)` combines several. `parseMaxspeedKmh('ES:urban', lookup)` reads an OSM `maxspeed` value into km/h, using a rule-set lookup for implicit values.

## Routing with a vehicle

`client.routes.directions` accepts the same `VehicleProfile` (for `mode: 'drive'`), avoids zones that refuse the vehicle, and reports the zones the route enters. See [Routing](./routing.md).

## See also

- [Road access](./road-access.md)
- [API reference: `client.roads`](../api-reference/index.md#clientroads-gowayroadsapi)
