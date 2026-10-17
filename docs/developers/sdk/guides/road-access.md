# Road access

The `@goway.to/sdk/road-access` entry point answers "who may use this road?" from OpenStreetMap tags. It reads a way's `highway` class and its access tags (`access`, `motor_vehicle`, `bus`, and so on) into one `RoadAccess` value per road user, and converts that to and from the compact form a vector tile carries. It is pure and has no transport, so it runs in a map worker or a renderer without the HTTP client.

For zone rules (low emission zones, congestion charges) and "may this vehicle enter here", see [Road rules](./roads.md) instead.

```ts
import { accessLevel, resolveRoadAccess } from '@goway.to/sdk/road-access';

const access = resolveRoadAccess('residential', { access: 'no', bus: 'designated' });
accessLevel(access.bus); // 'through'
accessLevel(access.car); // 'none'
```

## Road users and values

`ROAD_USERS` is the closed set of users a rule is stated for: `car`, `taxi`, `bus`, `hgv`, `van`, `delivery`, `motorcycle`, `moped`, `bicycle`, `foot`, `emergency`. `MOTOR_ROAD_USERS` is the engine-driven subset.

A `RoadAccess` maps every user to one of `ACCESS_VALUES`, and `accessLevel` reduces a value to what a router or a renderer needs:

| `AccessValue` | `AccessLevel` | Meaning |
| --- | --- | --- |
| `yes`, `designated`, `permissive` | `through` | May route over it. |
| `destination`, `delivery`, `customers`, `permit` | `local` | May only start or end a trip on it. |
| `no`, `private` | `none` | May not use it. |

## Resolving tags

`resolveRoadAccess(highway, tags)` reads, for each user, the first readable value along OSM's hierarchy for that user (for a car: `motorcar`, then `motor_vehicle`, then `vehicle`, then `access`), and falls back to the class default. So a `bus=designated` lane opens a road to buses and leaves cars where `motor_vehicle` or `access` puts them.

- A value that is not one of OSM's (`parseAccessValue` returns `undefined`) is treated as absent.
- `emergency` only reads its own key: a general ban does not close a road to emergency vehicles.
- A `service` road tagged `service=parking_aisle`, `driveway`, `drive-through` or `emergency_access` is closed to every motor user (`private`), whatever else is tagged.

`defaultRoadAccess(highway)` is a class's access with nothing tagged. An unknown class admits nobody except emergency vehicles. `allowsMotorTraffic(access)` tells you whether any engine-driven user may be on the road.

## The tile form

Most ways match their class default, so a tile only needs to carry the differences:

```ts
import {
  accessOverrides,
  formatAccessOverrides,
  parseAccessOverrides,
  resolveRoadAccess,
  roadAccessOf,
} from '@goway.to/sdk/road-access';

// Writing a tile
const access = resolveRoadAccess('residential', { motor_vehicle: 'no', bus: 'designated' });
const property = formatAccessOverrides(accessOverrides('residential', access));
// 'car=no;taxi=no;bus=designated;hgv=no;van=no;delivery=no;motorcycle=no;moped=no'
// (users in ROAD_USERS order), or undefined when nothing differs

// Reading it back in a renderer
const restored = roadAccessOf('residential', parseAccessOverrides(property));
```

`parseAccessOverrides` drops an unknown user or value rather than guessing.

## See also

- [Road rules](./roads.md)
- [API reference: `@goway.to/sdk/road-access`](../api-reference/road-access.md)
