/**
 * Which roads each simulated vehicle may drive, as bitmasks over the road
 * users the simulation fields. The rules themselves are the road-access
 * contract's (`@goway.to/sdk/road-access`, the ONE reader of OSM access tags);
 * this only maps a vehicle model to its user and packs the answer so a lane
 * can be tested in one AND.
 */
import { accessLevel, type RoadAccess, type RoadUser } from '@goway.to/sdk/road-access';

import type { CarModel } from './fleet';

/** The road users the simulation fields, in bit order. */
export const SIM_ROAD_USERS = [
  'car',
  'taxi',
  'van',
  'hgv',
  'bus',
] as const satisfies readonly RoadUser[];

/** The road user each vehicle model is. */
export const ROAD_USER_OF_MODEL: Record<CarModel, (typeof SIM_ROAD_USERS)[number]> = {
  hatchback: 'car',
  sedan: 'car',
  suv: 'car',
  taxi: 'taxi',
  van: 'van',
  truck: 'hgv',
  bus: 'bus',
};

const BIT = Object.fromEntries(SIM_ROAD_USERS.map((user, i) => [user, 1 << i])) as Record<
  (typeof SIM_ROAD_USERS)[number],
  number
>;

/** Every simulated user. */
export const ALL_USERS = (1 << SIM_ROAD_USERS.length) - 1;

/** The mask bit of a vehicle model. */
export function modelBit(model: CarModel): number {
  return BIT[ROAD_USER_OF_MODEL[model]];
}

/** The ordinary traffic a lane is "general" for: where it is shut to these, it is a restricted lane. */
export const GENERAL_USERS = BIT.car;

/** The users a lane marked for buses admits: buses alone. */
export const BUS_LANE_USERS = BIT.bus;

/** `through`: may route over it. `local`: may enter only to reach somewhere on it. */
export interface UserMasks {
  through: number;
  local: number;
}

export function userMasks(access: RoadAccess): UserMasks {
  let through = 0;
  let local = 0;
  for (const user of SIM_ROAD_USERS) {
    const level = accessLevel(access[user]);
    if (level === 'through') through |= BIT[user];
    else if (level === 'local') local |= BIT[user];
  }
  return { through, local };
}
