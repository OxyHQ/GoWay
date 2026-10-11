/**
 * "Fly the route": a cinematic preview of a computed route.
 *
 * Mounted by `ExploreScreen` only when the flyover flag is on and the planner
 * has a route, and only through `features/flyover/lazy.ts`, so nobody with the
 * flag off downloads a byte of it. It renders the entry pill while idle and
 * the transport bar while flying; the camera itself is driven through the map
 * seam (`MapApi.moveTo` with `transient`, `MapApi.moveModel`), never through
 * an engine — which is why it flies on native too.
 *
 * The vehicle is a `MapModel` (`docs/SDK_MAP_MODELS.md` phase 1): a GLB from
 * the stubbed catalogue, drawn in 3D among the buildings on the web and as its
 * fallback marker on native, oriented along the route every frame.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import type { Route } from '@goway.to/sdk';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiFlightTakeoffLine } from '@oxy.so/bloom/icons/RiFlightTakeoffLine';

import type { MapApi, MapModel } from '@/components/map';
import { routeSteps } from '@/features/directions/maneuvers';
import { formatDistance } from '@/lib/goway/format';
import { planRouteFlyover } from '@/lib/map/camera/routeFlyover';

import { PlayerBar } from './PlayerBar';
import { useCameraPlayer } from './useCameraPlayer';

/** The vehicle's model id on the canvas. */
export const FLYOVER_VEHICLE_ID = 'goway-flyover-vehicle';

export interface RouteFlyoverProps {
  route: Route;
  mapRef: RefObject<MapApi | null>;
  /** Where the entry pill sits (below the top bar). */
  top: number;
  /** The screen hides its sheet or panel while this is `true`. */
  onActiveChange: (active: boolean) => void;
  /** The models the canvas should draw (the vehicle while flying, else none). */
  onModelsChange: (models: readonly MapModel[]) => void;
}

const NO_MODELS: readonly MapModel[] = [];

export function RouteFlyover({
  route,
  mapRef,
  top,
  onActiveChange,
  onModelsChange,
}: RouteFlyoverProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const [active, setActive] = useState(false);

  // Planned against the window the map fills while flying (the sheet and the
  // panel are hidden), and re-planned only for a new route or a resize.
  const plan = useMemo(() => {
    const coordinates = route.geometry.coordinates.map(([longitude, latitude]) => ({
      latitude,
      longitude,
    }));
    const chapterIndices = routeSteps(route).map((step) => step.range[0]);
    return planRouteFlyover({ coordinates, viewport: { width, height }, chapterIndices });
  }, [route, width, height]);

  const vehicle = useMemo<MapModel | null>(() => {
    if (!plan) return null;
    const first = plan.frameAt(0).vehicle;
    return {
      id: FLYOVER_VEHICLE_ID,
      placement: { position: first.position, orientation: { heading: first.heading } },
      asset: { kind: 'catalogue', key: 'vehicle.car' },
      // A real car is ~5 px long at the cruise zoom; keep it legible.
      sizing: { mode: 'screen', heightPx: 16 },
      // The route line's colour, so the car reads as "the thing on this route".
      tint: theme.colors.primary,
      accessibilityLabel: 'Route preview vehicle',
      fallback: { kind: 'flyover-vehicle' },
    };
  }, [plan, theme.colors.primary]);

  const onFrame = useCallback(
    (timeMs: number, info: { settled: boolean }) => {
      const map = mapRef.current;
      if (!map || !plan) return;
      const frame = plan.frameAt(timeMs);
      map.moveTo(frame.camera, { duration: 0, transient: !info.settled });
      map.moveModel(FLYOVER_VEHICLE_ID, {
        position: frame.vehicle.position,
        orientation: { heading: frame.vehicle.heading },
      });
    },
    [mapRef, plan],
  );

  const player = useCameraPlayer({
    durationMs: plan?.durationMs ?? 0,
    chapters: plan?.chapters ?? [],
    onFrame,
    reducedMotion,
  });

  // Report the mode and the vehicle to the screen.
  useEffect(() => {
    onActiveChange(active);
    onModelsChange(active && vehicle ? [vehicle] : NO_MODELS);
  }, [active, vehicle, onActiveChange, onModelsChange]);

  // Leaving the mode (or unmounting with the planner) clears both.
  const unmount = useRef({ onActiveChange, onModelsChange });
  useEffect(() => {
    unmount.current = { onActiveChange, onModelsChange };
  });
  useEffect(
    () => () => {
      unmount.current.onActiveChange(false);
      unmount.current.onModelsChange(NO_MODELS);
    },
    [],
  );

  // A new route while flying starts that route's flight from the top.
  const { seek, play, pause } = player;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new plan is the trigger
  useEffect(() => {
    if (!active) return;
    seek(0);
  }, [plan]);

  const start = useCallback(() => {
    setActive(true);
    seek(0);
    play();
  }, [play, seek]);

  const stop = useCallback(() => {
    pause();
    setActive(false);
  }, [pause]);

  if (!plan) return null;

  if (!active) {
    return (
      <View
        pointerEvents="box-none"
        className="absolute left-0 right-0 items-center"
        style={{ top }}
      >
        <Button
          size="sm"
          appearance="solid"
          tone="accent"
          leadingIcon={RiFlightTakeoffLine}
          onPress={start}
          accessibilityLabel="Fly the route in 3D"
          testID="flyover-start"
        >
          Fly the route
        </Button>
      </View>
    );
  }

  const flown = plan.frameAt(player.timeMs).distanceMeters;
  const caption = reducedMotion
    ? `Reduced motion: stepping through the turns · ${formatDistance(flown)} of ${formatDistance(plan.lengthMeters)}`
    : `${formatDistance(flown)} of ${formatDistance(plan.lengthMeters)}`;

  return (
    <PlayerBar
      player={player}
      subject="the route flyover"
      caption={caption}
      onClose={stop}
      closeLabel="Stop the flyover"
      testID="flyover-player"
    />
  );
}
