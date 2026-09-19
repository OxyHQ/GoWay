/**
 * GoWay's map discovery screen: one map, three states, two layouts.
 *
 * The composition rules, all of which are load-bearing:
 *
 *  - **The map is the screen.** Browse, search and place details are states of
 *    the same mounted `MapCanvas`, never routes. Selecting a result moves the
 *    camera; it does not navigate, so there is no back stack and no moment when
 *    the map is gone.
 *  - **Chrome composes through Bloom's edge registry, not through props.** The
 *    top bar CLAIMS the top edge; the sheet CLAIMS the bottom; the controls
 *    column and the "Search this area" pill READ both. None of them imports
 *    another, so any of them can change height without the others knowing.
 *  - **`useBottomEdgeInset()` already folds in the safe area of whatever is
 *    parked there.** Adding `insets.bottom` on top of a claim is the classic
 *    double-count that floats controls in mid-air, so the plain gap is added to
 *    a claim and the safe-area-aware gap only when nothing has claimed.
 *  - **Nothing asks for location to open.** `useUserLocation()` runs only from
 *    "My location" and from the directions action.
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
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fab } from '@oxy.so/bloom/fab';
import { Text } from '@oxy.so/bloom/typography';
import { MapSearchAreaButton } from '@oxy.so/bloom/map-marker';
import { useBottomEdgeInset, useTopEdgeInset, windowEdgeGap } from '@oxy.so/bloom/layout';
import { RiCompass3Line } from '@oxy.so/bloom/icons/RiCompass3Line';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';

import { MapCanvas, type MapApi, type MapCanvasError, type MapMarker, type MapViewportChange } from '@/components/map';
import { MapSheet, type MapSheetSnap } from '@/components/sheet/MapSheet';
import { SidePanel } from '@/components/sheet/SidePanel';
import { useLayoutMode } from '@/lib/useLayoutMode';
import { useTranslation } from '@/lib/i18n';

import { ExploreBody, ExploreHeader } from './ExploreContent';
import { ExploreMarker } from './ExploreMarker';
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

export interface ExploreScreenProps {
  /** Opened from `https://goway.to/place/<placeId>`. */
  initialPlaceId?: string | null;
}

export default function ExploreScreen({ initialPlaceId = null }: ExploreScreenProps) {
  const { t } = useTranslation();
  const mapRef = useRef<MapApi>(null);
  const insets = useSafeAreaInsets();
  const layout = useLayoutMode();

  const explore = useExplore(mapRef, { initialPlaceId });
  const { location } = explore;

  const [bearing, setBearing] = useState(0);
  const [mapError, setMapError] = useState<MapCanvasError | null>(null);
  // Only ever armed by pressing "My location" or asking for directions. The
  // canvas refuses to draw the dot without a granted permission anyway; not
  // arming it until then keeps the two rules independent of each other.
  const [followingLocation, setFollowingLocation] = useState(false);

  const [snap, setSnap] = useState<MapSheetSnap>('half');
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
    if (!coordinate) return;
    setFollowingLocation(true);
    mapRef.current?.moveTo(coordinate, { zoom: MY_LOCATION_ZOOM });
  }, [location]);

  const handleResetNorth = useCallback(() => {
    mapRef.current?.resetNorth();
  }, []);

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
    <View className="flex-1 bg-background">
      <MapCanvas
        ref={mapRef}
        markers={explore.markers}
        renderMarker={renderMarker}
        onMarkerPress={explore.onMarkerPress}
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
      {explore.areaMoved && !mapError ? (
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
          out of the way. */}
      {location.error === 'denied' ? (
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
            <Text className="text-bodySmall text-muted-foreground">{t('map.locationDenied')}</Text>
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
  );
}
