/**
 * Camera Studio: author a camera tour over the map, preview it, share it as a
 * link, and (web) export it as a video. Inspired by World Labs' Atlas Camera
 * Studio — draw a path, smooth it, interpolate cameras, preview, undo/redo,
 * export — on GoWay's map instead of a splat.
 *
 * Reached at `/studio` (`app/studio.tsx`) only with the flyover flag on, and
 * only through `features/flyover/lazy.ts`. Everything that moves the camera
 * goes through the map seam (`MapApi`), so authoring and playback work on
 * native as well; drawing uses the top-down projection and video export is
 * web-only.
 *
 * ## Tools
 *
 *  - **Navigate** — move the map; "Add this view" captures the camera exactly
 *    as framed (centre, zoom, pitch, bearing) as a keyframe.
 *  - **Draw** — the camera levels to top-down and a drag draws the path; the
 *    stroke is simplified into keyframes that fly it, facing along it.
 *  - **Drop** — each tap on the map is a keyframe at the current zoom and
 *    pitch.
 *
 * A selected keyframe can be re-aimed (follow the path, a fixed bearing, or
 * look at a point picked on the map), re-zoomed, tilted, given a hold, moved
 * to the map's centre, or deleted. Every edit is one undo step; a slider drag
 * is one step however far it went (`lib/map/camera/history.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, Share, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, GlyphButton } from '@oxy.so/bloom/button';
import { useClaimBottomEdge, useClaimTopEdge, windowEdgeGap } from '@oxy.so/bloom/layout';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Slider } from '@oxy.so/bloom/slider';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { RiArrowGoBackLine } from '@oxy.so/bloom/icons/RiArrowGoBackLine';
import { RiArrowGoForwardLine } from '@oxy.so/bloom/icons/RiArrowGoForwardLine';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiCameraLine } from '@oxy.so/bloom/icons/RiCameraLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiFilmLine } from '@oxy.so/bloom/icons/RiFilmLine';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { RiShareLine } from '@oxy.so/bloom/icons/RiShareLine';

import {
  MapCanvas,
  type MapApi,
  type MapMarker,
  type MapOverlay,
  type MapPressEvent,
  type MapViewport,
  type MapCameraChange,
  type ResolvedMapViewport,
} from '@/components/map';
import { unprojectTopDown } from '@/lib/map/camera/plane';
import { type TourAim, MAX_TOUR_KEYFRAMES } from '@/lib/map/camera/tour';
import { parseTourFromParams, studioTabPath, tourLink } from '@/lib/map/tourLink';
import { parseViewportFromParams } from '@/lib/map/viewportLink';

import { PlayerBar } from '../PlayerBar';
import { useCameraPlayer } from '../useCameraPlayer';
import { DrawSurface } from './DrawSurface';
import { canExportVideo, downloadBlob, exportVideo } from './exportVideo';
import { useTourEditor } from './useTourEditor';

type Tool = 'navigate' | 'draw' | 'drop';

const AIM_LABELS: Record<TourAim, string> = {
  path: 'Follow path',
  fixed: 'Fixed',
  lookAt: 'Look at',
};

/** Width at which the tools become a side panel. */
const WIDE = 900;
const PANEL_WIDTH = 340;

