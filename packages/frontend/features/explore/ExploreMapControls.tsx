/**
 * The explore screen's bottom-right controls: locate, compass, zoom and tilt,
 * as Bloom's `MapControls`.
 *
 * The compass needs the bearing as a NUMBER, and a camera move reports at
 * 10 Hz. The screen keeps the chrome to booleans so an orbit does not
 * re-render all of it (`docs/MAP_PERFORMANCE.md`), so the angle lives in
 * `CameraReadout`, a store this component alone subscribes to: the needle
 * turns, and nothing else re-renders.
 */
import { memo, useCallback, useSyncExternalStore } from 'react';
import { MapControls } from '@oxy.so/bloom/map-controls';

import { useTranslation } from '@/lib/i18n';
import type { MapApi } from '@/components/map';

/** One camera step of the zoom pair. */
const ZOOM_STEP = 1;

/** The latest bearing the map reported, and who wants to know. */
export class CameraReadout {
  private bearing = 0;
  private readonly listeners = new Set<() => void>();

  /** Called from the screen's viewport handler; a repeat of the same angle is free. */
  report(bearing: number) {
    if (bearing === this.bearing) return;
    this.bearing = bearing;
    for (const listener of this.listeners) listener();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getBearing = () => this.bearing;
}

export interface ExploreMapControlsProps {
  mapRef: { readonly current: MapApi | null };
  readout: CameraReadout;
  tilted: boolean;
  onTiltChange: (tilted: boolean) => void;
  onLocate: () => void;
  following: boolean;
}

function ExploreMapControlsComponent({
  mapRef,
  readout,
  tilted,
  onTiltChange,
  onLocate,
  following,
}: ExploreMapControlsProps) {
  const { t } = useTranslation();
  const heading = useSyncExternalStore(readout.subscribe, readout.getBearing, readout.getBearing);

  const zoomBy = useCallback(
    (delta: number) => {
      const map = mapRef.current;
      if (!map) return;
      void map.getViewport().then((viewport) => {
        if (viewport) map.moveTo(viewport, { zoom: viewport.zoom + delta });
      });
    },
    [mapRef],
  );
  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(-ZOOM_STEP), [zoomBy]);
  const resetNorth = useCallback(() => mapRef.current?.resetNorth(), [mapRef]);

  return (
    <MapControls
      onLocate={onLocate}
      following={following}
      heading={heading}
      onResetNorth={resetNorth}
      onZoomIn={zoomIn}
      onZoomOut={zoomOut}
      onTiltChange={onTiltChange}
      tilted={tilted}
      labels={{ locate: t('map.myLocation') }}
      testID="map-controls"
    />
  );
}

export const ExploreMapControls = memo(ExploreMapControlsComponent);
