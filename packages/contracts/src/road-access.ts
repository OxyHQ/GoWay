/**
 * Who may use a road — the ONE definition of road access.
 *
 * The city-tile compiler reads OSM access tags through `resolveRoadAccess`,
 * the tile carries only what differs from the class default
 * (`accessOverrides`), and the simulation, the street renderer and the public
 * API read it back through `roadAccessOf`. Nothing else maps `access=*`,
 * `motor_vehicle=*` or `bus=*` to a yes or a no: a second reader is how a car
 * ends up in a bus lane.
 *
 * Recorded, never invented: a user with no tag anywhere in its chain gets the
 * class default, and an unreadable value counts as absent.
 */

import { z } from 'zod';

/** The kinds of road user an access rule is stated for. Closed. */
export const ROAD_USERS = [
  'car',
  'taxi',
  'bus',
  'hgv',
  'van',
  'delivery',
  'motorcycle',
  'moped',
  'bicycle',
  'foot',
  'emergency',
] as const;
export type RoadUser = (typeof ROAD_USERS)[number];
export const roadUserSchema = z.enum(ROAD_USERS);

/**
 * What a road says to a user.
 *
 * - `yes`, `designated`, `permissive` — may pass through.
 * - `destination`, `delivery`, `customers`, `permit` — may enter only to reach
 *   somewhere on it (or with a permit); never a through route.
 * - `no`, `private` — may not.
 */
export const ACCESS_VALUES = [
  'yes',
  'designated',
  'permissive',
  'destination',
  'delivery',
  'customers',
  'permit',
  'private',
  'no',
] as const;
export type AccessValue = (typeof ACCESS_VALUES)[number];
export const accessValueSchema = z.enum(ACCESS_VALUES);

export const roadAccessSchema = z.record(roadUserSchema, accessValueSchema);
/** A road's access for every user. */
export type RoadAccess = Record<RoadUser, AccessValue>;

/** How far a user may go on a road. */
export type AccessLevel = 'through' | 'local' | 'none';

const LEVEL: Record<AccessValue, AccessLevel> = {
  yes: 'through',
  designated: 'through',
  permissive: 'through',
  destination: 'local',
  delivery: 'local',
  customers: 'local',
  permit: 'local',
  private: 'none',
  no: 'none',
};

/** `through` may route over it, `local` only start or end on it, `none` never. */
export function accessLevel(value: AccessValue): AccessLevel {
  return LEVEL[value];
}

/** OSM spellings → the closed set. Anything else is unreadable (`undefined`). */
const OSM_VALUES: Readonly<Record<string, AccessValue>> = {
  yes: 'yes',
  true: 'yes',
  '1': 'yes',
  designated: 'designated',
  official: 'designated',
  permissive: 'permissive',
  destination: 'destination',
  delivery: 'delivery',
  customers: 'customers',
  permit: 'permit',
  private: 'private',
  agricultural: 'private',
  forestry: 'private',
  military: 'private',
  no: 'no',
  false: 'no',
  '0': 'no',
};

export function parseAccessValue(raw: string | undefined): AccessValue | undefined {
  if (raw === undefined) return undefined;
  return OSM_VALUES[raw.trim().toLowerCase()];
}

/**
 * OSM's access hierarchy: for each user, the keys that speak for it, most
 * specific first (`motorcar` before `motor_vehicle` before `vehicle` before
 * `access`). The first key holding a readable value wins.
 */
const CHAINS: Readonly<Record<RoadUser, readonly string[]>> = {
  car: ['motorcar', 'motor_vehicle', 'vehicle', 'access'],
  taxi: ['taxi', 'psv', 'motor_vehicle', 'vehicle', 'access'],
  bus: ['bus', 'psv', 'motor_vehicle', 'vehicle', 'access'],
  hgv: ['hgv', 'motor_vehicle', 'vehicle', 'access'],
  van: ['goods', 'motorcar', 'motor_vehicle', 'vehicle', 'access'],
  delivery: ['delivery', 'motor_vehicle', 'vehicle', 'access'],
  motorcycle: ['motorcycle', 'motor_vehicle', 'vehicle', 'access'],
  moped: ['moped', 'motor_vehicle', 'vehicle', 'access'],
  bicycle: ['bicycle', 'vehicle', 'access'],
  foot: ['foot', 'access'],
  // Emergency vehicles ignore a general ban: only their own key speaks.
  emergency: ['emergency'],
};

/** The users that drive an engine: what "a road for vehicles" means. */
export const MOTOR_ROAD_USERS: readonly RoadUser[] = [
  'car',
  'taxi',
  'bus',
  'hgv',
  'van',
  'delivery',
  'motorcycle',
  'moped',
];

/** `service=*` values that are never a road to drive through, whatever else is tagged. */
const PRIVATE_SERVICE: ReadonlySet<string> = new Set([
  'parking_aisle',
  'driveway',
  'drive-through',
  'emergency_access',
]);

