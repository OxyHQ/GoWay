/**
 * The explore screen's brain: one hook, no JSX.
 *
 * Everything that decides WHAT is on screen lives here — what has been searched,
 * what is selected, which box the results came from, when "Search this area"
 * should offer itself — so the screen components stay about layout and the
 * rules stay readable in one place. The three flows issue #7 asks for are not
 * three screens: browse, search and place details are three states of the same
 * map, and the transitions between them are the product.
 *
 * Two things this hook is careful about, both of which are easy to lose:
 *
 *  - **The map is never thrown away.** Selecting a result moves the camera and
 *    changes what the sheet shows; it does not navigate. There is no back stack
 *    to lose your place in.
 *  - **The committed box is not the live camera.** Results come from the box
 *    the user has AGREED to (the opening view, or the one they pressed "Search
 *    this area" on). Refetching on every frame of a pan is a bad network
 *    citizen and a list that never settles.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useReducedMotion } from 'react-native-reanimated';
import type {
  GeoCoordinate,
  Place,
  PlaceCapability,
  Route,
  RouteLocation,
  SearchResult,
  TravelMode,
} from '@goway.to/sdk';

import type { GeoBounds, MapApi, MapMarker, MapViewportChange, ResolvedMapViewport } from '@/components/map';
import { DEFAULT_VIEWPORT } from '@/components/map';
import { boundsCenter, distanceMeters } from '@/lib/map/geo';
import { gowayClient } from '@/lib/goway/client';
import { visibleCapabilities } from '@/lib/goway/capabilities';
import { CATEGORY_SHORTCUTS } from '@/lib/goway/categories';
import { classifyGoWayError, shouldRetryGoWay, type GoWayFailureKind } from '@/lib/goway/errors';
import { buildMarkers } from '@/lib/goway/markers';
import { MIN_SEARCH_LENGTH, usePlace, usePlacesInBounds, useSearch } from '@/lib/goway/queries';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useUserLocation } from '@/lib/map/useUserLocation';

/** What the sheet is currently about. */
export type ExploreMode = 'browse' | 'search' | 'details';

/** What the user picked. A geocoder candidate is NOT a place; see `ResultRows`. */
export type ExploreSelection =
  | { kind: 'place'; placeId: string; seed?: Place }
  | { kind: 'result'; result: SearchResult };

/** How long the search box waits for typing to stop. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * How far the camera must move before "Search this area" offers itself, as a
 * fraction of the viewport's own diagonal.
 *
 * A fraction rather than a distance, because the same drag means something
 * different at every zoom: 300 m is most of the screen at z17 and invisible at
 * z11. A zoom change of a full level counts on its own — the same centre at
 * twice the scale is a different question.
 */
const AREA_MOVE_FRACTION = 0.3;
const AREA_ZOOM_DELTA = 1;

/** Zoom the camera settles at when a place is opened from a list. */
const DETAIL_ZOOM = 16;

/** Padding kept around a cluster the user opened, in px. */
const CLUSTER_FIT_PADDING = 96;

interface Committed {
  bounds: GeoBounds;
  center: GeoCoordinate;
  zoom: number;
}

export interface ExploreController {
  mode: ExploreMode;

  query: string;
  setQuery: (value: string) => void;
  clearQuery: () => void;
  searchBusy: boolean;
  /** Search failed; the panel shows the matching sentence. */
  searchFailure: GoWayFailureKind | null;
  /** Some geocoders answered and some did not — a short list, not an error. */
  degradedProviders: readonly string[];
  results: readonly SearchResult[];

  places: readonly Place[];
  /** Centre of the committed box, for ordering a list by distance. */
  center: GeoCoordinate | null;
  placesBusy: boolean;
  placesFailure: GoWayFailureKind | null;
  retryPlaces: () => void;
  /** Places the zoom rules are deliberately hiding. */
  hiddenByZoom: number;

  shortcutId: string | null;
  setShortcutId: (id: string | null) => void;

  selection: ExploreSelection | null;
  selectedPlace: Place | null;
  selectedPlaceBusy: boolean;
  selectedPlaceFailure: GoWayFailureKind | null;
  selectPlace: (place: Place) => void;
  selectResult: (result: SearchResult) => void;
  clearSelection: () => void;

  markers: readonly MapMarker[];
  /**
   * Marker id → the strongest live ecosystem capability that place asserts.
   * Drives the enriched marker state; absent for everything else.
   */
  ecosystem: ReadonlyMap<string, PlaceCapability>;
  onMarkerPress: (marker: MapMarker) => void;
  onViewportChange: (change: MapViewportChange) => void;

