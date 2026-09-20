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
 * Directions is the fourth such state and lives in `features/directions`:
 * everything about a route — the itinerary, the travel mode, the request, the
 * drawn line, the stop pins — belongs to `useDirections`, and this hook only
 * decides when the screen is showing it and lends it the map and the one shared
 * `useUserLocation`.
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
import { useReducedMotion } from 'react-native-reanimated';
import type { GeoCoordinate, Place, PlaceCapability, SearchResult } from '@goway.to/sdk';

import type {
  GeoBounds,
  MapApi,
  MapFitOptions,
  MapLabelFeature,
  MapMarker,
  MapOverlay,
  MapPressEvent,
  MapViewportChange,
  ResolvedMapViewport,
} from '@/components/map';
import { DEFAULT_VIEWPORT } from '@/components/map';
import { sameLabelSet } from '@/components/map/labels';
import { useDirections, type DirectionsController } from '@/features/directions/useDirections';
import { boundsCenter, distanceMeters } from '@/lib/map/geo';
import { declutterMarkerLabels, describeLabel, reconcileLabel } from '@/lib/goway/basemapLabels';
import { visibleCapabilities } from '@/lib/goway/capabilities';
import { CATEGORY_SHORTCUTS } from '@/lib/goway/categories';
import { classifyGoWayError, type GoWayFailureKind } from '@/lib/goway/errors';
import { buildMarkers } from '@/lib/goway/markers';
import { MIN_SEARCH_LENGTH, usePlace, usePlacesInBounds, useSearch } from '@/lib/goway/queries';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useUserLocation } from '@/lib/map/useUserLocation';

/** What the sheet is currently about. */
export type ExploreMode = 'browse' | 'search' | 'details';

/** What the user picked. A geocoder candidate is NOT a place; see `ResultRows`. */
export type ExploreSelection =
  | { kind: 'place'; placeId: string; seed?: Place }
  | { kind: 'result'; result: SearchResult }
  /**
   * A label the BASEMAP drew, tapped, and not (yet) known to be a GoWay place.
   *
   * It is a selection like any other so that the map behaves the same way for
   * it — the camera moves, a pin appears, the sheet opens — while the card it
   * produces says only what the tiles said. The state is frequently temporary:
   * search reconciliation runs underneath it, and a match upgrades this to a
   * `place` selection in place.
   */
  | { kind: 'label'; label: MapLabelFeature };

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

/** Nothing reported yet. A stable identity, so it is not a new array per render. */
const NO_LABELS: readonly MapLabelFeature[] = [];

/** Zoom the camera settles at when a place is opened from a list. */
const DETAIL_ZOOM = 16;

/** Padding kept around a cluster the user opened, in px. */
const CLUSTER_FIT_PADDING = 96;

/**
 * Fallback padding for framing a route, in px, when the screen has not said how
 * much of the canvas it is covering.
 *
 * Uniform, and therefore wrong on a phone — which is exactly why
 * {@link ExploreOptions.mapPadding} exists and the screen passes a four-sided
 * value. This is only what a caller that forgets gets.
 */
const ROUTE_FIT_PADDING = 72;

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
  /** The committed box itself, for biasing a search toward what is on screen. */
  bounds: GeoBounds | null;
  placesBusy: boolean;
  placesFailure: GoWayFailureKind | null;
  retryPlaces: () => void;
  /** Places the zoom rules are deliberately hiding. */
  hiddenByZoom: number;

  shortcutId: string | null;
  setShortcutId: (id: string | null) => void;

  selection: ExploreSelection | null;
  /**
   * The basemap label the user tapped, while GoWay has nothing better for it.
   *
   * Present only in the `label` selection state. `labelCategory` is what the
   * TILES said it was, tidied into words and not translated into a GoWay
   * category — see `basemapLabels.ts` → `describeLabel`.
   */
  selectedLabel: MapLabelFeature | null;
  labelCategory: string | null;
  /** Search reconciliation is still in flight for the tapped label. */
  selectedLabelBusy: boolean;
  selectedPlace: Place | null;
  selectedPlaceBusy: boolean;
  selectedPlaceFailure: GoWayFailureKind | null;
  selectPlace: (place: Place) => void;
  selectResult: (result: SearchResult) => void;
  clearSelection: () => void;

  markers: readonly MapMarker[];
  /**
   * What the BASEMAP is labelling right now, straight from the canvas.
   *
   * Wired to `MapCanvas.onLabelsChange`. Its only job is keeping GoWay's own
   * chips from stacking their text on a name the map already drew; nothing
   * else should read it.
   */
  onLabelsChange: (labels: readonly MapLabelFeature[]) => void;
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

  /**
   * The A→B planner. It owns travel mode, the route and the stop markers; this
   * hook only decides when the screen is showing it.
   */
  directions: DirectionsController;
  /** What the canvas should draw: the route, and the selected step. */
  overlays: readonly MapOverlay[];
  /**
   * A tap on the map.
   *
   * Three outcomes, and which one happens is decided here rather than in the
   * canvas: the planner's "choose on map" takes the coordinate (and the
   * label's name, when there was one, which saves a reverse geocode); a tap on
   * a basemap label opens it; a tap on bare map does nothing, exactly as
   * before.
   */
  onMapPress: (event: MapPressEvent) => void;

  location: ReturnType<typeof useUserLocation>;
}