const NOBODY: RoadAccess = {
  car: 'no',
  taxi: 'no',
  bus: 'no',
  hgv: 'no',
  van: 'no',
  delivery: 'no',
  motorcycle: 'no',
  moped: 'no',
  bicycle: 'no',
  foot: 'no',
  emergency: 'yes',
};

function accessFor(users: readonly RoadUser[], value: AccessValue): Partial<RoadAccess> {
  return Object.fromEntries(users.map((user) => [user, value]));
}

const MOTOR_ROAD: Partial<RoadAccess> = accessFor(MOTOR_ROAD_USERS, 'yes');
const MOTORWAY: Partial<RoadAccess> = { ...MOTOR_ROAD, moped: 'no' };

/**
 * What a `highway` class allows when nothing is tagged. Only the plain
 * defaults every country shares; where it varies (cycling on a trunk road) the
 * class says nothing and the tags decide.
 */
const CLASS_DEFAULTS: Readonly<Record<string, Partial<RoadAccess>>> = {
  motorway: MOTORWAY,
  motorway_link: MOTORWAY,
  trunk: MOTORWAY,
  trunk_link: MOTORWAY,
  primary: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  primary_link: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  secondary: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  secondary_link: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  tertiary: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  tertiary_link: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  unclassified: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  residential: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  road: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  service: { ...MOTOR_ROAD, foot: 'yes', bicycle: 'yes' },
  // Motor traffic is a guest here, at walking pace: through only by courtesy.
  living_street: { ...accessFor(MOTOR_ROAD_USERS, 'destination'), foot: 'yes', bicycle: 'yes' },
  pedestrian: { foot: 'yes' },
  footway: { foot: 'yes' },
  steps: { foot: 'yes' },
  path: { foot: 'yes', bicycle: 'yes' },
  track: { foot: 'yes', bicycle: 'yes' },
  cycleway: { bicycle: 'designated' },
};

/** A class's access with nothing tagged. An unknown class admits nobody. */
export function defaultRoadAccess(highway: string): RoadAccess {
  return { ...NOBODY, ...CLASS_DEFAULTS[highway] };
}

/**
 * A way's access from its OSM tags: per user the first readable value in its
 * chain, else the class default. A `bus=designated` lane inside a road
 * therefore opens it to buses and leaves cars where `motor_vehicle` or
 * `access` puts them. A parking aisle, driveway, drive-through or emergency
 * access is closed to every motor user, whatever else is tagged.
 */
export function resolveRoadAccess(
  highway: string,
  tags: Readonly<Record<string, string>>,
): RoadAccess {
  const access = defaultRoadAccess(highway);
  for (const user of ROAD_USERS) {
    for (const key of CHAINS[user]) {
      const value = parseAccessValue(tags[key]);
      if (value !== undefined) {
        access[user] = value;
        break;
      }
    }
  }
  if (highway === 'service' && PRIVATE_SERVICE.has(tags.service ?? '')) {
    for (const user of MOTOR_ROAD_USERS)
      if (accessLevel(access[user]) !== 'none') access[user] = 'private';
  }
  return access;
}

/**
 * What differs from the class default: all a tile needs to carry, since the
 * reader knows the class. Empty for the overwhelming majority of ways.
 */
export function accessOverrides(highway: string, access: RoadAccess): Partial<RoadAccess> {
  const base = defaultRoadAccess(highway);
  const out: Partial<RoadAccess> = {};
  for (const user of ROAD_USERS) if (access[user] !== base[user]) out[user] = access[user];
  return out;
}

/** The inverse of `accessOverrides`: a road's access from its class and what the tile carried. */
export function roadAccessOf(highway: string, overrides?: Partial<RoadAccess>): RoadAccess {
  return { ...defaultRoadAccess(highway), ...overrides };
}

const OVERRIDE_PAIR = /^([a-z]+)=([a-z]+)$/;

/** Overrides as one tile property: `bus=designated;car=no`, users in `ROAD_USERS` order. */
export function formatAccessOverrides(overrides: Partial<RoadAccess>): string | undefined {
  const pairs = ROAD_USERS.flatMap((user) => {
    const value = overrides[user];
    return value === undefined ? [] : [`${user}=${value}`];
  });
  return pairs.length > 0 ? pairs.join(';') : undefined;
}

/** Reads a tile property back; an unknown user or value is dropped, never guessed. */
export function parseAccessOverrides(text: string | undefined): Partial<RoadAccess> {
  const out: Partial<RoadAccess> = {};
  if (!text) return out;
  for (const pair of text.split(';')) {
    const match = OVERRIDE_PAIR.exec(pair);
    const user = roadUserSchema.safeParse(match?.[1]);
    const value = accessValueSchema.safeParse(match?.[2]);
    if (user.success && value.success) out[user.data] = value.data;
  }
  return out;
}

/** Whether any engine-driven user may be on this road, even if cars may not. */
export function allowsMotorTraffic(access: Partial<RoadAccess>): boolean {
  return MOTOR_ROAD_USERS.some((user) => {
    const value = access[user];
    return value !== undefined && accessLevel(value) !== 'none';
  });
}
