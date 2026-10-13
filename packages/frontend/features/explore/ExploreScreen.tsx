/**
 * GoWay's map discovery screen: one map, four states, two layouts.
 *
 * The composition rules, all of which are load-bearing:
 *
 *  - **The map is the screen.** Browse, search, place details and DIRECTIONS
 *    are states of the same mounted `MapCanvas`, never routes. Selecting a
 *    result moves the camera; it does not navigate, so there is no back stack
 *    and no moment when the map is gone — and leaving the directions planner
 *    puts the user back where they were looking, not somewhere new.
 *  - **Chrome composes through Bloom's edge registry, not through props.** The
 *    top bar CLAIMS the top edge; the sheet CLAIMS the bottom; the controls
 *    column and the "Search this area" pill READ both. None of them imports
 *    another, so any of them can change height without the others knowing.
 *  - **`useBottomEdgeInset()` already folds in the safe area of whatever is
 *    parked there.** Adding `insets.bottom` on top of a claim is the classic
 *    double-count that floats controls in mid-air, so the plain gap is added to
 *    a claim and the safe-area-aware gap only when nothing has claimed.
 *  - **Nothing asks for location to open.** `useUserLocation()` runs only from
 *    "My location" and from the planner's own request for a starting point.
 *  - **The canvas is fitted around the chrome, not inside it.** `useMapPadding`
 *    below turns "the sheet covers the bottom 45%" into the asymmetric padding
 *    a route is framed with; a uniform padding frames a route behind the sheet.
 *
 * The sheet's `animatedProgress` drives the floating controls on the UI thread,
 * so they lift and fade WITH the finger rather than one to three frames behind
 * it. The map CANVAS is deliberately not translated by that same value: a
 * transformed WebGL canvas would leave `getBounds()` describing a rectangle
 * that is no longer where it is drawn (which is precisely the number "Search
 * this area" commits), and a permanent fractional translate is how a crisp
 * canvas becomes a soft one. The camera's response to a selection is a discrete
 * `moveTo` instead — spatial continuity where it is correct, lock-step motion
 * where it is free.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useWindowDimensions, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@oxy.so/bloom/button';
import { Fab } from '@oxy.so/bloom/fab';
import { Text } from '@oxy.so/bloom/typography';
import { MapSearchAreaButton } from '@oxy.so/bloom/map-marker';
import { useBottomEdgeInset, useTopEdgeInset, windowEdgeGap } from '@oxy.so/bloom/layout';
import { RiCompass3Line } from '@oxy.so/bloom/icons/RiCompass3Line';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';

import { BrandedChromeProvider } from '@/components/brand';
import { type MapChromeLift, MapChromeLiftContext } from '@/components/map/chromeLift';
import { MapCreditHeightContext } from '@/components/map/creditHeight';
import {
  MAP_CREDIT_CLEARANCE,
  MapCanvas,
  type GeoBounds,
  type MapApi,
  type MapCanvasError,
  type MapFitOptions,
  type MapLiveLayer,
  type MapMarker,
  type MapModel,
  type MapPressEvent,
  type MapViewport,
  type MapViewportChange,
} from '@/components/map';
import { MAP_SHEET_HALF_RATIO, MapSheet, type MapSheetSnap } from '@/components/sheet/MapSheet';
import { SidePanel } from '@/components/sheet/SidePanel';
import { PANEL_WIDTH, useLayoutMode } from '@/lib/useLayoutMode';
import { useAuthGate } from '@/lib/authGate';
import { chromeLift } from '@/lib/map/chromeLift';
import { creditRise } from '@/lib/map/creditRise';
import {
  INITIAL_TIME_OF_DAY,
  timeOfDayButtonShown,
  timeOfDayReducer,
} from '@/lib/map/timeOfDayControl';
import { useMapFeature } from '@/lib/map/useMapFeatures';
import { useTranslation } from '@/lib/i18n';
import type { LocationErrorReason } from '@/lib/map/useUserLocation';

import { slotName } from '@/features/directions/stops';
import { takeReturnBounds } from '@/features/street3d/handoff';
import { useStreet3dLayer } from '@/features/street3d/useStreet3dLayer';

import { ExploreBody, ExploreHeader, type RenderPlaceActions } from './ExploreContent';
import { ExploreMarker } from './ExploreMarker';
import { clampFitPadding } from './mapPadding';
import { MapSettingsButton } from './MapSettingsButton';
import { MapTopBar } from './MapTopBar';
import { focusTimeOfDayButton, TimeOfDayButton } from './TimeOfDayButton';
import { useExplore } from './useExplore';

/** Zoom the camera settles at when the user asks to be found. */
const MY_LOCATION_ZOOM = 15;

