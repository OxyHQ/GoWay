/**
 * The marker body both forks draw when a caller does not pass `renderMarker`.
 *
 * These are Bloom components, not GoWay ones. `@oxy.so/bloom/map-marker`
 * already ships the pill and the cluster bubble with their `default` / `active`
 * / `visited` states, their press affordance and their web focus ring — so a
 * GoWay-local marker would be a second, worse copy that drifts from the design
 * system at the first token change.
 *
 * Because it is ordinary Bloom UI on both platforms (native positions it with
 * MapLibre's `<Marker>`, web with a DOM `maplibregl.Marker` React-portals into),
 * a marker looks identical on iOS, Android and the web, and issue #7's category
 * and selection rules have one place to land.
 */
import { memo } from 'react';
import { MapClusterMarker, MapPriceMarker } from '@oxy.so/bloom/map-marker';

import type { MapMarker } from './types';

export interface DefaultMapMarkerProps {
  marker: MapMarker;
  onPress?: () => void;
}

function DefaultMapMarkerComponent({ marker, onPress }: DefaultMapMarkerProps) {
  const state = marker.selected ? 'active' : 'default';

  if (marker.count != null && marker.count > 1) {
    return (
      <MapClusterMarker
        count={marker.count}
        state={state}
        onPress={onPress}
        accessibilityLabel={marker.accessibilityLabel ?? `${marker.count} places`}
      />
    );
  }

  return (
    <MapPriceMarker
      // Bloom's pill is a labelled marker; the label happens to be a price in
      // its first consumer. GoWay passes a place name, a category or a bullet.
      price={marker.label ?? '•'}
      state={state}
      size={marker.label ? 'default' : 'compact'}
      onPress={onPress}
      accessibilityLabel={marker.accessibilityLabel ?? marker.label ?? 'Map marker'}
    />
  );
}

export const DefaultMapMarker = memo(DefaultMapMarkerComponent);
