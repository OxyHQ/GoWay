/**
 * GoWay's markers as `@goway.to/maps` markers.
 *
 * GoWay's explore screen collapses its own groups of places
 * (`lib/goway/markers.ts`) and marks the selected one; the SDK draws a marker
 * from its data and a body from an item. These two functions are the one
 * place a GoWay marker becomes both, for both forks.
 */
import type { MapMarkerData, MapMarkerItem } from '@goway.to/maps';

import type { MapMarker } from './types';

/** What the SDK places: the id and the coordinate, with the marker's words. */
export function markerData(marker: MapMarker): MapMarkerData {
  return {
    id: marker.id,
    coordinate: marker.coordinate,
    ...(marker.label ? { label: marker.label } : {}),
    ...(marker.accessibilityLabel ? { accessibilityLabel: marker.accessibilityLabel } : {}),
    ...(marker.kind ? { kind: marker.kind } : {}),
  };
}

/** What Bloom draws for it: a pre-collapsed group is a cluster bubble, the selected one active. */
export function markerItem(marker: MapMarker): MapMarkerItem {
  const state = marker.selected ? 'active' : 'default';
  if (marker.count != null && marker.count > 1) {
    return {
      kind: 'cluster',
      cluster: { id: marker.id, coordinate: marker.coordinate, count: marker.count, markerIds: [] },
      state,
    };
  }
  return { kind: 'point', marker: markerData(marker), state };
}
