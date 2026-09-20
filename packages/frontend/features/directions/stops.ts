/**
 * A stop on a planned route, and how one becomes a `RouteLocation`.
 *
 * The whole file exists for one rule, which is easy to state and easy to lose
 * the first time somebody needs a coordinate for a marker:
 *
 * > **A stop that is a GoWay place travels as its `placeId`, never as its
 * > coordinate.**
 *
 * `RouteLocation.placeId` is in the contract precisely so the BACKEND resolves
 * the routable point. A place's `location` is a label anchor — often a building
 * centroid, sometimes the middle of a park — and routing to it means routing to
 * whatever edge the engine snaps that centroid onto, which is regularly the
 * wrong side of a block, a service road, or a footpath through a car park.
 * Which entrance a router should aim at is GoWay's knowledge, not this screen's.
 *
 * So a stop keeps its coordinate for the things the SCREEN needs it for — a
 * pin, framing the camera, "is this origin far enough from the destination to
 * be worth offering" — and {@link toRouteLocation} drops it whenever there is a
 * place ID to send instead.
 */
import { placeDisplayName } from '@goway.to/sdk';
import type { GeoCoordinate, Place, PlaceId, RouteLocation, SearchResult } from '@goway.to/sdk';

import { isValidCoordinate } from '@/lib/map/geo';

/**
 * Where a stop came from, which is the only thing that licenses the sentence
 * "from your location".
 *
 * `device` is a real fix the user asked for. Nothing else is, and nothing else
 * may be described as one — see the note on the map fallback in `useDirections`.
 */
export type StopSource =
  /** The device's own position, from a permission the user granted just now. */
  | 'device'
  /** A GoWay place. Travels as a place ID. */
  | 'place'
  /** A geocoder candidate — a street, a locality. A name and a point. */
  | 'result'
  /** A point on the map: tapped, or the explicitly-offered map centre. */
  | 'map';

export interface DirectionsStop {
  /**
   * Identity for list keys and for patching a label in asynchronously.
   *
   * Not the place ID: two slots may legitimately hold the same place (a round
   * trip back to where you started), and React would then render one of them.
   */
  id: string;
  source: StopSource;
  /** What the field shows, and what the request echoes back as `name`. */
  label: string;
  /** For pins, framing and distance tests. NOT what is sent for a place. */
  coordinate: GeoCoordinate;
  /** Set only for a GoWay place; when set, this is what travels. */
  placeId?: PlaceId;
}

let sequence = 0;

/** A fresh stop id. Monotonic, so a re-picked slot is never confused with the old one. */
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/**
 * A stop is only ever built around a coordinate that can actually be drawn.
 *
 * Every constructor below answers `null` rather than producing a stop whose
 * coordinate is not a point on the earth, and the caller leaves the slot as it
 * was. The reason is mechanical: a stop becomes a `MapMarker`, and a marker
 * with a `NaN` coordinate does not render badly — it makes MapLibre THROW
 * (`Invalid LngLat object: (NaN, NaN)`) out of the effect that positions it,
 * which reaches the screen's error boundary and replaces the whole app with
 * "Something went wrong". `components/map/` drops such a marker as a backstop;
 * this is the layer that stops one existing.
 *
 * The bound is `isValidCoordinate` — a REAL point, longitude within ±180 —
 * rather than the looser "the engine will accept it" rule, because a stop also
 * travels to the routing contract, which requires the same range.
 */
export function stopFromPlace(place: Place): DirectionsStop | null {
  if (!isValidCoordinate(place.location)) return null;
  return {
    id: nextId('place'),
    source: 'place',
    label: placeDisplayName(place),
    coordinate: place.location,
    placeId: place.id,
  };
}

/**
 * A search result.
 *
 * A result that reconciled to a GoWay place IS a place — the search response
 * carries the whole record — so it becomes a place stop and gets the place-ID
 * treatment. A geocoder-only candidate has no place ID, and honestly is the
 * point it is.
 */
export function stopFromResult(result: SearchResult): DirectionsStop | null {
  if (result.place) return stopFromPlace(result.place);
  if (!isValidCoordinate(result.coordinate)) return null;
  return {
    id: nextId('result'),
    source: 'result',
    label: result.displayName,
    coordinate: result.coordinate,
  };
}

/** The device's own fix. The only stop that may be called "your location". */
export function stopFromDevice(coordinate: GeoCoordinate): DirectionsStop | null {
  if (!isValidCoordinate(coordinate)) return null;
  return { id: nextId('device'), source: 'device', label: 'Your location', coordinate };
}

/** A point on the map. `label` is provisional until a reverse geocode lands. */
export function stopFromPoint(
  coordinate: GeoCoordinate,
  label = 'Point on the map',
): DirectionsStop | null {
  if (!isValidCoordinate(coordinate)) return null;
  return { id: nextId('point'), source: 'map', label, coordinate };
}

/**
 * The stop as the routing contract wants it.
 *
 * The coordinate is deliberately ABSENT when there is a place ID: sending both
 * invites a backend to prefer the coordinate, which is the behaviour the place
 * ID exists to avoid, and makes the request ambiguous for no gain.
 */
export function toRouteLocation(stop: DirectionsStop): RouteLocation {
  if (stop.placeId) return { placeId: stop.placeId, name: stop.label };
  return { coordinate: stop.coordinate, name: stop.label };
}

/** `true` when two slots are asking for the same physical point. */
export function isSameStop(a: DirectionsStop | null, b: DirectionsStop | null): boolean {
  if (!a || !b) return false;
  if (a.placeId && b.placeId) return a.placeId === b.placeId;
  if (a.placeId || b.placeId) return false;
  return (
    Math.abs(a.coordinate.latitude - b.coordinate.latitude) < 1e-7 &&
    Math.abs(a.coordinate.longitude - b.coordinate.longitude) < 1e-7
  );
}

/**
 * The letter or number a slot is drawn with.
 *
 * A (origin) and B (destination) are the two ends whatever the itinerary looks
 * like; intermediate stops are numbered in the order they are visited, because
 * "C, D, E" stops being readable at about the point it starts mattering.
 */
export function slotLabel(index: number, total: number): string {
  if (index === 0) return 'A';
  if (index === total - 1) return 'B';
  return String(index);
}

/** The words a screen reader should hear for a slot. */
export function slotName(index: number, total: number): string {
  if (index === 0) return 'Starting point';
  if (index === total - 1) return 'Destination';
  return `Stop ${index}`;
}
