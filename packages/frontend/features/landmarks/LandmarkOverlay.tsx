/**
 * The full-screen landmark tour, once it is opened (from the "Landmarks" pill
 * or from a place's "Landmark tour"). Owned by `ExploreScreen`, which holds
 * which landmark the tour is on (`startId`) and hides its own chrome while
 * one is. The pill itself is `LandmarksPillEntry`, which the screen places in
 * its top-right stack so it never sits on another chip.
 */
import type { RefObject } from 'react';

import type { MapApi } from '@/components/map';

import { LandmarkTour } from './LandmarkTour';
import { useLandmarks } from './useLandmarks';

export interface LandmarkOverlayProps {
  mapRef: RefObject<MapApi | null>;
  /** Below the top bar. */
  top: number;
  /** The landmark the tour is on. */
  startId: string;
  onClose: () => void;
  subscribeUserMove: (listener: () => void) => () => void;
}

export function LandmarkOverlay({
  mapRef,
  top,
  startId,
  onClose,
  subscribeUserMove,
}: LandmarkOverlayProps) {
  const landmarks = useLandmarks();
  if (landmarks.length === 0) return null;
  return (
    <LandmarkTour
      landmarks={landmarks}
      startId={startId}
      mapRef={mapRef}
      top={top}
      onClose={onClose}
      subscribeUserMove={subscribeUserMove}
    />
  );
}