/** Below this the compass is effectively north and the reset control is noise. */
const BEARING_EPSILON = 1;
/** The settings modal's "3D": the steepest tilt the shipped map allows. */
const TILTED_PITCH = 60;
/** At or above this the camera reads as 3D in the settings modal. */
const TILTED_EPSILON = 5;
/** Horizontal room the location notice leaves for the controls column. */
const CONTROLS_COLUMN_WIDTH = 72;
/** Wait for the 3D → 2D transition before framing the scene's bounds. */
const RETURN_FIT_DELAY_MS = 250;

/**
 * Breathing room between fitted content and the edge of the FREE canvas, in px.
 *
 * It is added to whatever the sheet or the panel is already covering, rather
 * than being the whole padding: see {@link useMapPadding}.
 */
const FIT_GAP_PX = 24;

/**
 * The one-line notice beside the "My location" control.
 *
 * This control has exactly the shape the Directions bug had: `handleLocate`
 * returns early on a `null` coordinate, so before this every reason but a
 * decline was a button that visibly did nothing. `denied` keeps its translated
 * sentence; the rest are stated here, beside the control they are about.
 */
function locationNoticeFor(
  reason: LocationErrorReason | null,
  canAskAgain: boolean,
  t: (key: string) => string,
): string | null {
  switch (reason) {
    case null:
      return null;
    case 'denied':
      return canAskAgain
        ? t('map.locationDenied')
        : 'Location is blocked for GoWay. Turn it back on for goway.to in your browser or device settings.';
    case 'insecureContext':
      return "This page isn't on a secure connection, so the browser won't share location. Open GoWay at https://goway.to.";
    case 'timeout':
      return 'Finding you took too long. Tap again to try once more.';
    default:
      return "Your device couldn't get a location fix. You can still search and browse the map.";
  }
}

/**
 * How much of the canvas is NOT free, so a fitted route lands where it can be
 * seen.
 *
 * The previous fit used a uniform 72 px, which is the right number for a map
 * with nothing on top of it and the wrong one for this screen: on a phone the
 * sheet occupies the bottom 45% at rest, so a route centred in the full canvas
 * is centred behind the sheet, and the half the user can see is the half the
 * route is not in. On a wide window the same is true of the left-hand panel.
 *
 * So the padding is asymmetric and says exactly what is covered:
 *
 *  - **sheet** — the resting height of the current detent along the bottom
 *    ({@link MAP_SHEET_HALF_RATIO} is the sheet's own number, imported rather
 *    than guessed), plus the top bar's claim at the top.
 *  - **panel** — the panel's width plus its gutter on the left.
 *
 * Assumptions, since they are worth stating: `peek` is approximated by a
 * constant because the real peek height is the MEASURED header, which lives
 * inside the sheet; and `full` is treated as `half` rather than as the whole
 * screen, because a route fitted into the sliver above a fully-open sheet is
 * not a useful frame — the user who opens the sheet that far is reading the
 * turn list, and will collapse it to look at the map.
 */