  /** `true` once the camera has moved far enough to be a different question. */
  areaMoved: boolean;
  searchThisArea: () => void;

  travelMode: TravelMode;
  setTravelMode: (mode: TravelMode) => void;
  requestDirections: () => void;
  route: Route | null;
  routeBusy: boolean;
  routeFailure: GoWayFailureKind | 'noRoute' | null;

  location: ReturnType<typeof useUserLocation>;
}

export function useExplore(
  mapRef: RefObject<MapApi | null>,
  options: { initialPlaceId?: string | null } = {},
): ExploreController {
  const location = useUserLocation();
  // A camera flight is motion like any other: somebody who has asked their
  // system for less of it gets the same destination, immediately.
  const reducedMotion = useReducedMotion();
  const cameraDuration = reducedMotion ? 0 : undefined;

  const [query, setQueryState] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);

  const [shortcutId, setShortcutId] = useState<string | null>(null);
  const [selection, setSelection] = useState<ExploreSelection | null>(
    options.initialPlaceId ? { kind: 'place', placeId: options.initialPlaceId } : null,
  );

  const [committed, setCommitted] = useState<Committed | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_VIEWPORT.zoom);
  const [areaMoved, setAreaMoved] = useState(false);
  /** The camera as last reported, for the biasing and movement tests. */
  const viewportRef = useRef<ResolvedMapViewport | null>(null);

  const categories = useMemo(() => {
    const shortcut = CATEGORY_SHORTCUTS.find((entry) => entry.id === shortcutId);
    return shortcut ? shortcut.categories : undefined;
  }, [shortcutId]);

  // ── Data ─────────────────────────────────────────────────────────────────

  const placesQuery = usePlacesInBounds(committed?.bounds ?? null, { categories });
  const places = useMemo(() => placesQuery.data ?? [], [placesQuery.data]);

  const searchQuery = useSearch(debouncedQuery, {
    // `near` (the user's own position) outranks `viewport`; the SDK ignores the
    // second when the first is present, so passing both is harmless and lets
    // the bias improve the moment they press "My location".
    near: location.coordinate,
    viewport: committed?.bounds ?? null,
    categories,
  });

  const searching = debouncedQuery.trim().length >= MIN_SEARCH_LENGTH;
  const results = useMemo(() => searchQuery.data?.results ?? [], [searchQuery.data]);

  const selectedPlaceId = selection?.kind === 'place' ? selection.placeId : null;
  const placeQuery = usePlace(selectedPlaceId, selection?.kind === 'place' ? selection.seed : undefined);

  // ── Mode ─────────────────────────────────────────────────────────────────

  const mode: ExploreMode = selection ? 'details' : searching ? 'search' : 'browse';

  // ── Markers ──────────────────────────────────────────────────────────────

  const selectedMarkerId =
    selection?.kind === 'place' ? selection.placeId : selection?.kind === 'result' ? selection.result.id : null;

  const built = useMemo(() => {
    // In search mode the map shows what the user asked for, not what happens to
    // be in the box — otherwise the pin they are looking at is one of forty.
    if (searching) {
      return {
        markers: results.map((result) => resultMarker(result, result.id === selectedMarkerId)),
        clusters: new Map<string, Place[]>(),
        hiddenByZoom: 0,
      };
    }
    return buildMarkers({ places, zoom, selectedPlaceId });
  }, [searching, results, selectedMarkerId, places, zoom, selectedPlaceId]);

  /**
   * The badge-worthy capability per marker, keyed by MARKER id.
   *
   * In search mode a marker is keyed by the result's id rather than the place's,
   * so the index is built from whatever is actually on the map — otherwise the
   * enriched state silently disappears the moment the user searches.
   */
  const ecosystem = useMemo(() => {
    const index = new Map<string, PlaceCapability>();
    const strongest = (place: Place) => visibleCapabilities(place.capabilities)[0];

    if (searching) {
      for (const result of results) {
        const capability = result.place ? strongest(result.place) : undefined;
        if (capability) index.set(result.id, capability);
      }
      return index;
    }
    for (const place of places) {
      const capability = strongest(place);
      if (capability) index.set(place.id, capability);
    }
    return index;
  }, [places, results, searching]);

  // ── Camera ───────────────────────────────────────────────────────────────

  const commitViewport = useCallback((viewport: ResolvedMapViewport, bounds: GeoBounds) => {
    setCommitted({ bounds, center: boundsCenter(bounds), zoom: viewport.zoom });
    setAreaMoved(false);
  }, []);

  const onViewportChange = useCallback(
    (change: MapViewportChange) => {
      viewportRef.current = change.viewport;

      // Zoom drives marker visibility, so it has to track the live camera — but
      // only when it has moved enough to change an answer. Re-rendering every
      // marker on a 0.02-level wheel tick is how a map becomes unresponsive.
      setZoom((current) => (Math.abs(current - change.viewport.zoom) >= 0.25 ? change.viewport.zoom : current));

      if (!change.isFinal) return;

      if (!committed) {
        // The first settled frame is the box the user opened into; results come
        // from it without anybody pressing anything.
        commitViewport(change.viewport, change.bounds);
        return;
      }

      // `source` is why this exists on the event at all: a camera the APP moved
      // (opening a result, fitting a cluster) must never arm the button for the
      // search that is already showing.
      if (change.source !== 'user') return;

      const diagonal = distanceMeters(
        { latitude: change.bounds.south, longitude: change.bounds.west },
        { latitude: change.bounds.north, longitude: change.bounds.east },
      );
      const moved = distanceMeters(committed.center, change.viewport);
      const zoomed = Math.abs(change.viewport.zoom - committed.zoom) >= AREA_ZOOM_DELTA;

      setAreaMoved(moved > diagonal * AREA_MOVE_FRACTION || zoomed);
    },
    [committed, commitViewport],
  );

  const searchThisArea = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    void mapRef.current?.getBounds().then((bounds) => {
      if (!bounds) return;
      commitViewport(viewport, bounds);
    });
  }, [commitViewport, mapRef]);

  // ── Selection ────────────────────────────────────────────────────────────

  const focus = useCallback(
    (coordinate: GeoCoordinate) => {
      const current = viewportRef.current?.zoom ?? DEFAULT_VIEWPORT.zoom;
      // Never zoom OUT to open a place: the user's frame of reference is what
      // makes a selection feel like a step rather than a jump.
      mapRef.current?.moveTo(coordinate, { zoom: Math.max(current, DETAIL_ZOOM), duration: cameraDuration });
    },
    [cameraDuration, mapRef],
  );

  const selectPlace = useCallback(
    (place: Place) => {
      setSelection({ kind: 'place', placeId: place.id, seed: place });
      focus(place.location);
    },
    [focus],
  );

  const selectResult = useCallback(
    (result: SearchResult) => {
      if (result.place) {
        selectPlace(result.place);
        return;
      }
      setSelection({ kind: 'result', result });
      // A locality or a street has an EXTENT; framing it says more than
      // dropping a pin in the middle of it and zooming to 16.
      if (result.boundingBox) {
        mapRef.current?.fitBounds(result.boundingBox, {
          padding: CLUSTER_FIT_PADDING,
          maxZoom: 15,
          duration: cameraDuration,
        });
      } else {
        focus(result.coordinate);
      }
    },
    [cameraDuration, focus, mapRef, selectPlace],
  );

  const clearSelection = useCallback(() => setSelection(null), []);

  /**
   * Frame a deep-linked place once it arrives.
   *
   * `https://goway.to/place/<id>` has a place ID and no coordinate, so the
   * camera cannot move until the fetch lands. It runs ONCE — after that the
   * user owns the camera, and re-framing on every refetch would yank the map
   * back from wherever they had dragged it.
   */
  const deepLinkFramed = useRef(!options.initialPlaceId);
  useEffect(() => {
    if (deepLinkFramed.current) return;
    const place = placeQuery.data;
    if (!place || place.id !== options.initialPlaceId) return;
    deepLinkFramed.current = true;
    mapRef.current?.moveTo(place.location, { zoom: DETAIL_ZOOM, duration: cameraDuration });
  }, [placeQuery.data, options.initialPlaceId, cameraDuration, mapRef]);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    // Typing is a new question; the open place is the answer to the old one.
    setSelection(null);
  }, []);

  const clearQuery = useCallback(() => {
    setQueryState('');
    setSelection(null);
  }, []);

  const onMarkerPress = useCallback(
    (marker: MapMarker) => {
      const cluster = built.clusters.get(marker.id);
      if (cluster) {
        mapRef.current?.fitCoordinates(
          cluster.map((entry) => entry.location),
          { padding: CLUSTER_FIT_PADDING, maxZoom: 17, duration: cameraDuration },
        );
        return;
      }
      if (searching) {
        const result = results.find((entry) => entry.id === marker.id);
        if (result) selectResult(result);
        return;
      }
      const place = places.find((entry) => entry.id === marker.id);
      if (place) selectPlace(place);
    },
    [built.clusters, cameraDuration, mapRef, places, results, searching, selectPlace, selectResult],
  );

  // ── Directions ───────────────────────────────────────────────────────────

  const [travelMode, setTravelMode] = useState<TravelMode>('walk');
  const [routeOrigin, setRouteOrigin] = useState<GeoCoordinate | null>(null);

  /**
   * Where the route is going.
   *
   * A GoWay place travels as its ID, never as its coordinate: a building
   * centroid is not necessarily reachable, and which entrance a router should
   * aim at is GoWay's knowledge, not this screen's. A geocoder candidate has no
   * place ID, so it travels as the point it is.
   */
  const routeDestination: RouteLocation | null = useMemo(() => {
    if (placeQuery.data) return { placeId: placeQuery.data.id, name: placeQuery.data.name };
    if (selection?.kind === 'result') {
      return { coordinate: selection.result.coordinate, name: selection.result.displayName };
    }
    return null;
  }, [placeQuery.data, selection]);

  const routeQuery = useQuery({
    queryKey: ['goway', 'route', routeDestination, travelMode, routeOrigin],
    enabled: routeOrigin != null && routeDestination != null,
    retry: shouldRetryGoWay,
    queryFn: async ({ signal }) =>
      gowayClient.routes.directions(
        {
          origin: { coordinate: routeOrigin as GeoCoordinate },
          destination: routeDestination as RouteLocation,
          mode: travelMode,
        },
        { signal },
      ),
  });

  /**
   * Directions is a location-dependent ACTION, which is the only thing that may
   * ask for the permission (AGENTS.md → Privacy). A decline is a normal answer:
   * no route, no error screen, and the map is untouched.
   */
  const requestDirections = useCallback(() => {
    void location.locate().then((coordinate) => {
      if (coordinate) setRouteOrigin(coordinate);
    });
  }, [location]);

  const route = routeQuery.data?.routes[0] ?? null;
  const routeFailure: GoWayFailureKind | 'noRoute' | null = routeQuery.error
    ? classifyGoWayError(routeQuery.error).kind
    : routeQuery.data && routeQuery.data.routes.length === 0
      ? 'noRoute'
      : null;

  return {
    mode,

    query,
    setQuery,
    clearQuery,
    searchBusy: searchQuery.isFetching,
    searchFailure: failureOf(searchQuery.error),
    degradedProviders: searchQuery.data?.degradedProviders ?? [],
    results,

    places,
    center: committed?.center ?? null,
    // Busy INCLUDES "the map has not settled yet". Without that the first paint
    // has no bounds, no query and no data, and the panel says "Nothing here
    // yet" about an area nobody has looked at.
    placesBusy: committed == null || (placesQuery.isPending && placesQuery.fetchStatus !== 'idle'),
    placesFailure: failureOf(placesQuery.error),
    retryPlaces: () => void placesQuery.refetch(),
    hiddenByZoom: built.hiddenByZoom,

    shortcutId,
    setShortcutId,

    selection,
    selectedPlace: placeQuery.data ?? null,
    selectedPlaceBusy: placeQuery.isPending && placeQuery.fetchStatus !== 'idle',
    selectedPlaceFailure: failureOf(placeQuery.error),
    selectPlace,
    selectResult,
    clearSelection,

    markers: built.markers,
    ecosystem,
    onMarkerPress,
    onViewportChange,

    areaMoved,
    searchThisArea,

    travelMode,
    setTravelMode,
    requestDirections,
    route,
    routeBusy: routeQuery.isFetching,
    routeFailure,

    location,
  };
}

/**
 * An error the UI should react to.
 *
 * `aborted` is filtered out deliberately: the app cancelled that request
 * itself, and showing "something went wrong" for a superseded search is the
 * classic debounce bug.
 */
function failureOf(error: unknown): GoWayFailureKind | null {
  if (!error) return null;
  const { kind } = classifyGoWayError(error);
  return kind === 'aborted' ? null : kind;
}

/** A search result's marker. A candidate with no reconciled place has no label. */
function resultMarker(result: SearchResult, selected: boolean): MapMarker {
  return {
    id: result.id,
    coordinate: result.coordinate,
    kind: result.place ? 'place' : result.kind,
    label: result.displayName.length > 18 ? `${result.displayName.slice(0, 17)}…` : result.displayName,
    selected,
    accessibilityLabel: `${result.displayName}${selected ? ', selected' : ''}`,
  };
}
