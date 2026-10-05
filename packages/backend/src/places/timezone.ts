/**
 * The IANA timezone at a position — the one place GoWay derives it.
 *
 * ## Derived, not written
 *
 * A place's opening hours are local wall-clock times, so "open now" needs the
 * zone the place's clock reads in. That zone is a function of WHERE the place
 * is, and every writer GoWay has already supplies the position: the importer
 * reads it off OpenStreetMap, which almost never tags a zone, and an API caller
 * sends a coordinate, not a zone. Asking each of them for the zone as well
 * would make it the one fact a writer could get wrong without anything
 * noticing — a café in Madrid evaluated in `Europe/London` is open an hour off
 * and still renders as a confident "Open". So every write that sets a position
 * sets `places.timezone` from it here, and no request can name one.
 *
 * ## Behind an interface, like every provider
 *
 * The lookup itself is `@photostructure/tz-lookup`: a compiled boundary table,
 * no I/O, CC0, a few tens of kilobytes, and well under a millisecond per call,
 * which is what an importer writing a country's worth of places needs. It is a
 * replaceable adapter like Photon or Valhalla: feature code calls
 * {@link timezoneAt} and never the library.
 *
 * Near a border the table is approximate by design (it trades exact polygons
 * for size); a place a few hundred metres from a zone boundary may be read in
 * its neighbour's zone, which matters only where neighbouring zones disagree on
 * the clock. Over open water it answers an `Etc/GMT±N` zone, which is a correct
 * answer for a ship and an honest one for a mis-placed point.
 */

import tzLookup from '@photostructure/tz-lookup';

/** Resolves the zone at a position, or `null` when it cannot. */
export interface TimezoneResolver {
  timezoneAt(latitude: number, longitude: number): string | null;
}

/** The shape `places_timezone_check` admits. */
const ZONE_NAME = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)*$/;

export const tzLookupResolver: TimezoneResolver = {
  timezoneAt(latitude, longitude) {
    try {
      const zone = tzLookup(latitude, longitude);
      return ZONE_NAME.test(zone) ? zone : null;
    } catch {
      // Out-of-range ordinates. The contract refuses them before here; a
      // `null` keeps a defect from becoming a failed write.
      return null;
    }
  },
};

/** The zone at a position, by the configured resolver. */
export function timezoneAt(latitude: number, longitude: number): string | null {
  return tzLookupResolver.timezoneAt(latitude, longitude);
}
