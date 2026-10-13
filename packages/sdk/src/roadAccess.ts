/**
 * `@goway.to/sdk/road-access` — who may use a road.
 *
 * The one reader of OSM access tags and the closed sets behind it: which kinds
 * of road user there are, what a road can say to each, the class defaults, and
 * the compact form a city tile carries. Pure functions, no transport and no
 * schemas beyond the value sets, so a map worker loads it without the HTTP
 * client.
 *
 *     import { accessLevel, resolveRoadAccess } from '@goway.to/sdk/road-access';
 *
 *     const access = resolveRoadAccess('residential', { access: 'no', bus: 'designated' });
 *     accessLevel(access.bus); // 'through'
 *     accessLevel(access.car); // 'none'
 *
 * Recorded, never invented: a user nothing speaks for gets the class default,
 * and a value that is not one of OSM's is treated as absent.
 */

export {
  ACCESS_VALUES,
  MOTOR_ROAD_USERS,
  ROAD_USERS,
  accessLevel,
  allowsMotorTraffic,
  accessOverrides,
  defaultRoadAccess,
  formatAccessOverrides,
  parseAccessOverrides,
  parseAccessValue,
  resolveRoadAccess,
  roadAccessOf,
} from './contract';
export type { AccessLevel, AccessValue, RoadAccess, RoadUser } from './contract';
