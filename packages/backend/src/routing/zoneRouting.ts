/**
 * What restricted zones do to a drive: which to route around, and which a
 * finished route enters.
 *
 * Pure functions over the contract's zones and its `evaluateZone`, so the
 * answer to "may this vehicle go through there" is the one the access endpoint
 * and the SDK give — a route cannot avoid a zone the API says is open, or enter
 * one it says is closed.
 *
 * ## Avoid what refuses the vehicle, except what you must enter
 *
 * A zone is routed around when it is in force at departure and says `denied` or
 * `permit` to the vehicle (a permit is not assumed). Not when it says `unknown`
 * — a rule GoWay cannot read for this vehicle is reported, not enforced — and
 * not when the origin, destination or a waypoint lies inside it: nothing can
 * reach a place without entering the zone around it, and an exclusion there
 * would turn a normal trip into "no route".
 */

import {
  evaluateZone,
  geoGeometryContains,
  type GeoBoundingBox,
  type GeoCoordinate,
  type Route,
  type RoadZone,
  type RoadZoneVerdict,
  type VehicleProfile,
} from '@goway/contracts';

type Area = Extract<RoadZone['geometry'], { type: 'Polygon' | 'MultiPolygon' }>;

/** How far beyond the stops' box zones are loaded, degrees (~55 km): a detour to dodge a zone stays inside. */
export const ZONE_SEARCH_MARGIN_DEGREES = 0.5;

/** The box zones must be loaded for: around every stop. */
export function zoneSearchBox(points: readonly GeoCoordinate[]): GeoBoundingBox {
  const lons = points.map((p) => p.longitude);
  const lats = points.map((p) => p.latitude);
  const m = ZONE_SEARCH_MARGIN_DEGREES;
  return {
    west: Math.max(-180, Math.min(...lons) - m),
    east: Math.min(180, Math.max(...lons) + m),
    south: Math.max(-90, Math.min(...lats) - m),
    north: Math.min(90, Math.max(...lats) + m),
  };
}

export function areasToAvoid(
  zones: readonly RoadZone[],
  vehicle: VehicleProfile,
  at: Date,
  stops: readonly GeoCoordinate[],
): Area[] {
  return zones.flatMap((zone) => {
    const verdict = evaluateZone(zone, vehicle, at);
    if (!verdict.inForce || (verdict.decision !== 'denied' && verdict.decision !== 'permit'))
      return [];
    if (stops.some((stop) => geoGeometryContains(zone.geometry, stop))) return [];
    return [zone.geometry];
  });
}

/**
 * The in-force zones a route's line enters, each with its verdict for the
 * vehicle. A zone is entered if any vertex of the line is inside it; the line's
 * vertices are the engine's own shape points, dense enough on roads that a
 * zone is not stepped over.
 */
export function zonesEntered(
  zones: readonly RoadZone[],
  route: Pick<Route, 'geometry'>,
  vehicle: VehicleProfile,
  at: Date,
): RoadZoneVerdict[] {
  const verdicts: RoadZoneVerdict[] = [];
  for (const zone of zones) {
    const { west, south, east, north } = zone.boundingBox;
    const entered = route.geometry.coordinates.some(([longitude, latitude]) => {
      if (longitude < west || longitude > east || latitude < south || latitude > north)
        return false;
      return geoGeometryContains(zone.geometry, { longitude, latitude });
    });
    if (!entered) continue;
    const verdict = evaluateZone(zone, vehicle, at);
    if (verdict.inForce || verdict.decision === 'unknown') verdicts.push(verdict);
  }
  return verdicts;
}
