/**
 * The directions planner: point A, point B, and whatever the user puts between
 * them.
 *
 * ## Why a MODE and not a button
 *
 * The previous shape was one `Directions` button on a place card: origin = your
 * device, destination = whatever is selected, nothing else expressible. That
 * answers exactly one question. A planner is a different object — an ORDERED
 * ITINERARY the user edits — and every feature the user asked for (swap, a
 * different starting point, a stop on the way) is an edit to that itinerary
 * rather than another button beside the first one.
 *
 * So the state here is a single array of slots. Slot 0 is the origin, the last
 * slot is the destination, everything between is a `waypoint` in the contract's
 * sense. Swap is `reverse()`. Adding a stop is a splice. Reordering is a swap
 * of two entries. There is no separate `from`/`to`/`via` bookkeeping to keep in
 * agreement with itself.
 *
 * ## Rules this file is the enforcement point for
 *
 *  - **A GoWay place travels as its place ID.** See `stops.ts`; the request is
 *    built with `toRouteLocation`, which is the only thing that knows how.
 *  - **The map centre is never silently substituted for the user.** A slot the
 *    user did not deliberately set is EMPTY. `setStopFromMapCentre` exists, it is
 *    offered beside a location failure, and what it produces is labelled as a
 *    point on the map everywhere it is shown — it is never called `device`.
 *  - **Location is contextual.** Nothing here calls `locate()` on mount;
 *    entering the planner from a place is a user action that asks once, and
 *    leaving the planner forgets the fix.
 *  - **A route is a request, not a record.** Nothing is written anywhere, and
 *    the query is cached for zero milliseconds beyond its observers, so a
 *    device coordinate does not outlive the screen that needed it.
 *
 * ## Waypoint ordering, honestly
 *
 * `RouteRequest.waypoints` is "intermediate stops, in order" and the engine
 * behind it (Valhalla) visits them in exactly the order it is given. Moving a
 * stop up or down here therefore changes the ORDER WE SEND and, through that,
 * the route — it is not a travelling-salesman solve, nothing asks the engine to
 * optimise the sequence, and the UI never offers to. That is a client-side
 * reorder in the only sense that matters: the reasoning is local, the effect is
 * real, and no "optimise route" affordance is implied.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toGeoCoordinate } from '@goway.to/sdk';
import type { GeoCoordinate, Place, Route, RouteLocation, SearchResult, TravelMode } from '@goway.to/sdk';

import type { MapApi, MapFitOptions, MapMarker, MapOverlay } from '@/components/map';
import { gowayClient } from '@/lib/goway/client';
import { classifyGoWayError, shouldRetryGoWay, type GoWayFailureKind } from '@/lib/goway/errors';
import { distanceMeters } from '@/lib/map/geo';
import type { LocationErrorReason, UserLocationApi } from '@/lib/map/useUserLocation';

import { routeSteps, stepCoordinates, type RouteStep } from './maneuvers';
import {
  isSameStop,
  slotLabel,
  slotName,
  stopFromDevice,
  stopFromPlace,
  stopFromPoint,
  stopFromResult,
  toRouteLocation,
  type DirectionsStop,
} from './stops';

/** Most stops a single request may carry. Past this the panel stops being readable. */
export const MAX_STOPS = 8;

/** Stable identity for "nothing to draw", so the canvas is not re-applied. */
const EMPTY_OVERLAYS: readonly MapOverlay[] = [];

/** Never zoom past this when centring one maneuver. */
const STEP_MAX_ZOOM = 17;

/**
 * How far the map centre must be from the other end before it is worth
 * offering as a starting point, in metres.
 *
 * Opening a place flies the camera onto it, so "the middle of the map" and "the
 * place you are looking at" are regularly the same point — and a route from a
 * place to itself is not a way forward, it is a zero that looks like a bug.
 */
const MIN_ALTERNATIVE_ORIGIN_METERS = 50;

/** Radius searched for a name to put on a tapped point. */
const REVERSE_GEOCODE_RADIUS_M = 80;

