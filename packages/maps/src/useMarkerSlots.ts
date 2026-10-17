/**
 * What `<Markers>` draws, and what a press on each does — the part both forks
 * share. The fork only places each slot with its engine's marker.
 */
import { useCallback, useContext, useMemo, useState } from 'react';

import {
  type ClusterOptions,
  DEFAULT_CLUSTER_OPTIONS,
  indexMarkers,
  type MarkerSlot,
  markerSlotsAt,
} from './clusters';
import { MapRefContext } from './mapRef';
import { drawableMarkers } from './shared';
import type { MarkersProps } from './types';
import { useZoomLevel } from './zoom';

export function useMarkerSlots({
  data,
  selectedId,
  cluster = false,
  clusterRadius = DEFAULT_CLUSTER_OPTIONS.radius,
  clusterMaxZoom = DEFAULT_CLUSTER_OPTIONS.maxZoom,
  clusterMinPoints = DEFAULT_CLUSTER_OPTIONS.minPoints,
  onPress,
  onClusterPress,
}: MarkersProps): { slots: readonly MarkerSlot[]; press: (slot: MarkerSlot) => void } {
  const zoom = useZoomLevel();
  const map = useContext(MapRefContext);
  // Undrawable markers are dropped, and said so once (`shared.ts`).
  const drawable = drawableMarkers(data);
  // The selected marker is never folded into a cluster: what the reader is
  // looking at stays on the map, at its own coordinate, whatever the zoom.
  const pinned =
    cluster && selectedId != null ? drawable.find((m) => m.id === selectedId) : undefined;
  const index = useMemo(() => {
    const options: ClusterOptions | null = cluster
      ? { radius: clusterRadius, maxZoom: clusterMaxZoom, minPoints: clusterMinPoints }
      : null;
    const gathered = pinned ? drawable.filter((marker) => marker !== pinned) : drawable;
    return indexMarkers(gathered, options);
  }, [drawable, pinned, cluster, clusterRadius, clusterMaxZoom, clusterMinPoints]);
  // Pressed before on this map: drawn muted, so the reader sees what they
  // have already looked at.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const slots = useMemo(() => {
    const drawn = markerSlotsAt(index, zoom, selectedId, visited);
    if (!pinned) return drawn;
    return [
      ...drawn,
      {
        key: `point:${pinned.id}`,
        coordinate: pinned.coordinate,
        item: { kind: 'point' as const, marker: pinned, state: 'active' as const },
      },
    ];
  }, [index, zoom, selectedId, visited, pinned]);

  const press = useCallback(
    (slot: MarkerSlot) => {
      const { item } = slot;
      if (item.kind === 'point') {
        const id = item.marker.id;
        setVisited((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
        onPress?.(item.marker);
        return;
      }
      // A cluster opens where it splits, as Mapbox's clusters do.
      if (slot.expansionZoom !== undefined) {
        map?.moveTo(slot.coordinate, { zoom: slot.expansionZoom });
      }
      onClusterPress?.(item.cluster);
    },
    [map, onPress, onClusterPress],
  );

  return { slots, press };
}