export function StudioScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;

  // Read ONCE: the link is where the Studio starts, not a live binding.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial by design
  const initialTour = useMemo(() => parseTourFromParams(params), []);
  const editor = useTourEditor(initialTour);
  const { tour, compiled, selectedId } = editor;
  const selected = tour.keyframes.find((k) => k.id === selectedId) ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: initial by design
  const initialViewport = useMemo<MapViewport | undefined>(() => {
    const first = initialTour?.keyframes[0];
    if (first) {
      return {
        latitude: first.center.latitude,
        longitude: first.center.longitude,
        zoom: first.zoom,
        pitch: first.pitch,
        bearing: first.bearing,
      };
    }
    return parseViewportFromParams(params) ?? undefined;
  }, []);

  const mapRef = useRef<MapApi>(null);
  const viewport = useRef<ResolvedMapViewport | null>(null);
  const [tool, setTool] = useState<Tool>('navigate');
  const [pickingLookAt, setPickingLookAt] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // --- Playback -------------------------------------------------------------

  const ended = useRef<(() => void) | null>(null);
  const onFrame = useCallback(
    (timeMs: number, info: { settled: boolean }) => {
      if (!compiled) return;
      mapRef.current?.moveTo(compiled.cameraAt(timeMs), { duration: 0, transient: !info.settled });
    },
    [compiled],
  );
  const player = useCameraPlayer({
    durationMs: compiled?.durationMs ?? 0,
    chapters: compiled ? [...compiled.keyframeTimes, compiled.durationMs] : [],
    onFrame,
    reducedMotion,
    onEnd: () => {
      ended.current?.();
      ended.current = null;
    },
  });
  const { play, pause, seek } = player;

  const startPreview = useCallback(() => {
    if (!compiled) return;
    setTool('navigate');
    setPreviewing(true);
    seek(0);
    play();
  }, [compiled, play, seek]);

  const stopPreview = useCallback(() => {
    pause();
    setPreviewing(false);
  }, [pause]);

  // The running export's cancel switch. Closing the player while recording
  // routes here instead of a bare pause: a paused playback never reaches the
  // end the recording waits for (PR #123 review).
  const exportAbort = useRef<AbortController | null>(null);
  const cancelExport = useCallback(() => {
    exportAbort.current?.abort();
    pause();
  }, [pause]);
  // Leaving the Studio mid-recording cancels it too.
  useEffect(() => () => exportAbort.current?.abort(), []);

  const exportClip = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !compiled) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setExporting(true);
    setPreviewing(true);
    setNotice('Recording… the video plays in real time.');
    try {
      const blob = await exportVideo({
        map,
        signal: controller.signal,
        colours: { plate: theme.colors.background, text: theme.colors.textSecondary },
        play: () =>
          new Promise<void>((resolve) => {
            ended.current = resolve;
            seek(0);
            play();
          }),
      });
      downloadBlob(blob, 'goway-tour.webm');
      setNotice(`Saved goway-tour.webm (${Math.round(blob.size / 1024)} KB).`);
      if (__DEV__)
        (globalThis as { __gowayTourExport?: unknown }).__gowayTourExport = {
          size: blob.size,
          type: blob.type,
        };
    } catch (cause) {
      setNotice(
        (cause as { name?: string } | null)?.name === 'AbortError'
          ? 'Recording cancelled.'
          : `Could not record the video: ${String(cause)}`,
      );
    } finally {
      ended.current = null;
      if (exportAbort.current === controller) exportAbort.current = null;
      setExporting(false);
      setPreviewing(false);
    }
  }, [compiled, play, seek, theme.colors.background, theme.colors.textSecondary]);

  // --- Editing --------------------------------------------------------------

  // The camera NOW, asked of the map: the canvas reports a viewport only once
  // something moves it, so a Studio opened on a link and never panned has
  // heard nothing yet.
  const currentViewport = useCallback(
    async () => (await mapRef.current?.getViewport()) ?? viewport.current,
    [],
  );

  const addCurrentView = useCallback(async () => {
    const vp = await currentViewport();
    if (!vp) return;
    editor.addKeyframe({
      center: { latitude: vp.latitude, longitude: vp.longitude },
      zoom: vp.zoom,
      pitch: vp.pitch,
      bearing: vp.bearing,
      aim: 'fixed',
      holdMs: 0,
    });
  }, [currentViewport, editor]);

  const chooseTool = useCallback(
    async (next: Tool) => {
      setTool(next);
      setPickingLookAt(false);
      if (next === 'draw') {
        // Drawing goes through the top-down projection: level the camera first.
        const vp = await currentViewport();
        if (vp) mapRef.current?.moveTo(vp, { pitch: 0, duration: 0 });
      }
    },
    [currentViewport],
  );

  const handleStroke = useCallback(
    async (
      points: readonly { x: number; y: number }[],
      size: { width: number; height: number },
    ) => {
      const vp = await currentViewport();
      if (!vp) return;
      const geo = points.map((p) => unprojectTopDown(vp, size, p));
      editor.addStroke(geo, vp);
    },
    [currentViewport, editor],
  );

  const handlePress = useCallback(
    async (event: MapPressEvent) => {
      const vp = await currentViewport();
      if (pickingLookAt && selected) {
        editor.updateKeyframe(selected.id, { aim: 'lookAt', lookAt: event.coordinate });
        setPickingLookAt(false);
        return;
      }
      if (tool === 'drop' && vp) {
        editor.addKeyframe({
          center: event.coordinate,
          zoom: vp.zoom,
          pitch: vp.pitch > 0 ? vp.pitch : 50,
          bearing: vp.bearing,
          aim: 'path',
          holdMs: 0,
        });
      }
    },
    [currentViewport, editor, pickingLookAt, selected, tool],
  );

  const handleMarkerPress = useCallback(
    (marker: MapMarker) => {
      const keyframe = tour.keyframes.find((k) => k.id === marker.id);
      if (!keyframe) return;
      editor.select(keyframe.id);
      mapRef.current?.moveTo(
        {
          ...keyframe.center,
          zoom: keyframe.zoom,
          pitch: keyframe.pitch,
          bearing: keyframe.bearing,
        },
        { duration: reducedMotion ? 0 : 400 },
      );
    },
    [editor, reducedMotion, tour.keyframes],
  );

  const share = useCallback(async () => {
    if (!compiled) return;
    const url = tourLink(tour);
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(url);
        setNotice('Link copied.');
      } catch {
        setNotice(url);
      }
      // Keep the address bar in step, so a reload reopens this tour.
      // The tab keeps its development switches (`?flyover=1`); the shared
      // link does not carry them.
      window.history.replaceState(null, '', studioTabPath(url, window.location.search));
    } else {
      await Share.share({ message: url, url });
    }
  }, [compiled, tour]);

  // Undo/redo from the keyboard on the web: ⌘/Ctrl-Z, ⇧⌘/Ctrl-Z, Ctrl-Y.
  const { undo, redo } = editor;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea)$/i.test(target.tagName)))
        return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // --- What the map draws -----------------------------------------------------

  const accent = theme.colors.primary;
  const overlays = useMemo<readonly MapOverlay[]>(() => {
    if (previewing || !compiled) return [];
    const lookLines = tour.keyframes
      .filter((k) => k.aim === 'lookAt' && k.lookAt)
      .map((k) => [
        [k.center.longitude, k.center.latitude],
        [k.lookAt?.longitude ?? 0, k.lookAt?.latitude ?? 0],
      ]);
    const out: MapOverlay[] = [
      {
        id: 'studio-path',
        kind: 'line',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: compiled.path.map((c) => [c.longitude, c.latitude]),
          },
        },
        paint: { color: accent, width: 4, opacity: 0.9 },
      },
    ];
    if (lookLines.length > 0) {
      out.push({
        id: 'studio-look',
        kind: 'line',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiLineString', coordinates: lookLines },
        },
        paint: { color: accent, width: 1.5, opacity: 0.5 },
      });
    }
    return out;
  }, [accent, compiled, previewing, tour.keyframes]);

  const markers = useMemo<readonly MapMarker[]>(() => {
    if (previewing) return [];
    const out: MapMarker[] = tour.keyframes.map((k, index) => ({
      id: k.id,
      coordinate: k.center,
      kind: 'studio-keyframe',
      label: String(index + 1),
      selected: k.id === selectedId,
      accessibilityLabel: `Keyframe ${index + 1}`,
    }));
    for (const [index, k] of tour.keyframes.entries()) {
      if (k.aim === 'lookAt' && k.lookAt) {
        out.push({
          id: `${k.id}:target`,
          coordinate: k.lookAt,
          kind: 'studio-target',
          label: `◎ ${index + 1}`,
          accessibilityLabel: `What keyframe ${index + 1} looks at`,
        });
      }
    }
    return out;
  }, [previewing, selectedId, tour.keyframes]);

  const handleViewportChange = useCallback((change: MapCameraChange) => {
    viewport.current = change.viewport;
  }, []);

  // --- Layout -----------------------------------------------------------------

  const [topHeight, setTopHeight] = useState(0);
  useClaimTopEdge(topHeight);
  const [panelHeight, setPanelHeight] = useState(0);
  const bottomGap = windowEdgeGap(insets.bottom);
  // On a phone the panel parks at the bottom: claim it, so the map's mark and
  // credit rise above it instead of under it.
  useClaimBottomEdge(!wide && !previewing && panelHeight > 0 ? panelHeight + bottomGap : 0);

  const keyframeCount = tour.keyframes.length;
  const duration = compiled ? `${(compiled.durationMs / 1000).toFixed(1)} s` : '—';

  const panel = (
    <ScrollView
      contentContainerClassName="gap-space-12 p-space-12"
      keyboardShouldPersistTaps="handled"
    >
      <SegmentedControl
        type="tabs"
        size="sm"
        value={tool}
        onValueChange={(v) => void chooseTool(v as Tool)}
        testID="studio-tools"
      >
        <SegmentedControlItem value="navigate" accessibilityLabel="Navigate the map">
          <SegmentedControlItemText>Navigate</SegmentedControlItemText>
        </SegmentedControlItem>
        <SegmentedControlItem value="draw" accessibilityLabel="Draw a camera path">
          <SegmentedControlItemText>Draw path</SegmentedControlItemText>
        </SegmentedControlItem>
        <SegmentedControlItem value="drop" accessibilityLabel="Tap the map to drop keyframes">
          <SegmentedControlItemText>Drop</SegmentedControlItemText>
        </SegmentedControlItem>
      </SegmentedControl>

      <Text className="text-bodySmall text-muted-foreground">
        {tool === 'draw'
          ? 'Drag on the map to draw the path the camera flies. Each stroke adds to the tour.'
          : tool === 'drop'
            ? 'Tap the map to add a keyframe there, at the current zoom and tilt.'
            : 'Frame a shot, then add it as a keyframe. Tap a numbered pin to select it.'}
      </Text>

      <View className="flex-row flex-wrap items-center gap-space-8">
        <Button
          size="sm"
          appearance="outline"
          tone="neutral"
          leadingIcon={RiCameraLine}
          onPress={() => void addCurrentView()}
          disabled={keyframeCount >= MAX_TOUR_KEYFRAMES}
          testID="studio-add-view"
        >
          Add this view
        </Button>
        <GlyphButton
          icon={RiArrowGoBackLine}
          size={36}
          onPress={editor.undo}
          disabled={!editor.canUndo}
          accessibilityLabel="Undo"
          testID="studio-undo"
        />
        <GlyphButton
          icon={RiArrowGoForwardLine}
          size={36}
          onPress={editor.redo}
          disabled={!editor.canRedo}
          accessibilityLabel="Redo"
          testID="studio-redo"
        />
        <GlyphButton
          icon={RiDeleteBinLine}
          size={36}
          onPress={editor.clear}
          disabled={keyframeCount === 0}
          accessibilityLabel="Clear all keyframes"
        />
      </View>

      <Text className="text-caption text-muted-foreground" testID="studio-summary">
        {`${keyframeCount} keyframe${keyframeCount === 1 ? '' : 's'} · ${duration}`}
      </Text>

      {selected ? (
        <View
          className="gap-space-8 rounded-radius-12 bg-background-secondary p-space-12"
          testID="studio-keyframe-editor"
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-body font-semibold text-foreground">
              {`Keyframe ${tour.keyframes.indexOf(selected) + 1}`}
            </Text>
            <GlyphButton
              icon={RiDeleteBinLine}
              size={32}
              onPress={() => editor.removeKeyframe(selected.id)}
              accessibilityLabel="Delete this keyframe"
            />
          </View>
          <SegmentedControl
            type="radio"
            size="sm"
            label="Aim"
            value={selected.aim}
            onValueChange={(value) => {
              const aim = value as TourAim;
              if (aim === 'lookAt') {
                if (selected.lookAt) editor.updateKeyframe(selected.id, { aim });
                else setPickingLookAt(true);
                return;
              }
              editor.updateKeyframe(selected.id, { aim });
            }}
          >
            {(Object.keys(AIM_LABELS) as TourAim[]).map((aim) => (
              <SegmentedControlItem key={aim} value={aim}>
                <SegmentedControlItemText>{AIM_LABELS[aim]}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {selected.aim === 'lookAt' || pickingLookAt ? (
            <Button
              size="xs"
              appearance="plain"
              tone="accent"
              onPress={() => setPickingLookAt(true)}
            >
              {pickingLookAt
                ? 'Tap the map: what should it look at?'
                : 'Pick another point to look at'}
            </Button>
          ) : null}
          <Slider
            label="Zoom"
            value={selected.zoom}
            min={10}
            max={19}
            step={0.1}
            formatValue={(v) => v.toFixed(1)}
            onValueChange={(zoom) => editor.dragKeyframe(selected.id, { zoom })}
            onSlidingComplete={editor.endGesture}
            accessibilityLabel="Keyframe zoom"
          />
          <Slider
            label="Tilt"
            value={selected.pitch}
            min={0}
            max={60}
            step={1}
            formatValue={(v) => `${Math.round(v)}°`}
            onValueChange={(pitch) => editor.dragKeyframe(selected.id, { pitch })}
            onSlidingComplete={editor.endGesture}
            accessibilityLabel="Keyframe tilt"
          />
          {selected.aim === 'fixed' ? (
            <Slider
              label="Bearing"
              value={selected.bearing}
              min={0}
              max={359}
              step={1}
              formatValue={(v) => `${Math.round(v)}°`}
              onValueChange={(bearing) => editor.dragKeyframe(selected.id, { bearing })}
              onSlidingComplete={editor.endGesture}
              accessibilityLabel="Keyframe bearing"
            />
          ) : null}
          <Slider
            label="Hold"
            value={selected.holdMs / 1000}
            min={0}
            max={5}
            step={0.5}
            formatValue={(v) => `${v.toFixed(1)} s`}
            onValueChange={(seconds) =>
              editor.dragKeyframe(selected.id, { holdMs: Math.round(seconds * 1000) })
            }
            onSlidingComplete={editor.endGesture}
            accessibilityLabel="Pause at this keyframe"
          />
          <Button
            size="xs"
            appearance="outline"
            tone="neutral"
            onPress={async () => {
              const vp = await currentViewport();
              if (vp)
                editor.updateKeyframe(selected.id, {
                  center: { latitude: vp.latitude, longitude: vp.longitude },
                });
            }}
          >
            Move to the map's centre
          </Button>
        </View>
      ) : null}

      <Slider
        label="Speed"
        value={tour.speed}
        min={0.5}
        max={2}
        step={0.25}
        formatValue={(v) => `${v.toFixed(2)}×`}
        onValueChange={(speed) => editor.setSpeed(speed, true)}
        onSlidingComplete={editor.endGesture}
        accessibilityLabel="Playback speed"
      />

      <View className="flex-row flex-wrap gap-space-8">
        <Button
          size="sm"
          appearance="solid"
          tone="accent"
          leadingIcon={RiPlayFill}
          onPress={startPreview}
          disabled={!compiled}
          testID="studio-preview"
        >
          Preview
        </Button>
        <Button
          size="sm"
          appearance="outline"
          tone="neutral"
          leadingIcon={RiShareLine}
          onPress={() => void share()}
          disabled={!compiled}
          testID="studio-share"
        >
          Share link
        </Button>
        {Platform.OS === 'web' && canExportVideo() ? (
          <Button
            size="sm"
            appearance="outline"
            tone="neutral"
            leadingIcon={RiFilmLine}
            onPress={() => void exportClip()}
            disabled={!compiled || exporting}
            testID="studio-export"
          >
            Export video
          </Button>
        ) : null}
      </View>
      {notice ? (
        <Text className="text-caption text-muted-foreground" selectable testID="studio-notice">
          {notice}
        </Text>
      ) : null}
    </ScrollView>
  );

  return (
    <View className="flex-1 bg-background">
      <MapCanvas
        ref={mapRef}
        initialViewport={initialViewport}
        markers={markers}
        overlays={overlays}
        onPress={handlePress}
        onMarkerPress={handleMarkerPress}
        onViewportChange={handleViewportChange}
        interaction={tool === 'draw' ? { pan: false, rotate: false, pitch: false } : undefined}
        testID="studio-map"
      />

      {tool === 'draw' && !previewing ? (
        <DrawSurface color={accent} onStroke={(p, s) => void handleStroke(p, s)} />
      ) : null}

      <View
        onLayout={(event) => setTopHeight(Math.round(event.nativeEvent.layout.height))}
        pointerEvents="box-none"
        className="absolute left-0 right-0 top-0 flex-row items-center gap-space-8 px-space-12"
        style={{ paddingTop: windowEdgeGap(insets.top) }}
      >
        <View className="flex-row items-center gap-space-8 rounded-radius-max bg-card py-space-4 pl-space-4 pr-space-16 shadow-m">
          <GlyphButton
            icon={RiArrowLeftLine}
            size={36}
            onPress={() => router.replace('/')}
            accessibilityLabel="Back to the map"
          />
          <Text className="text-body font-semibold text-foreground">Camera Studio</Text>
        </View>
        {pickingLookAt ? (
          <View
            accessibilityRole="alert"
            className="rounded-radius-max bg-card px-space-16 py-space-8 shadow-m"
          >
            <Text className="text-bodySmall text-foreground">
              Tap what the camera should look at
            </Text>
          </View>
        ) : null}
      </View>

      {previewing ? (
        <PlayerBar
          player={player}
          subject="the tour"
          caption={
            exporting
              ? 'Recording…'
              : reducedMotion
                ? 'Reduced motion: stepping through the keyframes'
                : undefined
          }
          onClose={exporting ? cancelExport : stopPreview}
          closeLabel={exporting ? 'Cancel the recording' : 'Stop the preview'}
          testID="studio-player"
        />
      ) : (
        <View
          onLayout={(event) => setPanelHeight(Math.round(event.nativeEvent.layout.height))}
          className="absolute overflow-hidden rounded-radius-16 bg-card shadow-l"
          style={
            wide
              ? { top: topHeight + 8, right: 12, width: PANEL_WIDTH, bottom: 48 }
              : { left: 8, right: 8, bottom: bottomGap, maxHeight: '45%' }
          }
          testID="studio-panel"
        >
          {panel}
        </View>
      )}
    </View>
  );
}