function useMapPadding(layout: 'sheet' | 'panel', snap: MapSheetSnap): MapFitOptions['padding'] {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topEdge = useTopEdgeInset();

  return useMemo(() => {
    const top = Math.max(topEdge, insets.top) + FIT_GAP_PX;

    // What the chrome WANTS. `clampFitPadding` decides what is safe to hand an
    // engine — see `mapPadding.ts` for why that is not the same question, and
    // why it used to be answered with a per-side cap that could go negative on
    // a small window and claim 130% of an axis on a large one.
    const desired =
      layout === 'panel'
        ? {
            top,
            right: FIT_GAP_PX,
            bottom: FIT_GAP_PX + insets.bottom,
            left: windowEdgeGap(insets.left, 0) + PANEL_WIDTH + FIT_GAP_PX,
          }
        : {
            top,
            right: FIT_GAP_PX + windowEdgeGap(insets.right, 0),
            // `peek` shows the header only; 140 px is a generous stand-in for
            // it, and erring large keeps a route above the sheet rather than
            // under its lip.
            bottom:
              (snap === 'peek' ? 140 : Math.round(height * MAP_SHEET_HALF_RATIO)) + FIT_GAP_PX,
            left: FIT_GAP_PX + windowEdgeGap(insets.left, 0),
          };

    return clampFitPadding(desired, { width, height }, FIT_GAP_PX);
  }, [height, insets.bottom, insets.left, insets.right, insets.top, layout, snap, topEdge, width]);
}

export interface ExploreScreenProps {
  /** Opened from `https://goway.to/place/<placeId>`. */
  initialPlaceId?: string | null;
  /**
   * Camera on first render, from `https://goway.to/?lat=…&lng=…&zoom=…`.
   *
   * `null` — the normal case, and what an unreadable link resolves to — means
   * the canvas opens on its own default. The route parses it (`app/index.tsx`);
   * this screen only passes it on, because the canvas is the thing that owns
   * "initial" and nothing here should be tempted to re-apply it later.
   */
  initialViewport?: MapViewport | null;
}

/**
 * The route flyover (`docs/MAP_CAMERA_STUDIO.md`), loaded only through
 * `features/flyover/lazy.ts`: with the feature off this screen gains an
 * `import()` stub and nothing else. Whether it is on is the map-feature
 * registry's `flyover`, read live below, so turning it on in the settings modal
 * offers "Fly the route" at once.
 */
/**
 * GoWay Live (`docs/MAP_LIVE.md`): real aircraft, transit, bike share and
 * ships over the map, while the registry's `live` is on (web only). Off, its
 * chunk (the socket client, the live protocol, the panel) is never requested.
 */
const LiveHost = lazy(() => import('@/features/live/LiveHost'));

const RouteFlyover = lazy(() =>
  import('@/features/flyover/lazy').then((chunk) => ({ default: chunk.RouteFlyover })),
);
const NO_MODELS: readonly MapModel[] = [];

/**
 * The 3D landmarks' tour (`docs/MAP_LANDMARKS.md`), loaded only through
 * `features/landmarks/lazy.ts`: with the feature off this screen gains three
 * `import()` stubs and nothing else. Whether it is on is the map-feature
 * registry's `landmarks` (which needs the 3D city), read live below, so the
 * "Landmarks" pill and "Landmark tour" come and go with the Labs switch.
 */
const LandmarkOverlay = lazy(() =>
  import('@/features/landmarks/lazy').then((chunk) => ({ default: chunk.LandmarkOverlay })),
);
const LandmarkPlaceAction = lazy(() =>
  import('@/features/landmarks/lazy').then((chunk) => ({ default: chunk.LandmarkPlaceAction })),
);
const LandmarksPillEntry = lazy(() =>
  import('@/features/landmarks/lazy').then((chunk) => ({ default: chunk.LandmarksPillEntry })),
);

