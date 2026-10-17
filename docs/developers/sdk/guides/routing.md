# Routing

`client.routes.directions` asks GoWay's routing engine for a route between two or more points, by car, on foot or by bike. It returns the route line as GeoJSON, turn-by-turn maneuvers in the requested language, and the restricted traffic zones the route enters. Routing works signed out.

## Request a route

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'es' });

const response = await goway.routes.directions({
  origin: { coordinate: { latitude: 41.3874, longitude: 2.1686 } },
  destination: { coordinate: { latitude: 41.4036, longitude: 2.1744 }, name: 'Sagrada Família' },
  mode: 'walk',
});

const route = response.routes[0];
if (route) {
  console.log(`${Math.round(route.distanceMeters)} m, ${Math.round(route.durationSeconds / 60)} min`);
}
```

### Request fields (`RouteRequest`)

| Field | Type | Description |
| --- | --- | --- |
| `origin` | `RouteLocation` | Required. |
| `destination` | `RouteLocation` | Required. |
| `waypoints` | `RouteLocation[]` | Intermediate stops, in order. At most `MAX_WAYPOINTS` (8). |
| `mode` | `TravelMode` | Required. One of `TRAVEL_MODES`: `drive`, `walk`, `bike`. |
| `alternatives` | `boolean` | Ask for alternative routes where the engine supports them. |
| `locale` | `string` | BCP 47 tag for maneuver instructions. Defaults to the client's `locale`. |
| `vehicle` | `VehicleProfile` | `drive` only. The route avoids zones that refuse this vehicle and drives as that kind of vehicle. Used for this answer only. |
| `exclude` | `RouteExclude[]` | `drive` only. Any of `ROUTE_EXCLUDES`: `toll`, `motorway`, `ferry`. |
| `departureAt` | `string` | ISO 8601 instant, for zones that apply on a schedule. Default: now. |

A `RouteLocation` carries a `coordinate`, a GoWay `placeId`, or both, plus an optional `name` to echo back. When both are given the place wins: GoWay knows which point of a place is reachable. An unknown `placeId` is a `GoWayNotFoundError`, even with a coordinate.

A `mode` outside `TRAVEL_MODES` is refused with `GoWayValidationError` before sending.

## Read the response

`RouteResponse.routes` is ordered best first and may be empty. Each `Route` has:

- `mode`, `distanceMeters`, `durationSeconds`;
- `geometry`: a `GeoJsonLineString` in GeoJSON's `[longitude, latitude]` order. Convert a position with `toGeoCoordinate` when you need `{ latitude, longitude }`;
- `legs`: one per pair of consecutive stops, each with `maneuvers`. A `RouteManeuver` has `type` (one of `MANEUVER_TYPES`, or a newer string), `instruction` (rendered text in the requested locale), `streetName`, `distanceMeters`, `durationSeconds`, `coordinate` and `geometryIndex` (where it starts in `geometry.coordinates`);
- `zones`: the restricted zones in force that the route enters, each a `RoadZoneVerdict` with what it says to your vehicle (`unknown` when no vehicle was described).

```ts
for (const leg of route.legs) {
  for (const step of leg.maneuvers) {
    console.log(step.instruction, step.streetName ?? '', `${Math.round(step.distanceMeters)} m`);
  }
}
```

## "No route" is a normal answer

Two points separated by water have no driving route. GoWay says so in one of two ways, and you should handle both as "no route found", not as a failure:

```ts
import { GoWayNoRouteError, GoWayUnsupportedModeError } from '@goway.to/sdk';

try {
  const { routes } = await goway.routes.directions(request);
  if (routes.length === 0) showMessage('No route found');
  else draw(routes[0]);
} catch (error) {
  if (error instanceof GoWayNoRouteError) showMessage('No route found');
  else if (error instanceof GoWayUnsupportedModeError) showMessage('This travel mode is not available here');
  else throw error;
}
```

Neither is retryable. `GoWayUnsupportedModeError` is a statement about coverage: offer another mode.

## Drive with a vehicle profile

```ts
const response = await goway.routes.directions({
  origin: { coordinate: { latitude: 40.4168, longitude: -3.7038 } },
  destination: { coordinate: { latitude: 40.4531, longitude: -3.6883 } },
  mode: 'drive',
  vehicle: { user: 'car', fuel: 'diesel', standard: 'euro_4' },
  exclude: ['toll'],
});

for (const zone of response.routes[0]?.zones ?? []) {
  console.log(zone.name, zone.decision);
}
```

See [Road rules](./roads.md) for the vehicle profile and zone decisions.

## Draw the route

The route line is GeoJSON, so a map draws it directly. With `@goway.to/maps`:

```tsx
import type { Route } from '@goway.to/sdk';
import { GeoJSONSource, Layer } from '@goway.to/maps';

export function RouteLine({ route }: { route: Route }) {
  return (
    <GeoJSONSource id="route" data={{ type: 'Feature', geometry: route.geometry, properties: {} }}>
      <Layer id="route-line" type="line" paint={{ 'line-width': 5, 'line-color': '#1a73e8' }} layout={{ 'line-cap': 'round' }} />
    </GeoJSONSource>
  );
}
```

The full program, including framing the camera on the route, is the [route-and-draw example](../examples/route-and-draw.md).

## See also

- [Road rules](./roads.md)
- [Errors](./errors.md)
- [API reference: `client.routes`](../api-reference/index.md#clientroutes-gowayroutesapi)
