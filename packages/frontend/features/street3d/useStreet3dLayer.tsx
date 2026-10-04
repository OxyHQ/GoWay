/**
 * Street 3D on the main map: published scene footprints, coverage areas, and
 * a chip per scene that opens the viewer.
 *
 * The layer is OFF unless `EXPO_PUBLIC_STREET3D_ENABLED` is on, draws nothing
 * below street zoom (`STREET3D_MIN_ZOOM`), fetches only for a SETTLED viewport
 * (debounced, never per camera frame), and stays silent on every failure —
 * see `queries.ts`. The map is public; nothing here needs a session or a
 * location.
 */
import { useCallback, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { useRouter } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';
import type { StreetCoverageArea } from '@goway/shared-types';

import type { GeoBounds, MapApi, MapMarker, MapOverlay, MapViewportChange } from '@/components/map';
import { STREET3D_ENABLED } from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

import {
  areasWantingCapture,
  coverageOverlays,
  sceneIdOfMarker,
  sceneMarkers,
  shouldFetchCoverage,
} from './coverageStyle';
import { rememberSceneSummary } from './handoff';
import { useStreetCoverage } from './queries';
import { SceneChip } from './SceneChip';

const EMPTY_OVERLAYS: readonly MapOverlay[] = [];
const EMPTY_MARKERS: readonly MapMarker[] = [];
const EMPTY_AREAS: readonly StreetCoverageArea[] = [];
const SETTLE_MS = 400;

export interface Street3dLayer {
  overlays: readonly MapOverlay[];
  markers: readonly MapMarker[];
  /** Areas in view where another photo is what is missing. */
  wantingCapture: readonly StreetCoverageArea[];
  onViewportChange: (change: MapViewportChange) => void;
  /** Seed from the camera the map opened on; the canvas emits no event for it. */
  onMapReady: () => void;
  /** `true` when the marker is this layer's, and it handled the press. */
  handleMarkerPress: (marker: MapMarker) => boolean;
  /** This layer's marker body, or `null` for any other marker. */
  renderMarker: (marker: MapMarker) => ReactNode | null;
}

interface SettledView {
  bounds: GeoBounds;
  zoom: number;
}

export function useStreet3dLayer(mapRef: RefObject<MapApi | null>, { enabled }: { enabled: boolean }): Street3dLayer {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const on = STREET3D_ENABLED && enabled;

  const [view, setView] = useState<SettledView | null>(null);
  const settled = useDebouncedValue(view, SETTLE_MS);
  // Visibility follows the LIVE zoom so zooming out hides the layer at once;
  // only the fetch waits for the camera to settle.
  const visible = on && shouldFetchCoverage(view?.zoom);
  const fetchable = on && settled != null && shouldFetchCoverage(settled.zoom);

  const coverage = useStreetCoverage(fetchable ? settled.bounds : null, { enabled: fetchable });
  const data = visible && !coverage.isError ? coverage.data : undefined;

  const onViewportChange = useCallback(
    (change: MapViewportChange) => {
      if (!on || !change.isFinal) return;
      setView({ bounds: change.bounds, zoom: change.viewport.zoom });
    },
    [on],
  );

  const onMapReady = useCallback(() => {
    if (!on) return;
    const api = mapRef.current;
    if (!api) return;
    void Promise.all([api.getViewport(), api.getBounds()]).then(([viewport, bounds]) => {
      if (viewport && bounds) setView((current) => current ?? { bounds, zoom: viewport.zoom });
    });
  }, [mapRef, on]);

  const overlays = useMemo(
    () => (data ? coverageOverlays(data, theme.colors) : EMPTY_OVERLAYS),
    [data, theme.colors],
  );

  const label = t('street3d.layer.open');
  const markers = useMemo(() => (data ? sceneMarkers(data.scenes, label) : EMPTY_MARKERS), [data, label]);

  const wantingCapture = useMemo(() => (data ? areasWantingCapture(data.areas) : EMPTY_AREAS), [data]);

  const summaries = useMemo(() => new Map((data?.scenes ?? []).map((scene) => [scene.id, scene])), [data]);

  const openScene = useCallback(
    (sceneId: string) => {
      const summary = summaries.get(sceneId);
      if (summary) rememberSceneSummary(summary);
      router.push(`/street3d/${encodeURIComponent(sceneId)}`);
    },
    [router, summaries],
  );

  const handleMarkerPress = useCallback(
    (marker: MapMarker) => {
      const sceneId = sceneIdOfMarker(marker);
      if (!sceneId) return false;
      openScene(sceneId);
      return true;
    },
    [openScene],
  );

  const renderMarker = useCallback(
    (marker: MapMarker) => {
      const sceneId = sceneIdOfMarker(marker);
      if (!sceneId) return null;
      const summary = summaries.get(sceneId);
      const accessibilityLabel = summary?.placement === 'approximate'
        ? `${label} · ${t('street3d.layer.approximate')}`
        : label;
      return <SceneChip summary={summary} accessibilityLabel={accessibilityLabel} onPress={() => openScene(sceneId)} />;
    },
    [label, openScene, summaries, t],
  );

  return { overlays, markers, wantingCapture, onViewportChange, onMapReady, handleMarkerPress, renderMarker };
}
