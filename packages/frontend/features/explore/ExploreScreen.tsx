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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fab } from '@oxy.so/bloom/fab';
import { Text } from '@oxy.so/bloom/typography';
import { MapSearchAreaButton } from '@oxy.so/bloom/map-marker';
import { useBottomEdgeInset, useTopEdgeInset, windowEdgeGap } from '@oxy.so/bloom/layout';
import { RiCompass3Line } from '@oxy.so/bloom/icons/RiCompass3Line';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';

import { BrandedChromeProvider } from '@/components/brand';
import {
  MapCanvas,
  type MapApi,
  type MapCanvasError,
  type MapFitOptions,
  type MapMarker,
  type MapViewport,
  type MapViewportChange,
} from '@/components/map';
import { MAP_SHEET_HALF_RATIO, MapSheet, type MapSheetSnap } from '@/components/sheet/MapSheet';
import { SidePanel } from '@/components/sheet/SidePanel';
import { PANEL_WIDTH, useLayoutMode } from '@/lib/useLayoutMode';
import { useTranslation } from '@/lib/i18n';
import type { LocationErrorReason } from '@/lib/map/useUserLocation';

import { slotName } from '@/features/directions/stops';

import { ExploreBody, ExploreHeader } from './ExploreContent';
import { ExploreMarker } from './ExploreMarker';
import { clampFitPadding } from './mapPadding';
import { MapTopBar } from './MapTopBar';
import { useExplore } from './useExplore';

