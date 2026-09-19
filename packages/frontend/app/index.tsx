/**
 * The GoWay entry route: a full-bleed map, open to everyone.
 *
 * This screen is deliberately thin. Search (#5), place details (#5), directions
 * (#6) and the persistent half-sheet (#7) are not here; what IS here is the
 * shape they plug into — a full-bleed `MapCanvas` with floating chrome composed
 * over it through Bloom's edge system, and the two privacy rules made concrete:
 *
 *  - The map renders with no account and no permission prompt. Nothing on this
 *    screen touches location until the user presses "My location".
 *  - Identity is asked for per action, through `useAuthGate()`, as the in-app
 *    Oxy dialog over the map — never a route swap that throws the map away.
 *
 * Chrome placement uses `@oxy.so/bloom/layout`: the top bar CLAIMS the top edge
 * with its MEASURED height (so anything parked there later stacks below it
 * rather than on top of it), and the controls column READS the bottom edge,
 * which is how a sheet added in #7 will push them up without either surface
 * knowing about the other.
 */
import { useCallback, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxy.so/services';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Fab } from '@oxy.so/bloom/fab';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { useBottomEdgeInset, useClaimTopEdge, windowEdgeGap } from '@oxy.so/bloom/layout';
import { RiCompass3Line } from '@oxy.so/bloom/icons/RiCompass3Line';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';

import { MapCanvas, type MapApi, type MapViewportChange } from '@/components/map';
import { useAuthGate } from '@/lib/authGate';
import { useUserLocation } from '@/lib/map/useUserLocation';
import { useTranslation } from '@/lib/i18n';

/** Zoom the camera settles at when the user asks to be found. */
const MY_LOCATION_ZOOM = 15;
/** Below this the compass is effectively north and the reset control is noise. */
const BEARING_EPSILON = 1;
/** Horizontal room the location notice leaves for the controls column. */
const CONTROLS_COLUMN_WIDTH = 72;

export default function MapScreen() {
  const { t } = useTranslation();
  const mapRef = useRef<MapApi>(null);
  const location = useUserLocation();
  const insets = useSafeAreaInsets();

  const [bearing, setBearing] = useState(0);
  // Only ever set by pressing "My location". The canvas refuses to draw the dot
  // without a granted permission anyway; not arming it until then is what keeps
  // the two rules independent of each other.
  const [followingLocation, setFollowingLocation] = useState(false);

  const bottomEdge = useBottomEdgeInset();
  const bottomGap = windowEdgeGap(insets.bottom);
  const sideGap = windowEdgeGap(insets.right, 0);
  const controlsBottom = bottomEdge > 0 ? bottomEdge + windowEdgeGap(0) : bottomGap;

  const handleViewportChange = useCallback((change: MapViewportChange) => {
    setBearing(change.viewport.bearing);
  }, []);

  const handleLocate = useCallback(async () => {
    const coordinate = await location.locate();
    if (!coordinate) return;
    setFollowingLocation(true);
    mapRef.current?.moveTo(coordinate, { zoom: MY_LOCATION_ZOOM });
  }, [location]);

  const handleResetNorth = useCallback(() => {
    mapRef.current?.resetNorth();
  }, []);

  return (
    <View className="flex-1 bg-background">
      <MapCanvas
        ref={mapRef}
        showUserLocation={followingLocation}
        onViewportChange={handleViewportChange}
        testID="goway-map"
      />

      <TopBar />

      <View
        pointerEvents="box-none"
        className="absolute items-end gap-space-12"
        style={{
          // `useBottomEdgeInset()` already folds the safe area of whatever is
          // parked at the bottom into its total. Adding `insets.bottom` on top
          // of a claim is the classic double-count that floats controls in
          // mid-air, so we add the plain gap to a claim and the full
          // safe-area-aware gap only when nothing has claimed the edge.
          bottom: controlsBottom,
          right: sideGap,
        }}
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
      </View>

      {location.error === 'denied' ? (
        <LocationNotice
          message={t('map.locationDenied')}
          bottom={controlsBottom}
          left={windowEdgeGap(insets.left, 0)}
          right={sideGap + CONTROLS_COLUMN_WIDTH}
        />
      ) : null}
    </View>
  );
}

/**
 * The floating top chrome.
 *
 * It CLAIMS the top edge rather than reading it: it is the surface parked
 * there, so a search field or filter row added in #7 reads the total and stacks
 * below instead of underneath. The claimed height is MEASURED — a constant plus
 * insets disagrees with reality the moment a translation wraps or the user
 * enlarges their font, and does so silently.
 */
function TopBar() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const gate = useAuthGate();
  const { user, openAccountDialog } = useOxy();

  const [height, setHeight] = useState(0);
  useClaimTopEdge(height);

  const topGap = windowEdgeGap(insets.top);
  const sideGap = windowEdgeGap(Math.max(insets.left, insets.right), 0);

  const handle = (user && getNormalizedUserHandle(user)) || '';
  const displayName = user?.name?.displayName?.trim() || handle;
  const accountLabel = displayName || t('map.signIn');

  /**
   * The only place this screen mentions identity.
   *
   * Signed in, it opens account management; signed out, `run()` declines to run
   * the action and opens the in-app Oxy sign-in dialog instead. Either way the
   * map stays mounted underneath — there is no route to go back from.
   */
  const handleAccount = useCallback(() => {
    gate.run(() => openAccountDialog('accounts'));
  }, [gate, openAccountDialog]);

  return (
    <View
      pointerEvents="box-none"
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      className="absolute left-0 right-0 top-0 flex-row items-center justify-between gap-space-12"
      style={{ paddingTop: topGap, paddingHorizontal: sideGap, paddingBottom: 0 }}
    >
      <View className="flex-row items-center rounded-radius-max bg-card px-space-16 py-space-8 shadow-m">
        <Text className="text-subtitle text-foreground">{t('map.title')}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accountLabel}
        onPress={handleAccount}
        className="h-11 w-11 items-center justify-center rounded-radius-max bg-card shadow-m active:opacity-80"
      >
        {user ? (
          <Avatar
            source={user.avatar ?? null}
            initials={displayName ? displayName.slice(0, 2).toUpperCase() : undefined}
            size="sm"
            alt={accountLabel}
          />
        ) : (
          <RiUserLine width={20} height={20} fill={theme.colors.text} />
        )}
      </Pressable>
    </View>
  );
}

/**
 * A declined permission is a normal outcome, not an error screen: the map stays
 * fully usable without it, so this says what happened and gets out of the way.
 */
function LocationNotice({
  message,
  bottom,
  left,
  right,
}: {
  message: string;
  bottom: number;
  left: number;
  right: number;
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityRole="alert"
      className="absolute items-start"
      style={{ bottom, left, right }}
    >
      <View className="rounded-radius-12 bg-card px-space-12 py-space-8 shadow-s">
        <Text className="text-bodySmall text-muted-foreground">{message}</Text>
      </View>
    </View>
  );
}
