/**
 * The landmark tour (`docs/MAP_LANDMARKS.md` → Tour): the map goes full
 * screen and the camera orbits one landmark at a time, with its name and
 * category as a caption and ◀ ▶ / play to move between the city's landmarks.
 *
 * Mounted by `ExploreScreen` only through `features/landmarks/lazy.ts`, only
 * when the landmarks flag is on. The camera is driven through the map seam
 * (`MapApi.moveTo` with `transient` for each animation frame, one plain
 * `moveTo` to settle), never through an engine — feature code imports
 * neither three.js nor MapLibre.
 *
 * ## Motion
 *
 *  - Playing: the camera orbits the landmark once (`tour.orbitSeconds`), then
 *    flies on to the next. Paused: it rests where it is.
 *  - ◀ ▶: a flight to the previous/next landmark (`transitionViewport`: a
 *    lift in the middle for a long hop), then the orbit resumes if playing.
 *  - A drag, pinch or rotate by the user pauses the tour: the map is theirs.
 *  - Reduced motion: no orbit and no flight. Each landmark is a still, cut
 *    to; play steps through them every {@link STILL_MS}.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@oxy.so/bloom/button';
import { useClaimBottomEdge, windowEdgeGap } from '@oxy.so/bloom/layout';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiArrowLeftSLine } from '@oxy.so/bloom/icons/RiArrowLeftSLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiPauseFill } from '@oxy.so/bloom/icons/RiPauseFill';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';

import type { MapApi, MapViewport } from '@/components/map';
import { resolveCategory } from '@/lib/goway/categories';
import { useCategoryTaxonomy } from '@/lib/goway/queries';
import type { PreparedLandmark } from '@/lib/map/landmarks/load';
import {
  DEFAULT_FIELD_OF_VIEW,
  orbitAngle,
  orbitViewport,
  stepIndex,
  type TourStop,
  TOUR_FIELD_OF_VIEW,
  tourOrder,
  transitionMs,
  transitionViewport,
} from '@/lib/map/landmarks/tour';

/** Under reduced motion, how long each landmark rests before play moves on. */
export const STILL_MS = 6_000;

export interface LandmarkTourProps {
  landmarks: readonly PreparedLandmark[];
  /** The landmark the tour opens on. */
  startId: string;
  mapRef: RefObject<MapApi | null>;
  /** Where the back button sits (below the top bar). */
  top: number;
  onClose: () => void;
  /**
   * Register the screen's "the user moved the map" signal; the tour pauses on
   * it. Returns the unregister function.
   */
  subscribeUserMove: (listener: () => void) => () => void;
}

interface Stop extends TourStop {
  landmark: PreparedLandmark;
}

function toStop(landmark: PreparedLandmark): Stop {
  return {
    id: landmark.entry.id,
    position: landmark.placement.position,
    heading: landmark.placement.orientation.heading,
    tour: landmark.entry.tour,
    landmark,
  };
}