/** Zoom the camera settles at when the user asks to be found. */
const MY_LOCATION_ZOOM = 15;
/** Below this the compass is effectively north and the reset control is noise. */
const BEARING_EPSILON = 1;
/** Horizontal room the location notice leaves for the controls column. */
const CONTROLS_COLUMN_WIDTH = 72;
/** How far the floating controls lift as the sheet is dragged open. */
const CHROME_LIFT_PX = 28;

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
    case 'unavailable':
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
            bottom: (snap === 'peek' ? 140 : Math.round(height * MAP_SHEET_HALF_RATIO)) + FIT_GAP_PX,
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

  const [bearing, setBearing] = useState(0);
  const [mapError, setMapError] = useState<MapCanvasError | null>(null);
  // Only ever armed by pressing "My location" or asking for directions. The
  // canvas refuses to draw the dot without a granted permission anyway; not
  // arming it until then keeps the two rules independent of each other.
  const [followingLocation, setFollowingLocation] = useState(false);

  const sheetProgress = useSharedValue(0);

  const topEdge = useTopEdgeInset();
  const bottomEdge = useBottomEdgeInset();
  const bottomGap = windowEdgeGap(insets.bottom);
  const sideGap = windowEdgeGap(insets.right, 0);
  const controlsBottom = bottomEdge > 0 ? bottomEdge + windowEdgeGap(0) : bottomGap;
  const areaTop = topEdge > 0 ? topEdge + windowEdgeGap(0) : windowEdgeGap(insets.top);

  const handleViewportChange = useCallback(
    (change: MapViewportChange) => {
      setBearing(change.viewport.bearing);
      explore.onViewportChange(change);
    },
    [explore],
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
    (marker: MapMarker) => (
      <ExploreMarker
        marker={marker}
        capability={explore.ecosystem.get(marker.id)}
        onPress={() => explore.onMarkerPress(marker)}
      />
    ),
    [explore],
  );

  const locationNotice = locationNoticeFor(location.error, location.canAskAgain, t);

  /**
   * A tap on the map.
   *
   * It only ever means something while the planner is waiting for a point: a
   * tap that set a stop the user had not asked to set would make the map
   * unusable for its main job, which is being dragged around.
   */
  const handleMapPress = useCallback(
    (event: { coordinate: { latitude: number; longitude: number } }) => {
      explore.onMapPress(event.coordinate);
    },
    [explore],
  );

  /**
   * Lift and fade the floating controls with the sheet, on the UI thread.
   *
   * In panel mode `sheetProgress` is never written, so this resolves to the
   * identity transform and costs nothing.
   */
  const chromeStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -sheetProgress.value * CHROME_LIFT_PX }],
    opacity: 1 - sheetProgress.value * 0.85,
  }));

  const header = <ExploreHeader explore={explore} />;
  const body = <ExploreBody explore={explore} />;

  return (
    // `MapTopBar` below carries the GoWay logo, so the badge `MapCanvas` draws
    // on every other map stands down here: one brand per screen, and not the
    // one sitting on the cartography. Declared HERE rather than at the route,
    // because `app/place/[placeId].tsx` mounts this same screen and a third
    // route would otherwise have to remember. Never in `app/_layout.tsx` — that
    // also owns `app/frame.tsx`, which is the case the badge exists for.
    <BrandedChromeProvider>
      <View className="flex-1 bg-background">
      <MapCanvas
        ref={mapRef}
        initialViewport={initialViewport ?? undefined}
        markers={explore.markers}
        renderMarker={renderMarker}
        overlays={explore.overlays}
        onMarkerPress={explore.onMarkerPress}
        onPress={handleMapPress}
        showUserLocation={followingLocation}
        onViewportChange={handleViewportChange}
        onError={setMapError}
        testID="goway-map"
      />

      <MapTopBar />

      {/* "Search this area" is Bloom's own control, and it arms itself from the
          `source`/`isFinal` signal on the viewport event rather than from every
          camera frame — a camera the APP moved must never offer to re-run the
          search that moved it. It is hidden while the canvas is degraded: there
          is no visible area to search. */}
      {explore.areaMoved && !mapError && !directions.active ? (
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

      <Animated.View
        pointerEvents="box-none"
        style={[
          { position: 'absolute', bottom: controlsBottom, right: sideGap, alignItems: 'flex-end', gap: 12 },
          layout === 'sheet' ? chromeStyle : null,
        ]}
      >
        {Math.abs(bearing) > BEARING_EPSILON ? (
          <Fab
            variant="surface"
            size="small"
            placement="static"
            icon={<RiCompass3Line width={20} height={20} />}
            accessibilityLabel={t('map.resetNorth')}
            onPress={handleResetNorth}
          />
        ) : null}
        <Fab
          variant="surface"
          placement="static"
          icon={<RiFocus3Line width={22} height={22} />}
          accessibilityLabel={t('map.myLocation')}
          accessibilityHint={t('map.myLocationHint')}
          disabled={location.isLocating}
          onPress={() => void handleLocate()}
        />
      </Animated.View>

      {/* A declined permission is a normal outcome, not an error screen: the
          map stays fully usable without it, so this says what happened and gets
          out of the way. Every reason gets its own sentence — the control looks
          equally dead when the page is http:// or the device cannot fix, and
          neither of those is the user's doing. */}
      {locationNotice ? (
        <View
          pointerEvents="none"
          accessibilityRole="alert"
          className="absolute items-start"
          style={{
            bottom: controlsBottom,
            left: layout === 'panel' ? undefined : windowEdgeGap(insets.left, 0),
            right: sideGap + CONTROLS_COLUMN_WIDTH,
          }}
        >
          <View className="rounded-radius-12 bg-card px-space-12 py-space-8 shadow-s">
            <Text className="text-bodySmall text-muted-foreground">{locationNotice}</Text>
          </View>
        </View>
      ) : null}

      {layout === 'panel' ? (
        <SidePanel header={header} accessibilityLabel="Places" testID="explore-panel">
          {body}
        </SidePanel>
      ) : (
        <MapSheet
          snap={snap}
          onSnapChange={setSnap}
          animatedProgress={sheetProgress}
          manualActivation
          header={header}
          accessibilityLabel="Places"
          testID="explore-sheet"
        >
          {body}
        </MapSheet>
      )}
      </View>
    </BrandedChromeProvider>
  );
}
