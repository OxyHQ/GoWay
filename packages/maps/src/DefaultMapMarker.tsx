/**
 * The marker body both forks draw when a caller does not pass `renderMarker`.
 *
 * These are Bloom components, not GoWay ones: `@oxy.so/bloom/map-marker`
 * already ships the pill and the cluster bubble with their `default` /
 * `active` / `visited` states, their press affordance and their web focus
 * ring, so a local marker would be a second, worse copy that drifts from the
 * design system at the first token change.
 *
 * Because it is ordinary Bloom UI on both platforms (native positions it with
 * MapLibre's `<Marker>`, web with a DOM `maplibregl.Marker` it is portalled
 * into), a marker looks identical on iOS, Android and the web.
 */
import { memo } from 'react';
import { MapClusterMarker, MapPriceMarker } from '@oxy.so/bloom/map-marker';

import type { MapMarkerItem } from './types';

export interface DefaultMapMarkerProps {
  item: MapMarkerItem;
  onPress?: () => void;
}

function DefaultMapMarkerComponent({ item, onPress }: DefaultMapMarkerProps) {
  if (item.kind === 'cluster') {
    return (
      <MapClusterMarker
        count={item.cluster.count}
        state={item.state}
        onPress={onPress}
        testID={`map-cluster-${item.cluster.id}`}
      />
    );
  }
  const { marker } = item;
  return (
    <MapPriceMarker
      // Bloom's pill is a labelled marker; the label happens to be a price in
      // its first consumer. GoWay passes a place name, a category or nothing.
      price={marker.label ?? '•'}
      state={item.state}
      size={marker.label ? 'default' : 'compact'}
      onPress={onPress}
      accessibilityLabel={marker.accessibilityLabel ?? marker.label ?? 'Map marker'}
      testID={`map-marker-${marker.id}`}
    />
  );
}

export const DefaultMapMarker = memo(DefaultMapMarkerComponent);