export function LandmarkTour({
  landmarks,
  startId,
  mapRef,
  top,
  onClose,
  subscribeUserMove,
}: LandmarkTourProps) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const taxonomy = useCategoryTaxonomy();
  const stops = useMemo(() => tourOrder(landmarks.map(toStop), startId), [landmarks, startId]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(!reducedMotion);
  const stop = stops[index] ?? null;

  // The camera loop's state, outside React: it changes every frame.
  const camera = useRef<{
    raf: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** Orbit angle reached, so pause/play resumes where it stopped. */
    angle: number;
    last: MapViewport | null;
  }>({ raf: 0, timer: null, angle: 0, last: null });

  const halt = useCallback(() => {
    cancelAnimationFrame(camera.current.raf);
    if (camera.current.timer) clearTimeout(camera.current.timer);
    camera.current.timer = null;
  }, []);

  const move = useCallback(
    (viewport: MapViewport, transient: boolean) => {
      camera.current.last = viewport;
      // Development only: where the tour is, for a headless check.
      if (__DEV__) (globalThis as { __gowayLandmarkTour?: unknown }).__gowayLandmarkTour = viewport;
      mapRef.current?.moveTo(viewport, {
        zoom: viewport.zoom,
        pitch: viewport.pitch,
        bearing: viewport.bearing,
        duration: 0,
        transient,
        fieldOfView: TOUR_FIELD_OF_VIEW,
      });
    },
    [mapRef],
  );

  // Whether the tour plays, read live by the arrival below: toggling play
  // must not restart a flight (the effect after it handles the toggle).
  const playingRef = useRef(playing);

  // Arrive at the current stop (fly, or cut under reduced motion), then orbit
  // while playing; when an orbit completes, play moves on.
  useEffect(() => {
    if (!stop) return undefined;
    halt();
    camera.current.angle = 0;
    const target = orbitViewport(stop, 0);
    const from = camera.current.last;
    if (reducedMotion || !from) move(target, false);
    if (reducedMotion) {
      // A still: play moves on after a rest instead of an orbit.
      if (playingRef.current && stops.length > 1) {
        camera.current.timer = setTimeout(
          () => setIndex((i) => stepIndex(i, stops.length, 1)),
          STILL_MS,
        );
      }
      return halt;
    }
    const duration = from && !reducedMotion ? transitionMs(from, target) : 0;
    const started = performance.now();
    const frame = (now: number) => {
      const t = duration > 0 ? (now - started) / duration : 1;
      if (t < 1 && from) {
        move(transitionViewport(from, target, t), true);
        camera.current.raf = requestAnimationFrame(frame);
        return;
      }
      if (!playingRef.current) {
        move(orbitViewport(stop, camera.current.angle), false);
        return;
      }
      const orbitStart = started + duration;
      const angle = orbitAngle(stop, now - orbitStart);
      camera.current.angle = angle;
      if (angle >= 360 && stops.length > 1) {
        setIndex((i) => stepIndex(i, stops.length, 1));
        return;
      }
      move(orbitViewport(stop, angle % 360), true);
      camera.current.raf = requestAnimationFrame(frame);
    };
    camera.current.raf = requestAnimationFrame(frame);
    return halt;
  }, [stop, reducedMotion, halt, move, stops.length]);

  // Play/pause without re-flying: resume or stop the orbit where it is.
  useEffect(() => {
    if (playingRef.current === playing) return;
    playingRef.current = playing;
    if (!stop) return;
    halt();
    if (!playing) {
      const last = camera.current.last;
      if (last) move(last, false);
      return;
    }
    if (reducedMotion) {
      camera.current.timer = setTimeout(
        () => setIndex((i) => stepIndex(i, stops.length, 1)),
        STILL_MS,
      );
      return;
    }
    const base = camera.current.angle;
    const started = performance.now();
    const frame = (now: number) => {
      const angle = base + orbitAngle(stop, now - started);
      camera.current.angle = angle;
      if (angle >= 360 && stops.length > 1) {
        setIndex((i) => stepIndex(i, stops.length, 1));
        return;
      }
      move(orbitViewport(stop, angle % 360), true);
      camera.current.raf = requestAnimationFrame(frame);
    };
    camera.current.raf = requestAnimationFrame(frame);
  }, [playing, stop, reducedMotion, halt, move, stops.length]);

  // The user takes the map: pause.
  useEffect(() => subscribeUserMove(() => setPlaying(false)), [subscribeUserMove]);
  useEffect(() => halt, [halt]);

  const close = useCallback(() => {
    halt();
    const last = camera.current.last;
    // Settle where the tour left the camera, with the map's own lens back.
    if (last) {
      mapRef.current?.moveTo(last, {
        zoom: last.zoom,
        pitch: last.pitch,
        bearing: last.bearing,
        duration: 0,
        fieldOfView: DEFAULT_FIELD_OF_VIEW,
      });
    }
    onClose();
  }, [halt, mapRef, onClose]);

  const [height, setHeight] = useState(0);
  const bottom = windowEdgeGap(insets.bottom);
  useClaimBottomEdge(height > 0 ? height + bottom : 0);

  if (!stop) return null;
  // The category's label is the taxonomy's (`GET /categories`); until it
  // resolves — or for a key it does not hold — the caption is the locality alone.
  const resolved = resolveCategory([stop.landmark.entry.category], taxonomy);
  const caption =
    resolved.key === stop.landmark.entry.category
      ? `${resolved.label} · ${stop.landmark.entry.locality}`
      : stop.landmark.entry.locality;

  return (
    <View pointerEvents="box-none" className="absolute inset-0" testID="landmark-tour">
      <View pointerEvents="box-none" className="absolute left-space-16" style={{ top }}>
        <Button
          iconOnly
          leadingIcon={RiArrowLeftLine}
          size="sm"
          appearance="subtle"
          tone="neutral"
          onPress={close}
          accessibilityLabel="Close the landmark tour"
          testID="landmark-tour-close"
        />
      </View>
      <View
        pointerEvents="box-none"
        className="absolute left-0 right-0 items-center px-space-16"
        style={{ bottom }}
      >
        <View
          onLayout={(event) => setHeight(Math.round(event.nativeEvent.layout.height))}
          className="items-center gap-space-4 rounded-radius-16 bg-background/70 px-space-24 py-space-12"
          accessibilityLiveRegion="polite"
        >
          <Text
            className="text-center text-foreground"
            style={{ fontSize: 30, lineHeight: 36, fontWeight: '300' }}
            accessibilityRole="header"
            testID="landmark-tour-name"
          >
            {stop.landmark.entry.name}
          </Text>
          <Text className="text-caption text-muted-foreground">{caption}</Text>
          <View className="mt-space-8 flex-row items-center gap-space-8">
            <Button
              iconOnly
              leadingIcon={RiArrowLeftSLine}
              size="sm"
              appearance="subtle"
              tone="neutral"
              disabled={stops.length < 2}
              onPress={() => setIndex((i) => stepIndex(i, stops.length, -1))}
              accessibilityLabel="Previous landmark"
              testID="landmark-tour-previous"
            />
            <Button
              iconOnly
              leadingIcon={playing ? RiPauseFill : RiPlayFill}
              size="sm"
              appearance="subtle"
              tone="neutral"
              onPress={() => setPlaying((p) => !p)}
              accessibilityLabel={playing ? 'Pause the tour' : 'Play the tour'}
              testID="landmark-tour-play"
            />
            <Button
              iconOnly
              leadingIcon={RiArrowRightSLine}
              size="sm"
              appearance="subtle"
              tone="neutral"
              disabled={stops.length < 2}
              onPress={() => setIndex((i) => stepIndex(i, stops.length, 1))}
              accessibilityLabel="Next landmark"
              testID="landmark-tour-next"
            />
          </View>
        </View>
      </View>
    </View>
  );
}