export interface ExploreOptions {
  /** Opened from `https://goway.to/place/<placeId>`. */
  initialPlaceId?: string | null;
  /**
   * How much of the canvas the sheet or the panel is covering, in px.
   *
   * Only the SCREEN knows this — it is the one holding the layout mode and the
   * sheet's detent — so it is passed in rather than guessed at. It is what
   * stops a fitted route from being framed underneath the sheet.
   */
  mapPadding?: MapFitOptions['padding'];
}

export function useExplore(
  mapRef: RefObject<MapApi | null>,
  options: ExploreOptions = {},
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

  /**
   * What the basemap is currently labelling.
   *
   * Reported by the canvas on every settled frame, and compared by id before it
   * is stored: a fresh array of the same labels would rebuild every marker on
   * the map for nothing. See `components/map/labels.ts` -> `sameLabelSet`.
   */
  const [basemapLabels, setBasemapLabels] = useState<readonly MapLabelFeature[]>(NO_LABELS);
  const onLabelsChange = useCallback((next: readonly MapLabelFeature[]) => {
    setBasemapLabels((current) => (sameLabelSet(current, next) ? current : next));
  }, []);

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

  /**
   * Resolving a tapped basemap label to a GoWay place — through SEARCH, which
   * is the reconciliation GoWay already has.
   *
   * There is deliberately no second reconciliation rule here and no new
   * endpoint. `SearchResult.place` is populated by the backend only when a
   * candidate matched a GoWay place through `places_sources` — the
   * `(source, sourceId)` binding that is the one rule for "these are the same
   * record" — so asking search for the label's own name, biased at the label's
   * own point, and keeping a reconciled result that lands within
   * `LABEL_MATCH_RADIUS_M` reuses that machinery exactly. The React Query cache
   * means tapping the same label twice costs one request.
   *
   * It runs only in the `label` selection state, which the cheap in-memory
   * match in `onMapPress` has already failed to resolve.
   */
  const selectedLabel = selection?.kind === 'label' ? selection.label : null;
  const labelSearch = useSearch(selectedLabel?.name ?? '', {
    near: selectedLabel?.coordinate ?? null,
    enabled: selectedLabel != null,
    limit: 10,
  });
  const labelPlace = useMemo(
    () => (selectedLabel ? reconcileLabel(selectedLabel, labelSearch.data?.results ?? []) : null),
    [labelSearch.data, selectedLabel],
  );

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
   * A tap on the basemap's own label.
   *
   * The label becomes the selection immediately and on its own terms — a name
   * and a category, which is what the user pointed at and all the tiles hold —
   * and GoWay's own search runs underneath it to see whether there is a place
   * record behind it. That order matters: the card is useful in the first
   * frame, and it degrades to the truth rather than to a spinner over an empty
   * card.
   *
   * There is deliberately no client-side shortcut that matches the label
   * against the places already on screen. That would be a second definition of
   * "these are the same record", competing with the backend's one
   * (`places_sources`), written in name strings — see `basemapLabels.ts`.
   */
  const selectLabel = useCallback(
    (label: MapLabelFeature) => {
      setSelection({ kind: 'label', label });
      focus(label.coordinate);
    },
    [focus],
  );

  /**
   * Upgrade a label selection the moment search reconciles it.
   *
   * In place, without a second navigation: the sheet is already open on this
   * thing, the camera is already on it, and what changes is that the card stops
   * saying "GoWay has no record of this" and starts being the record.
   */
  useEffect(() => {
    if (!labelPlace || selection?.kind !== 'label') return;
    setSelection({ kind: 'place', placeId: labelPlace.id, seed: labelPlace });
  }, [labelPlace, selection]);

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

  // ── Directions ───────────────────────────────────────────────────────────

  /**
   * The planner, which owns everything about a route: the itinerary, the travel
   * mode, the request, the line and the stop pins.
   *
   * It shares ONE `useUserLocation` with the map's "My location" control, so
   * however the user arrives at needing a position there is one permission
   * prompt and one in-flight fix.
   */
  const directions = useDirections({
    mapRef,
    location,
    // The centre of the box the user COMMITTED to browsing, not the live
    // camera: opening a place flies the camera onto it, so the live centre at
    // that moment is the destination. Offered explicitly, never substituted.
    mapCenter: committed?.center ?? null,
    cameraDuration,
    fitPadding: options.mapPadding ?? ROUTE_FIT_PADDING,
  });

  /**
   * In the planner the map is about the ROUTE.
   *
   * Forty category pins over a line the user is trying to read is the state
   * where a map stops answering the question it was asked, so the markers
   * become the stops: A, B and whatever is between them.
   */
  /**
   * The pin for a tapped basemap label.
   *
   * A selection the user cannot see is not one, and this is the one case where
   * GoWay deliberately DOES draw a chip over a basemap label: the label says
   * what the place is called, the chip says "this is the thing you tapped and
   * the sheet is about it". It is appended rather than built, because it is not
   * a GoWay place and must not enter the clustering or the marker cap.
   */
  const labelMarker = useMemo<MapMarker | null>(() => {
    if (!selectedLabel) return null;
    return {
      id: `basemap:${selectedLabel.id}`,
      coordinate: selectedLabel.coordinate,
      kind: 'place',
      label: truncate(selectedLabel.name),
      selected: true,
      accessibilityLabel: `${selectedLabel.name}, selected`,
    };
  }, [selectedLabel]);

  /**
   * What the canvas draws.
   *
   * In the planner the map is about the ROUTE, so the markers become the stops
   * and nothing is decluttered — A and B must read as A and B whatever the
   * basemap is saying underneath them.
   *
   * Otherwise: the built markers, plus the pin for a tapped basemap label, with
   * the TEXT dropped from any chip sitting on a name the basemap already drew.
   * Nothing is removed — see `basemapLabels.ts` for why this is de-confliction
   * rather than suppression, and why GoWay does not suppress at all.
   */
  const markers = useMemo(() => {
    if (directions.active) return directions.markers;
    const drawn = labelMarker ? [...built.markers, labelMarker] : built.markers;
    return declutterMarkerLabels({ markers: drawn, labels: basemapLabels, zoom });
  }, [basemapLabels, built.markers, directions.active, directions.markers, labelMarker, zoom]);

  /**
   * A tap on the map, now that the map answers.
   *
   * Hit priority's last two steps live here (the first — a GoWay marker wins —
   * is enforced inside the canvas, which is the only thing that can see a
   * marker was hit). The planner keeps first claim on the gesture while it is
   * waiting for a point, because a tap that opened a place card instead of
   * setting the stop the screen just asked for would be the screen
   * contradicting itself. It now passes the label's NAME along, so "Point on
   * the map" becomes the shop's name without a reverse geocode.
   */
  const onMapPress = useCallback(
    (event: MapPressEvent) => {
      if (directions.picking != null) {
        directions.onMapPress(event.coordinate, event.label?.name);
        return;
      }
      // Bare map stays inert. A tap that selected whatever was nearest would
      // make the map unusable for its main job, which is being dragged around.
      if (!event.label) return;
      selectLabel(event.label);
    },
    [directions, selectLabel],
  );

  const onMarkerPress = useCallback(
    (marker: MapMarker) => {
      if (directions.active) {
        // A stop's pin is the same control as its field. Tapping it opens that
        // field, which is the only thing a pin in a planner can usefully mean.
        const slot = directions.stops.findIndex((stop) => stop && `goway-stop-${stop.id}` === marker.id);
        if (slot >= 0) directions.beginEdit(slot);
        return;
      }
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
    [built.clusters, cameraDuration, directions, mapRef, places, results, searching, selectPlace, selectResult],
  );

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
    bounds: committed?.bounds ?? null,
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
    selectedLabel,
    labelCategory: selectedLabel ? describeLabel(selectedLabel) : null,
    // Busy while search is still deciding whether GoWay knows this place. The
    // card is already useful during it; this only decides whether it may say
    // "GoWay has no record of this" yet.
    selectedLabelBusy: selectedLabel != null && labelSearch.isFetching,
    selectedPlace: placeQuery.data ?? null,
    selectedPlaceBusy: placeQuery.isPending && placeQuery.fetchStatus !== 'idle',
    selectedPlaceFailure: failureOf(placeQuery.error),
    selectPlace,
    selectResult,
    clearSelection,

    markers,
    ecosystem,
    onLabelsChange,
    onMarkerPress,
    onViewportChange,

    areaMoved,
    searchThisArea,

    directions,
    overlays: directions.overlays,
    onMapPress,

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

/** What fits in a marker pill. Longer than this and the pill is the map. */
const MARKER_LABEL_MAX = 18;

function truncate(value: string): string {
  return value.length > MARKER_LABEL_MAX ? `${value.slice(0, MARKER_LABEL_MAX - 1)}…` : value;
}

/** A search result's marker. A candidate with no reconciled place has no label. */
function resultMarker(result: SearchResult, selected: boolean): MapMarker {
  return {
    id: result.id,
    coordinate: result.coordinate,
    kind: result.place ? 'place' : result.kind,
    label: truncate(result.displayName),
    selected,
    accessibilityLabel: `${result.displayName}${selected ? ', selected' : ''}`,
  };
}