export default function ExploreScreen({
  initialPlaceId = null,
  initialViewport = null,
}: ExploreScreenProps) {
  const { t } = useTranslation();
  const mapRef = useRef<MapApi>(null);
  const insets = useSafeAreaInsets();
  const layout = useLayoutMode();

  const [snap, setSnap] = useState<MapSheetSnap>('half');
  // Computed BEFORE the hook that uses it: the screen is the only thing that
  // knows how much of the canvas its own chrome is standing on.
  const mapPadding = useMapPadding(layout, snap);

  const explore = useExplore(mapRef, { initialPlaceId, mapPadding });
  const { directions, location } = explore;
  const router = useRouter();
  const gate = useAuthGate();

  // Street 3D coverage: off unless the feature flag is on, and out of the way
  // while the directions planner owns the map.
  const street3d = useStreet3dLayer({ enabled: !directions.active });

  /**
   * Coming back from a Street 3D scene: frame the map on the scene the user
   * just left, so 3D → 2D lands where 2D → 3D took off.
   *
   * The fit waits for BOTH a focused screen and a ready canvas. On web the
   * map may be remounted by the navigation (or unhidden by the same
   * transition that focuses it), and a fit issued against a canvas that is
   * not ready, or is zero-sized, is silently a no-op.
   */
  // The settled view centre, for the landmarks' "Landmarks" pill.
  const [settledCentre, setSettledCentre] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);

  const pendingFit = useRef<GeoBounds | null>(null);
  const mapReady = useRef(false);
  const applyPendingFit = useCallback(() => {
    const bounds = pendingFit.current;
    if (!bounds || !mapReady.current || !mapRef.current) return;
    pendingFit.current = null;
    mapRef.current.fitBounds(bounds, { padding: mapPadding, duration: 600, maxZoom: 18 });
  }, [mapPadding]);

  useFocusEffect(
    useCallback(() => {
      const bounds = takeReturnBounds();
      if (bounds) pendingFit.current = bounds;
      if (!pendingFit.current) return undefined;
      const timer = setTimeout(applyPendingFit, RETURN_FIT_DELAY_MS);
      return () => clearTimeout(timer);
    }, [applyPendingFit]),
  );

  const handleMapReady = useCallback(() => {
    mapReady.current = true;
    setTimeout(applyPendingFit, RETURN_FIT_DELAY_MS);
  }, [applyPendingFit]);

  const overlays = useMemo(
    () =>
      street3d.overlays.length > 0 ? [...street3d.overlays, ...explore.overlays] : explore.overlays,
    [explore.overlays, street3d.overlays],
  );
  const markers = useMemo(
    () =>
      street3d.markers.length > 0 ? [...explore.markers, ...street3d.markers] : explore.markers,
    [explore.markers, street3d.markers],
  );
  const handleMarkerPress = useCallback(
    (marker: MapMarker) => {
      if (!street3d.handleMarkerPress(marker)) explore.onMarkerPress(marker);
    },
    [explore, street3d],
  );

  // Only what the chrome shows: whether the map is turned (the compass) and
  // tilted (Settings' 2D/3D). Booleans, not angles: a camera move reports at
  // 10 Hz, and storing the angle re-rendered this whole screen on every report
  // of an orbit (measured: ~11% of the main thread on a throttled laptop,
  // `docs/MAP_PERFORMANCE.md`). React skips a set to the same value.
  const [rotated, setRotated] = useState(false);
  const [tilted, setTilted] = useState(false);
  const flyover = useMapFeature('flyover');
  const landmarks = useMapFeature('landmarks');
  const live = useMapFeature('live');
  const [mapError, setMapError] = useState<MapCanvasError | null>(null);
  // While the flyover flies, the sheet, the panel and the floating controls
  // step aside; the vehicle is a model on the canvas.
  const [flying, setFlying] = useState(false);
  const [flyoverModels, setFlyoverModels] = useState<readonly MapModel[]>(NO_MODELS);
  // The landmark tour: which landmark it is on (`null`: not touring), the
  // settled view centre for the "Landmarks" pill, and who to tell when the
  // user moves the map (the tour pauses).
  const [requestedTourId, setTourId] = useState<string | null>(null);
  // Switching landmarks off in the settings modal ends a tour in progress.
  const tourId = landmarks ? requestedTourId : null;
  const userMoveListeners = useRef(new Set<() => void>());
  const subscribeUserMove = useCallback((listener: () => void) => {
    userMoveListeners.current.add(listener);
    return () => {
      userMoveListeners.current.delete(listener);
    };
  }, []);
  const renderPlaceActions = useCallback<RenderPlaceActions>(
    (place) => (
      <Suspense fallback={null}>
        <LandmarkPlaceAction place={place} onOpen={setTourId} />
      </Suspense>
    ),
    [],
  );
  // While the flyover flies or the tour tours, the map is the whole screen.
  const immersive = flying || tourId !== null;
  // The time-of-day scrubber: hidden until asked for, from the sun in the
  // top-right stack or from Settings, and only while the sky draws; closing it
  // is going back to now (`lib/map/timeOfDayControl.ts`).
  const [timeOfDay, dispatchTimeOfDay] = useReducer(timeOfDayReducer, INITIAL_TIME_OF_DAY);
  const handleSkyActiveChange = useCallback(
    (drawn: boolean) => dispatchTimeOfDay({ type: 'sky', drawn }),
    [],
  );
  const toggleTimeOfDay = useCallback(() => dispatchTimeOfDay({ type: 'toggle' }), []);
  const openTimeOfDay = useCallback(() => dispatchTimeOfDay({ type: 'open' }), []);
  const closeTimeOfDay = useCallback(() => {
    dispatchTimeOfDay({ type: 'close' });
    // Back to the control that opened it.
    focusTimeOfDayButton();
  }, []);
  // Set by `LiveHost` once it has a layer to draw; always `null` with live off.
  const [liveLayer, setLiveLayer] = useState<MapLiveLayer | null>(null);
  // Only ever armed by pressing "My location" or asking for directions. The
  // canvas refuses to draw the dot without a granted permission anyway; not
  // arming it until then keeps the two rules independent of each other.
  const [followingLocation, setFollowingLocation] = useState(false);

  const sheetProgress = useSharedValue(0);
  // The sheet's live on-screen height (`MapSheet`'s `animatedHeight`).
  const sheetHeight = useSharedValue(0);

  const topEdge = useTopEdgeInset();
  const bottomEdge = useBottomEdgeInset();
  const bottomGap = windowEdgeGap(insets.bottom);
  const sideGap = windowEdgeGap(insets.right, 0);
  // Above the map's credit, which owns the bottom-right corner (`MapAttribution`).
  const controlsBottom =
    (bottomEdge > 0 ? bottomEdge + windowEdgeGap(0) : bottomGap) + MAP_CREDIT_CLEARANCE;
  const areaTop = topEdge > 0 ? topEdge + windowEdgeGap(0) : windowEdgeGap(insets.top);

  const handleViewportChange = useCallback(
    (change: MapViewportChange) => {
      setRotated(Math.abs(change.viewport.bearing) > BEARING_EPSILON);
      setTilted(change.viewport.pitch >= TILTED_EPSILON);
      if (change.source === 'user') for (const listener of userMoveListeners.current) listener();
      if (change.isFinal) {
        setSettledCentre({
          latitude: change.viewport.latitude,
          longitude: change.viewport.longitude,
        });
      }
      explore.onViewportChange(change);
      street3d.onViewportChange(change);
    },
    [explore, street3d],
  );

  const handleLocate = useCallback(async () => {
    const coordinate = await location.locate();
    // A `null` is not nothing: `location.error` now carries which of the four
    // reasons it was, and the notice below says it out loud.
    if (!coordinate) return;
    setFollowingLocation(true);
    mapRef.current?.moveTo(coordinate, { zoom: MY_LOCATION_ZOOM });
  }, [location]);

  const handleResetNorth = useCallback(() => {
    mapRef.current?.resetNorth();
  }, []);

  /** The settings modal's 2D/3D: tilt or level the camera where it already is. */
  const handleTiltChange = useCallback((tilted: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    void map.getViewport().then((viewport) => {
      if (!viewport) return;
      map.moveTo(viewport, { pitch: tilted ? TILTED_PITCH : 0 });
    });
  }, []);

  /**
   * Get out of the way while the user is choosing a point on the map.
   *
   * The sheet is over the bottom 45% of the canvas at rest, and "tap where you
   * mean" with half the map unreachable is an instruction the screen is
   * contradicting. It collapses once, when the mode starts — the user may drag
   * it back up, and this must not fight them for it.
   */
  const picking = directions.picking;
  useEffect(() => {
    if (picking == null) return;
    setSnap('peek');
  }, [picking]);

  /**
   * Bloom's marker, plus the enriched state for a place asserting a live
   * ecosystem capability. The renderer positions it; it is the same component
   * on web and native.
   */
  const renderMarker = useCallback(
    (marker: MapMarker) =>
      street3d.renderMarker(marker) ?? (
        <ExploreMarker
          marker={marker}
          capability={explore.ecosystem.get(marker.id)}
          onPress={() => explore.onMarkerPress(marker)}
        />
      ),
    [explore, street3d],
  );

  const locationNotice = locationNoticeFor(location.error, location.canAskAgain, t);

  /**
   * A tap on the map.
   *
   * The canvas has already decided WHICH of the three things was hit — a GoWay
   * marker (in which case this does not fire at all), one of the basemap's own
   * labels, or bare map. What that means for the product is `useExplore`'s
   * call, not this component's; see `onMapPress` there.
   */
  const handleMapPress = useCallback(
    (event: MapPressEvent) => {
      explore.onMapPress(event);
    },
    [explore],
  );

  /**
   * Keep the bottom chrome — "My location" and the map's data credit — above
   * the sheet's CURRENT top edge, on the UI thread (`lib/map/chromeLift.ts`).
   * They are laid out against the sheet's resting claim on the bottom edge;
   * this lifts them the rest of the way, so at `half` the credit is visible
   * from the first frame and while dragging they ride the sheet, then fade as
   * it takes the screen. In panel mode nothing writes `sheetHeight` and there
   * is no provider, so the chrome sits where it always did.
   */
  const { height: windowHeight } = useWindowDimensions();
  const lift = useDerivedValue(
    () => chromeLift({ sheetHeight: sheetHeight.value, claimed: bottomEdge, windowHeight }),
    [sheetHeight, bottomEdge, windowHeight],
  );
  const liftPx = useDerivedValue(() => lift.value.lift, [lift]);
  const liftOpacity = useDerivedValue(() => lift.value.opacity, [lift]);
  const chromeLiftValue = useMemo<MapChromeLift>(
    () => ({ lift: liftPx, opacity: liftOpacity, rightClearance: sideGap + CONTROLS_COLUMN_WIDTH }),
    [liftPx, liftOpacity, sideGap],
  );
  // The credit's measured height (`MapAttribution`): spelled out on a phone it
  // wraps, and "My location" and its notice stand above it rather than on it
  // (`lib/map/creditRise.ts`).
  const creditHeight = useSharedValue(0);
  const sheetLayout = layout === 'sheet';
  const chromeStyle = useAnimatedStyle(() => {
    const rise = creditRise(creditHeight.value);
    return sheetLayout
      ? { transform: [{ translateY: -(liftPx.value + rise) }], opacity: liftOpacity.value }
      : { transform: [{ translateY: -rise }] };
  }, [liftPx, liftOpacity, creditHeight, sheetLayout]);

  const header = <ExploreHeader explore={explore} />;
  const body = (
    <ExploreBody
      explore={explore}
      renderPlaceActions={landmarks ? renderPlaceActions : undefined}
    />
  );

  return (
    // `MapTopBar` below carries the GoWay logo, so the badge `MapCanvas` draws
    // on every other map stands down here: one brand per screen, and not the
    // one sitting on the cartography. Declared HERE rather than at the route,
    // because `app/place/[placeId].tsx` mounts this same screen and a third
    // route would otherwise have to remember. Never in `app/_layout.tsx` — that
    // also owns `app/frame.tsx`, which is the case the badge exists for.
    <BrandedChromeProvider>
      <MapCreditHeightContext.Provider value={creditHeight}>
        <MapChromeLiftContext.Provider
          value={layout === 'sheet' && !immersive ? chromeLiftValue : null}
        >
          <View className="flex-1 bg-background">
            <MapCanvas
              ref={mapRef}
              initialViewport={initialViewport ?? undefined}
              markers={markers}
              renderMarker={renderMarker}
              overlays={overlays}
              onMarkerPress={handleMarkerPress}
              onReady={handleMapReady}
              onPress={handleMapPress}
              // What the basemap is already labelling, so GoWay does not draw a
              // second chip over it. See `lib/goway/basemapLabels.ts`.
              onLabelsChange={explore.onLabelsChange}
              showUserLocation={followingLocation}
              onViewportChange={handleViewportChange}
              onError={setMapError}
              models={flyoverModels}
              live={live ? liveLayer : null}
              timeOfDayOpen={timeOfDay.open}
              onTimeOfDayClose={closeTimeOfDay}
              onSkyActiveChange={handleSkyActiveChange}
              testID="goway-map"
            />

            <MapTopBar />

            {/* "Search this area" is Bloom's own control, and it arms itself from the
          `source`/`isFinal` signal on the viewport event rather than from every
          camera frame — a camera the APP moved must never offer to re-run the
          search that moved it. It is hidden while the canvas is degraded: there
          is no visible area to search. */}
            {explore.areaMoved && !mapError && !directions.active && !immersive ? (
              <View
                pointerEvents="box-none"
                className="absolute left-0 right-0 items-center"
                style={{ top: areaTop }}
              >
                <MapSearchAreaButton
                  variant="button"
                  label="Search this area"
                  onPress={explore.searchThisArea}
                  testID="search-this-area"
                />
              </View>
            ) : null}

            {/* Street 3D: an area in view needs more photos. A suggestion, never a
          wall — it yields to "Search this area" and to the directions picker,
          and contributing is auth-gated at the moment it is asked for. */}
            {street3d.wantingCapture.length > 0 &&
            !explore.areaMoved &&
            !mapError &&
            !directions.active &&
            !immersive ? (
              <View
                pointerEvents="box-none"
                className="absolute left-0 right-0 items-center px-space-16"
                style={{ top: areaTop }}
              >
                <View className="flex-row items-center gap-space-8 rounded-radius-max bg-card py-space-4 pl-space-12 pr-space-4 shadow-m">
                  <Text className="text-bodySmall text-foreground" numberOfLines={2}>
                    {t('street3d.layer.contributeHint')}
                  </Text>
                  <Button size="xs" onPress={() => gate.run(() => router.push('/contribute'))}>
                    {t('street3d.contribute.cta')}
                  </Button>
                </View>
              </View>
            ) : null}

            {/* Choosing a stop on the map is a MODE, and a mode with no visible state
          is a map that mysteriously starts answering taps differently. The
          notice is an `alert` so it is announced, and it names the field it is
          about. */}
            {directions.picking != null && !mapError ? (
              <View
                pointerEvents="none"
                accessibilityRole="alert"
                className="absolute left-0 right-0 items-center px-space-16"
                style={{ top: areaTop }}
              >
                <View className="rounded-radius-max bg-card px-space-16 py-space-8 shadow-m">
                  <Text className="text-bodySmall text-foreground">
                    {`Tap the map to set the ${slotName(directions.picking, directions.stops.length).toLowerCase()}`}
                  </Text>
                </View>
              </View>
            ) : null}

            {landmarks && tourId && !mapError ? (
              <Suspense fallback={null}>
                <LandmarkOverlay
                  mapRef={mapRef}
                  top={areaTop}
                  startId={tourId}
                  onClose={() => setTourId(null)}
                  subscribeUserMove={subscribeUserMove}
                />
              </Suspense>
            ) : null}

            {/* The top-right stack, under the account button: ONE column of
              round controls, so its items never overlap — the settings button
              (where Apple Maps parks its map options, a corner no sheet or
              panel covers in either layout), the time of day while the sky
              draws, the landmarks while one is near (an icon on a phone,
              labelled on a wide window), and GoWay Live's panel. 40 px on a
              phone, as the compass is, so this stack and the bottom-right
              column stay clear of each other at 360×740 even with the credit
              spelled out. The simulation's label is not here: it rides in the
              data credit, bottom right (`MapAttribution`). */}
            <View
              pointerEvents="box-none"
              className="absolute items-end gap-space-8"
              style={{ top: areaTop, right: sideGap }}
              testID="map-top-right-stack"
            >
              {immersive ? null : (
                <MapSettingsButton
                  compact={layout === 'sheet'}
                  tilted={tilted}
                  onTiltChange={handleTiltChange}
                  onChangeTime={
                    timeOfDayButtonShown(timeOfDay) && !mapError ? openTimeOfDay : undefined
                  }
                />
              )}
              {timeOfDayButtonShown(timeOfDay) && !mapError && !immersive ? (
                <TimeOfDayButton
                  open={timeOfDay.open}
                  onToggle={toggleTimeOfDay}
                  compact={layout === 'sheet'}
                />
              ) : null}
              {landmarks && !mapError && !immersive && !directions.active ? (
                <Suspense fallback={null}>
                  <LandmarksPillEntry
                    centre={settledCentre}
                    onOpen={setTourId}
                    compact={layout === 'sheet'}
                  />
                </Suspense>
              ) : null}
              {live && !mapError ? (
                <Suspense fallback={null}>
                  <LiveHost onLayer={setLiveLayer} />
                </Suspense>
              ) : null}
            </View>

            {flyover && directions.active && directions.route && !mapError ? (
              <Suspense fallback={null}>
                <RouteFlyover
                  route={directions.route}
                  mapRef={mapRef}
                  top={areaTop}
                  onActiveChange={setFlying}
                  onModelsChange={setFlyoverModels}
                />
              </Suspense>
            ) : null}

            {immersive ? null : (
              <Animated.View
                pointerEvents="box-none"
                style={[
                  {
                    position: 'absolute',
                    bottom: controlsBottom,
                    right: sideGap,
                    alignItems: 'flex-end',
                    gap: 12,
                  },
                  chromeStyle,
                ]}
              >
                {rotated ? (
                  <Fab
                    size="xs"
                    icon={RiCompass3Line}
                    iconSize={20}
                    accessibilityLabel={t('map.resetNorth')}
                    onPress={handleResetNorth}
                    appearance="subtle"
                    tone="neutral"
                  />
                ) : null}
                <Fab
                  icon={RiFocus3Line}
                  iconSize={22}
                  accessibilityLabel={t('map.myLocation')}
                  accessibilityHint={t('map.myLocationHint')}
                  disabled={location.isLocating}
                  onPress={() => void handleLocate()}
                  appearance="subtle"
                  tone="neutral"
                />
              </Animated.View>
            )}

            {/* A declined permission is a normal outcome, not an error screen: the
          map stays fully usable without it, so this says what happened and gets
          out of the way. Every reason gets its own sentence — the control looks
          equally dead when the page is http:// or the device cannot fix, and
          neither of those is the user's doing. */}
            {locationNotice && !immersive ? (
              <Animated.View
                pointerEvents="none"
                accessibilityRole="alert"
                className="absolute items-start"
                style={[
                  {
                    bottom: controlsBottom,
                    left: layout === 'panel' ? undefined : windowEdgeGap(insets.left, 0),
                    right: sideGap + CONTROLS_COLUMN_WIDTH,
                  },
                  // Beside "My location", so it rides the sheet (and the credit) with it.
                  chromeStyle,
                ]}
              >
                <View className="rounded-radius-12 bg-card px-space-12 py-space-8 shadow-s">
                  <Text className="text-bodySmall text-muted-foreground">{locationNotice}</Text>
                </View>
              </Animated.View>
            ) : null}

            {immersive ? null : layout === 'panel' ? (
              <SidePanel header={header} accessibilityLabel="Places" testID="explore-panel">
                {body}
              </SidePanel>
            ) : (
              <MapSheet
                snap={snap}
                onSnapChange={setSnap}
                animatedProgress={sheetProgress}
                animatedHeight={sheetHeight}
                manualActivation
                header={header}
                accessibilityLabel="Places"
                testID="explore-sheet"
              >
                {body}
              </MapSheet>
            )}
          </View>
        </MapChromeLiftContext.Provider>
      </MapCreditHeightContext.Provider>
    </BrandedChromeProvider>
  );
}
