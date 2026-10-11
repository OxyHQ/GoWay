/**
 * Everything the landmarks add over the explore map: the "Landmarks" pill
 * while browsing, and the full-screen tour once it is opened (from the pill
 * or from a place's "Landmark tour"). Owned by `ExploreScreen`, which holds
 * which landmark the tour is on (`startId`) and hides its own chrome while
 * one is.
 */
import type { RefObject } from 'react';

import type { MapApi } from '@/components/map';

import { LandmarksPill } from './LandmarkEntry';
import { LandmarkTour } from './LandmarkTour';
import { useLandmarks } from './useLandmarks';

export interface LandmarkOverlayProps {
  mapRef: RefObject<MapApi | null>;
  /** Below the top bar. */
  top: number;
  /** The settled view centre (for the pill), or `null` before the map is ready. */
  centre: { latitude: number; longitude: number } | null;
  /** The landmark the tour is on, or `null` while browsing. */
  startId: string | null;
  /** Show the pill (the screen hides it while something else owns the map). */
  showPill: boolean;
  onStart: (id: string) => void;
  onClose: () => void;
  subscribeUserMove: (listener: () => void) => () => void;
}

export function LandmarkOverlay({
  mapRef,
  top,
  centre,
  startId,
  showPill,
  onStart,
  onClose,
  subscribeUserMove,
}: LandmarkOverlayProps) {
  const landmarks = useLandmarks();
  if (landmarks.length === 0) return null;
  if (startId) {
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
  return showPill ? (
    <LandmarksPill landmarks={landmarks} centre={centre} top={top} onOpen={onStart} />
  ) : null;
}
