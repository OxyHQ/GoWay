/**
 * Public cameras on the main map: a pin per camera, each opening its picture.
 *
 * The layer follows the `cameras` map feature, draws nothing below street zoom
 * (`CAMERAS_MIN_ZOOM`), fetches only for a SETTLED viewport (debounced, never
 * per camera frame), spends the quality profile's marker budget on the cameras
 * nearest the centre, and stays silent on every failure — see `queries.ts`.
 * The map is public: nothing here needs a session, and the viewer's location
 * is never sent (the box is the map's, not the person's).
 *
 * Each provider's credit is owed while its camera is drawn, so the layer hands
 * the canvas the credits of exactly the pins on screen (`credits`).
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import type { Camera } from '@goway.to/sdk';

import type { GeoBoundingBox, MapCameraChange, MapCreditLink, MapMarker } from '@/components/map';
import { useMapQuality } from '@/lib/map/quality/useMapQuality';
import { useMapFeature } from '@/lib/map/useMapFeatures';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

import { CameraMarker } from './CameraMarker';
import {
  cameraCredits,
  cameraIdOfMarker,
  cameraMarkers,
  centreOf,
  nearestCameras,
  shouldFetchCameras,
} from './cameraStyle';
import { useCameraText } from './messages';
import { useCameras } from './queries';

const EMPTY_MARKERS: readonly MapMarker[] = [];
const EMPTY_CREDITS: readonly MapCreditLink[] = [];
const SETTLE_MS = 400;

export interface CamerasLayer {
  markers: readonly MapMarker[];
  /** The credits owed for the pins drawn. */
  credits: readonly MapCreditLink[];
  onViewportChange: (change: MapCameraChange) => void;
  /** `true` when the marker is this layer's, and it handled the press. */
  handleMarkerPress: (marker: MapMarker) => boolean;
  /** This layer's marker body, or `null` for any other marker. */
  renderMarker: (marker: MapMarker) => ReactNode | null;
}

interface SettledView {
  bounds: GeoBoundingBox;
  zoom: number;
}

export function useCamerasLayer({ enabled }: { enabled: boolean }): CamerasLayer {
  const router = useRouter();
  const t = useCameraText();
  const quality = useMapQuality();
  const on = useMapFeature('cameras') && enabled;

  const [view, setView] = useState<SettledView | null>(null);
  const settled = useDebouncedValue(view, SETTLE_MS);
  // Visibility follows the LIVE zoom so zooming out hides the pins at once;
  // only the fetch waits for the camera to settle.
  const visible = on && shouldFetchCameras(view?.zoom);
  const fetchable = on && settled != null && shouldFetchCameras(settled.zoom);

  const query = useCameras(fetchable ? settled.bounds : null, { enabled: fetchable });
  const all = visible && !query.isError ? query.data : undefined;

  const drawn = useMemo<readonly Camera[]>(
    () =>
      all && settled
        ? nearestCameras(all, centreOf(settled.bounds), quality.cameras.maxMarkers)
        : [],
    [all, settled, quality.cameras.maxMarkers],
  );

  const byId = useMemo(() => new Map(drawn.map((camera) => [camera.id, camera])), [drawn]);
  const markers = useMemo(
    () =>
      drawn.length === 0
        ? EMPTY_MARKERS
        : cameraMarkers(drawn, (camera) => t('cameras.open', { name: camera.name })),
    [drawn, t],
  );
  const credits = useMemo(
    () => (drawn.length === 0 ? EMPTY_CREDITS : cameraCredits(drawn)),
    [drawn],
  );

  const onViewportChange = useCallback(
    (change: MapCameraChange) => {
      if (!on || !change.isFinal) return;
      setView({ bounds: change.bounds, zoom: change.viewport.zoom });
    },
    [on],
  );

  const open = useCallback(
    (cameraId: string) => router.push(`/camera/${encodeURIComponent(cameraId)}`),
    [router],
  );

  const handleMarkerPress = useCallback(
    (marker: MapMarker) => {
      const cameraId = cameraIdOfMarker(marker);
      if (!cameraId) return false;
      open(cameraId);
      return true;
    },
    [open],
  );

  const renderMarker = useCallback(
    (marker: MapMarker) => {
      const cameraId = cameraIdOfMarker(marker);
      if (!cameraId) return null;
      return (
        <CameraMarker
          status={byId.get(cameraId)?.status}
          accessibilityLabel={marker.accessibilityLabel ?? t('cameras.open', { name: cameraId })}
          onPress={() => open(cameraId)}
        />
      );
    },
    [byId, open, t],
  );

  return { markers, credits, onViewportChange, handleMarkerPress, renderMarker };
}