export interface DirectionsOptions {
  mapRef: RefObject<MapApi | null>;
  /**
   * Shared with the map's "My location" control, deliberately: one hook means
   * one permission prompt and one in-flight fix, however the user got here.
   */
  location: UserLocationApi;
  /** Centre of the box the user committed to browsing, for the map fallback. */
  mapCenter: GeoCoordinate | null;
  /** `0` when the user has asked their system for less motion. */
  cameraDuration: number | undefined;
  /**
   * Padding to keep clear when framing a route. Asymmetric: the sheet or the
   * panel is over part of the canvas, and a centred route is half hidden.
   */
  fitPadding: MapFitOptions['padding'];
}

export interface DirectionsController {
  /** `true` while the app is in the planner. */
  active: boolean;
  /** Origin first, destination last, waypoints in between. `null` is an empty field. */
  stops: readonly (DirectionsStop | null)[];
  /** Every slot is filled and the two ends are different places. */
  ready: boolean;
  /** Both ends resolve to the same point — a real state, not an error. */
  degenerate: boolean;

  /** Which slot the user is filling, if any. */
  editing: number | null;
  /** The text typed into the slot being filled. */
  draft: string;
  setDraft: (value: string) => void;
  beginEdit: (index: number) => void;
  endEdit: () => void;

  /** Slot waiting for a tap on the map, if any. */
  picking: number | null;
  chooseOnMap: (index: number) => void;
  cancelPicking: () => void;
  /** Feed a map tap in. Does nothing unless a slot is waiting for one. */
  /**
   * A tap on the map while a slot is waiting for a point.
   *
   * `name` is what the BASEMAP called whatever was under the finger, when the
   * tap landed on one of its labels. Supplying it is not cosmetic: it is both a
   * better label than "Point on the map" and a saved reverse geocode, because
   * the name the user was looking at is the name they meant.
   */
  onMapPress: (coordinate: GeoCoordinate, name?: string) => void;

  setStopFromPlace: (index: number, place: Place) => void;
  setStopFromResult: (index: number, result: SearchResult) => void;
  clearStop: (index: number) => void;
  /** Ask the device where it is, for this slot. The only thing that prompts. */
  setStopFromDevice: (index: number) => void;
  /**
   * Use the centre of the browsed area for this slot, as an EXPLICIT choice.
   * `null` when there is nothing sane to offer, so no UI can render a control
   * that would invent a starting point.
   */
  setStopFromMapCentre: ((index: number) => void) | null;

  swap: () => void;
  addStop: () => void;
  removeStop: (index: number) => void;
  /** Move an intermediate stop one place earlier or later in the itinerary. */
  moveStop: (index: number, direction: -1 | 1) => void;
  canAddStop: boolean;

  travelMode: TravelMode;
  setTravelMode: (mode: TravelMode) => void;

  route: Route | null;
  routeBusy: boolean;
  /**
   * Why there is no route to show, or `null` when there is one (or when none
   * has been asked for yet).
   *
   * When this is set, {@link DirectionsController.overlays} is EMPTY. That
   * pairing is the whole honesty rule of this feature: GoWay either knows the
   * way and draws it, or says it does not. It never draws the straight line
   * between the stops, because a straight line rendered in the route's own
   * colour is indistinguishable from an answer — and being confidently wrong
   * about how to get somewhere is worse than admitting we could not work it
   * out.
   */
  routeFailure: GoWayFailureKind | null;
  retryRoute: () => void;
  steps: readonly RouteStep[];
  selectedStep: number | null;
  selectStep: (index: number | null) => void;

  /** The route line, plus the highlighted step when one is selected. */
  overlays: readonly MapOverlay[];
  /** A, B and the numbered stops. */
  markers: readonly MapMarker[];

  /** Why the slot that asked for the device has no coordinate yet. */
  locationFailure: LocationErrorReason | null;
  /** The slot an outstanding permission prompt belongs to. */
  locationSlot: number | null;
  locationBusy: boolean;
  canAskLocationAgain: boolean;
  /** Ask again for whichever slot asked. */
  retryLocation: () => void;

  /** Enter the planner with this place as the destination. */
  openTo: (place: Place) => void;
  /** Enter the planner with this search result as the destination. */
  openToResult: (result: SearchResult) => void;
  /**
   * Enter with a bare point as the destination, under a name somebody can read.
   *
   * For a basemap label GoWay holds no place record for: there is no place ID
   * to route by, so the coordinate travels, and the name travels with it so the
   * field does not read "Point on the map" for something the user tapped BY
   * name.
   */
  openToPoint: (coordinate: GeoCoordinate, name: string) => void;
  /** Enter the planner with nothing filled in. */
  open: () => void;
  /** Leave. The camera is not moved: browsing resumes where the map already is. */
  close: () => void;
}

