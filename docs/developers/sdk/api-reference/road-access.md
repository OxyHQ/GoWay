# @goway.to/sdk/road-access

Who may use a road: the reader of OpenStreetMap access tags, the closed sets behind it, the per-class defaults, and the compact form a vector tile carries. Pure functions with no transport, so a map worker can load it without the HTTP client.

Import from it like this: `import { accessLevel, resolveRoadAccess } from '@goway.to/sdk/road-access';`

A user no tag speaks for gets the class default, and a value that is not one of OSM's is treated as absent. For a walkthrough, see the [road access guide](../guides/road-access.md).

## Functions

| Function | Signature | Description |
| --- | --- | --- |
| `resolveRoadAccess` | `resolveRoadAccess(highway: string, tags: Readonly<Record<string, string>>): RoadAccess` | A way's access from its `highway` class and OSM tags: per user, the first readable value in its tag chain, else the class default. |
| `defaultRoadAccess` | `defaultRoadAccess(highway: string): RoadAccess` | A class's access with nothing tagged. An unknown class admits nobody. |
| `accessLevel` | `accessLevel(value: AccessValue): AccessLevel` | `through` may route over it, `local` may only start or end on it, `none` never. |
| `allowsMotorTraffic` | `allowsMotorTraffic(access: Partial<RoadAccess>): boolean` | Whether any engine-driven user may be on the road, even if cars may not. |
| `parseAccessValue` | `parseAccessValue(raw: string \| undefined): AccessValue \| undefined` | One OSM access value, or `undefined` when it is not one. |
| `accessOverrides` | `accessOverrides(highway: string, access: RoadAccess): Partial<RoadAccess>` | What differs from the class default: all a tile needs to carry. |
| `formatAccessOverrides` | `formatAccessOverrides(overrides: Partial<RoadAccess>): string \| undefined` | Overrides as one tile property, `bus=designated;car=no`, users in `ROAD_USERS` order. |
| `parseAccessOverrides` | `parseAccessOverrides(text: string \| undefined): Partial<RoadAccess>` | Reads a tile property back. Unknown users and values are dropped. |
| `roadAccessOf` | `roadAccessOf(highway: string, overrides?: Partial<RoadAccess>): RoadAccess` | The inverse of `accessOverrides`: a road's access from its class and what the tile carried. |

## Constants

| Name | Value | Description |
| --- | --- | --- |
| `ROAD_USERS` | `['car', 'taxi', 'bus', 'hgv', 'van', 'delivery', 'motorcycle', 'moped', 'bicycle', 'foot', 'emergency']` | The kinds of road user an access rule is stated for. |
| `MOTOR_ROAD_USERS` | `['car', 'taxi', 'bus', 'hgv', 'van', 'delivery', 'motorcycle', 'moped']` | The users that drive an engine. |
| `ACCESS_VALUES` | `['yes', 'designated', 'permissive', 'destination', 'delivery', 'customers', 'permit', 'private', 'no']` | What a road says to a user. `yes`, `designated`, `permissive` pass through; `destination`, `delivery`, `customers`, `permit` only reach somewhere on it; `no`, `private` may not. |

## Types

| Type | Description |
| --- | --- |
| `RoadAccess` | A road's `AccessValue` for every `RoadUser`. |
| `RoadUser` | One of `ROAD_USERS`. |
| `AccessValue` | One of `ACCESS_VALUES`. |
| `AccessLevel` | `'through' \| 'local' \| 'none'`. |
