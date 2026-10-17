/**
 * GoWay's markers as `@goway.to/maps` markers.
 *
 * GoWay marks the selected marker and which markers may cluster; the SDK draws
 * a marker from its data, clusters what may be, and draws a body from an item. These two functions are the one
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

/** What Bloom draws for a GoWay marker: a pill, active when it is the selected one. */
export function markerItem(marker: MapMarker): MapMarkerItem {
  return {
    kind: 'point',
    marker: markerData(marker),
    state: marker.selected ? 'active' : 'default',
  };
}