export function useDirections(options: DirectionsOptions): DirectionsController {
  const { mapRef, location, mapCenter, cameraDuration, fitPadding } = options;

  const [active, setActive] = useState(false);
  const [stops, setStops] = useState<Array<DirectionsStop | null>>([null, null]);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [picking, setPicking] = useState<number | null>(null);
  const [travelMode, setTravelMode] = useState<TravelMode>('walk');
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [locationSlot, setLocationSlot] = useState<number | null>(null);

  // ── Editing the itinerary ────────────────────────────────────────────────

  /**
   * Put a stop in a slot.
   *
   * `null` means the stop could not be BUILT — `stops.ts` refuses a coordinate
   * that is not a point on the earth, because a stop becomes a pin and a pin
   * with a `NaN` coordinate throws out of MapLibre rather than drawing wrong.
   * It leaves the slot exactly as it was: an empty field the user can fill
   * again, not a cleared one and not a broken one. Clearing on purpose is
   * `clearStop`.
   */
  const setStopAt = useCallback((index: number, stop: DirectionsStop | null) => {
    if (!stop) return;
    setStops((current) => {
      if (index < 0 || index >= current.length) return current;
      const next = current.slice();
      next[index] = stop;
      return next;
    });
    setEditing(null);
    setDraft('');
    setPicking(null);
    // A different itinerary is a different route; a step index from the old one
    // would point into a line that no longer exists.
    setSelectedStep(null);
    setLocationSlot((slot) => (slot === index ? null : slot));
  }, []);

  const setStopFromPlace = useCallback(
    (index: number, place: Place) => setStopAt(index, stopFromPlace(place)),
    [setStopAt],
  );

  const setStopFromResult = useCallback(
    (index: number, result: SearchResult) => setStopAt(index, stopFromResult(result)),
    [setStopAt],
  );

  const clearStop = useCallback((index: number) => {
    setStops((current) => {
      const next = current.slice();
      next[index] = null;
      return next;
    });
    setSelectedStep(null);
  }, []);

  const beginEdit = useCallback((index: number) => {
    setEditing(index);
    setDraft('');
    setPicking(null);
  }, []);

  const endEdit = useCallback(() => {
    setEditing(null);
    setDraft('');
  }, []);

  /**
   * Swap the two ends.
   *
   * The WHOLE itinerary reverses, not just the first and last slot: "there and
   * back" past the same three stops is the trip a user means by swapping, and
   * reversing only the ends while leaving the waypoints in their original order
   * silently produces a different journey from the one they were looking at.
   */
  const swap = useCallback(() => {
    setStops((current) => current.slice().reverse());
    setSelectedStep(null);
    setEditing(null);
    setDraft('');
  }, []);

  const addStop = useCallback(() => {
    setStops((current) => {
      if (current.length >= MAX_STOPS) return current;
      const next = current.slice();
      next.splice(current.length - 1, 0, null);
      return next;
    });
    setSelectedStep(null);
    // The new slot is the one before the destination; open it for filling, so
    // adding a stop and saying which stop are one gesture.
    setEditing(stops.length - 1);
    setDraft('');
  }, [stops.length]);

  const removeStop = useCallback((index: number) => {
    setStops((current) => {
      // The two ends are structural: a route with one end is not a route. They
      // are CLEARED rather than removed.
      if (current.length <= 2) {
        const next = current.slice();
        next[index] = null;
        return next;
      }
      return current.filter((_, position) => position !== index);
    });
    setEditing(null);
    setDraft('');
    setSelectedStep(null);
  }, []);

  const moveStop = useCallback((index: number, direction: -1 | 1) => {
    setStops((current) => {
      const target = index + direction;
      // Only the intermediate stops move; A stays A and B stays B. Somebody who
      // wants a different destination edits the destination.
      if (index <= 0 || index >= current.length - 1) return current;
      if (target <= 0 || target >= current.length - 1) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setSelectedStep(null);
  }, []);

  // ── Filling a slot from the world ────────────────────────────────────────

  /**
   * The device's own position, for one named slot.
   *
   * This is the only call in the planner that can produce a system permission
   * prompt, and it only runs from a user action: pressing Directions, pressing
   * "Your location", or retrying after a failure. A `null` answer is not
   * silence — `location.error` carries which of the reasons it was, and
   * `locationSlot` says which field is waiting, so the panel can say it beside
   * the right field.
   */
  const setStopFromDevice = useCallback(
    (index: number) => {
      setLocationSlot(index);
      setEditing(null);
      setDraft('');
      setPicking(null);
      void location.locate().then((coordinate) => {
        if (!coordinate) return;
        setStopAt(index, stopFromDevice(coordinate));
      });
    },
    [location, setStopAt],
  );

  const retryLocation = useCallback(() => {
    if (locationSlot == null) return;
    setStopFromDevice(locationSlot);
  }, [locationSlot, setStopFromDevice]);

  const chooseOnMap = useCallback((index: number) => {
    setPicking(index);
    setEditing(null);
    setDraft('');
  }, []);

  const cancelPicking = useCallback(() => setPicking(null), []);

  /**
   * Put a name on a point the user tapped.
   *
   * Cosmetic on purpose. The reverse geocode may well answer with a GoWay
   * place, and adopting its place ID would be tempting — but the user tapped a
   * POINT, and quietly turning that into "route to this shop's entrance" is a
   * substitution they did not ask for and cannot see. The coordinate stays the
   * stop; only the label improves.
   */
  const reverseGeocode = useRef<AbortController | null>(null);
  const nameThePoint = useCallback((stopId: string, coordinate: GeoCoordinate) => {
    reverseGeocode.current?.abort();
    const controller = new AbortController();
    reverseGeocode.current = controller;
    void gowayClient.geocode
      .reverse(
        { ...coordinate, radiusMeters: REVERSE_GEOCODE_RADIUS_M, limit: 1 },
        { signal: controller.signal },
      )
      .then((answer) => {
        const name = answer.results[0]?.displayName;
        if (!name) return;
        setStops((current) =>
          current.map((stop) => (stop && stop.id === stopId ? { ...stop, label: name } : stop)),
        );
      })
      .catch(() => {
        // No name is a fine outcome: the field already reads "Point on the map",
        // which is exactly what it is.
      });
  }, []);

  useEffect(() => () => reverseGeocode.current?.abort(), []);

  const onMapPress = useCallback(
    (coordinate: GeoCoordinate, name?: string) => {
      if (picking == null) return;
      const named = name?.trim();
      const stop = named ? stopFromPoint(coordinate, named) : stopFromPoint(coordinate);
      // A press the engine could not turn into a real point is not a stop, so
      // the slot stays open and nothing is reverse-geocoded for it.
      if (!stop) return;
      setStopAt(picking, stop);
      // No reverse geocode when the basemap already told us what this is. The
      // label the user tapped is a better answer than the nearest address, and
      // overwriting it a moment later with one would look like a bug.
      if (!named) nameThePoint(stop.id, coordinate);
    },
    [nameThePoint, picking, setStopAt],
  );

  /**
   * The browsed area's centre, as a starting point the user chooses on purpose.
   *
   * `null` disables the affordance entirely rather than letting it produce
   * something meaningless — which is the mechanical form of "never silently
   * substitute the map centre for the user's position". What it produces is a
   * `map` stop, labelled as such wherever it is shown.
   */
  const mapCentreOffer = useMemo(() => {
    if (!mapCenter) return null;
    const others = stops.filter((stop): stop is DirectionsStop => stop != null);
    if (others.some((stop) => distanceMeters(mapCenter, stop.coordinate) < MIN_ALTERNATIVE_ORIGIN_METERS)) {
      return null;
    }
    return mapCenter;
  }, [mapCenter, stops]);

  const setStopFromMapCentre = useCallback(
    (index: number) => {
      if (!mapCentreOffer) return;
      setStopAt(index, stopFromPoint(mapCentreOffer, 'Centre of the area you were browsing'));
    },
    [mapCentreOffer, setStopAt],
  );

  // ── Entering and leaving ─────────────────────────────────────────────────

  /**
   * Enter with a destination already chosen.
   *
   * The common path stays one tap: the destination is what the user was looking
   * at, and the origin asks the device immediately — which is the same single
   * permission prompt the old button produced, in the same gesture.
   */
  const openWith = useCallback(
    (destination: DirectionsStop | null) => {
      // No drawable destination, no planner: entering it with an empty B and no
      // way to say why is worse than staying where the user was.
      if (!destination) return;
      setActive(true);
      setStops([null, destination]);
      setEditing(null);
      setDraft('');
      setPicking(null);
      setSelectedStep(null);
      setLocationSlot(0);
      void location.locate().then((coordinate) => {
        if (!coordinate) return;
        setStopAt(0, stopFromDevice(coordinate));
      });
    },
    [location, setStopAt],
  );

  const openTo = useCallback((place: Place) => openWith(stopFromPlace(place)), [openWith]);
  const openToResult = useCallback(
    (result: SearchResult) => openWith(stopFromResult(result)),
    [openWith],
  );
  const openToPoint = useCallback(
    (coordinate: GeoCoordinate, name: string) => openWith(stopFromPoint(coordinate, name)),
    [openWith],
  );

  const open = useCallback(() => {
    setActive(true);
    setStops([null, null]);
    setDraft('');
    setPicking(null);
    setSelectedStep(null);
    setLocationSlot(null);
    // Nothing is known, so the destination is the useful question. The origin
    // is left alone — no prompt until the user asks for one.
    setEditing(1);
  }, []);

  const close = useCallback(() => {
    setActive(false);
    setStops([null, null]);
    setEditing(null);
    setDraft('');
    setPicking(null);
    setSelectedStep(null);
    setLocationSlot(null);
    // The fix was request data for a request that is over (AGENTS.md → Privacy).
    location.forget();
    // Deliberately no camera move: the user leaves the planner looking at what
    // they were looking at, which is the whole "map is never thrown away" rule.
  }, [location]);

  // ── The request ──────────────────────────────────────────────────────────

  const filled = useMemo(
    () => stops.filter((stop): stop is DirectionsStop => stop != null),
    [stops],
  );
  const complete = stops.length >= 2 && filled.length === stops.length;
  const degenerate = complete && isSameStop(stops[0], stops[stops.length - 1]);
  const ready = complete && !degenerate;

  /**
   * The itinerary as the contract wants it.
   *
   * Built once here so the query key and the request body cannot disagree: they
   * are literally the same objects, which is what makes "the route refetches
   * when a stop changes" true rather than nearly true.
   */
  const locations: RouteLocation[] | null = useMemo(
    () => (ready ? (stops as DirectionsStop[]).map(toRouteLocation) : null),
    [ready, stops],
  );

  const routeQuery = useQuery({
    queryKey: ['goway', 'route', locations, travelMode],
    enabled: locations != null,
    retry: shouldRetryGoWay,
    // A route is a question, not a record. Nothing keeps it once the planner
    // stops watching it — which also means a device coordinate never sits in a
    // cache after the flow that needed it has ended.
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const itinerary = locations as RouteLocation[];
      const waypoints = itinerary.slice(1, -1);
      return gowayClient.routes.directions(
        {
          origin: itinerary[0],
          destination: itinerary[itinerary.length - 1],
          ...(waypoints.length > 0 ? { waypoints } : {}),
          mode: travelMode,
        },
        { signal },
      );
    },
  });

  const route = routeQuery.data?.routes[0] ?? null;

  const routeFailure: GoWayFailureKind | null = useMemo(() => {
    if (routeQuery.error) {
      const { kind } = classifyGoWayError(routeQuery.error);
      return kind === 'aborted' ? null : kind;
    }
    // The OTHER shape of "no route exists": a 200 with an empty array. The SDK
    // documents both as valid and `classifyGoWayError` maps `no_route` to the
    // same kind, so the panel has one branch to render rather than two.
    if (routeQuery.data && routeQuery.data.routes.length === 0) return 'noRoute';
    return null;
  }, [routeQuery.data, routeQuery.error]);

  const refetchRoute = routeQuery.refetch;
  const retryRoute = useCallback(() => void refetchRoute(), [refetchRoute]);

  const steps = useMemo(() => (route ? routeSteps(route) : []), [route]);

  const selectStep = useCallback(
    (index: number | null) => {
      setSelectedStep(index);
      if (index == null || !route) return;
      const step = steps[index];
      if (!step) return;
      // `geometryIndex` is what makes this a slice rather than a search — see
      // `maneuvers.ts`. Framing the SEGMENT rather than centring on the turn
      // shows the user what the instruction is about.
      mapRef.current?.fitCoordinates(stepCoordinates(route, step), {
        padding: fitPadding,
        maxZoom: STEP_MAX_ZOOM,
        duration: cameraDuration,
      });
    },
    [cameraDuration, fitPadding, mapRef, route, steps],
  );

  // ── The map ──────────────────────────────────────────────────────────────

  const overlays = useMemo<readonly MapOverlay[]>(() => {
    if (!route) return EMPTY_OVERLAYS;
    const line: MapOverlay = {
      id: 'goway-route',
      kind: 'line',
      data: { type: 'Feature', geometry: route.geometry, properties: {} },
      paint: { width: 5 },
    };
    const step = selectedStep != null ? steps[selectedStep] : undefined;
    if (!step) return [line];
    const highlight = stepCoordinates(route, step);
    // No drawable slice, no highlight — rather than a Point built out of
    // `highlight[0].longitude` on an empty array, which is a `TypeError` inside
    // a `useMemo` and therefore the whole screen.
    if (highlight.length === 0) return [line];
    // A single-point slice cannot be a line; a circle says "here" honestly,
    // where a two-identical-point LineString would draw nothing at all.
    const overlay: MapOverlay =
      highlight.length > 1
        ? {
            id: 'goway-route-step',
            kind: 'line',
            data: {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: highlight.map(({ latitude, longitude }) => [longitude, latitude]),
              },
            },
            paint: { width: 9, opacity: 0.85 },
          }
        : {
            id: 'goway-route-step',
            kind: 'circle',
            data: {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'Point',
                coordinates: [highlight[0].longitude, highlight[0].latitude],
              },
            },
            paint: { radius: 7 },
          };
    return [line, overlay];
  }, [route, selectedStep, steps]);

  const markers = useMemo<readonly MapMarker[]>(() => {
    const total = stops.length;
    const built: MapMarker[] = [];
    stops.forEach((stop, index) => {
      if (!stop) return;
      built.push({
        id: `goway-stop-${stop.id}`,
        coordinate: stop.coordinate,
        kind: 'route-stop',
        label: slotLabel(index, total),
        selected: editing === index,
        accessibilityLabel: `${slotName(index, total)}: ${stop.label}`,
      });
    });
    return built;
  }, [editing, stops]);

  /**
   * Frame the route once it lands.
   *
   * Keyed rather than run every render: a background refetch re-resolving to
   * the same route must not yank the camera back from wherever the user has
   * since dragged it. `fitCoordinates` is programmatic, so this cannot arm
   * "Search this area".
   *
   * The padding is asymmetric and comes from the screen, which is the only
   * thing that knows how much of the canvas its sheet or panel is covering.
   */
  const framed = useRef<string | null>(null);
  useEffect(() => {
    if (!route) {
      framed.current = null;
      return;
    }
    const key = `${route.id}:${route.mode}:${route.distanceMeters}:${route.geometry.coordinates.length}`;
    if (framed.current === key) return;
    framed.current = key;
    mapRef.current?.fitCoordinates(route.geometry.coordinates.map(toGeoCoordinate), {
      padding: fitPadding,
      duration: cameraDuration,
    });
  }, [cameraDuration, fitPadding, mapRef, route]);

  return {
    active,
    stops,
    ready,
    degenerate,

    editing,
    draft,
    setDraft,
    beginEdit,
    endEdit,

    picking,
    chooseOnMap,
    cancelPicking,
    onMapPress,

    setStopFromPlace,
    setStopFromResult,
    clearStop,
    setStopFromDevice,
    setStopFromMapCentre: mapCentreOffer ? setStopFromMapCentre : null,

    swap,
    addStop,
    removeStop,
    moveStop,
    canAddStop: stops.length < MAX_STOPS,

    travelMode,
    setTravelMode,

    route,
    routeBusy: routeQuery.isFetching,
    routeFailure,
    retryRoute,
    steps,
    selectedStep,
    selectStep,

    overlays,
    markers,

    // A failure belongs to the slot that asked. `useUserLocation` is shared
    // with the map's own "My location" control, and a failure THERE must not
    // surface as an unexplained complaint inside the planner.
    locationFailure: locationSlot != null ? location.error : null,
    locationSlot,
    locationBusy: location.isLocating,
    canAskLocationAgain: location.canAskAgain,
    retryLocation,

    openTo,
    openToResult,
    openToPoint,
    open,
    close,
  };
}
