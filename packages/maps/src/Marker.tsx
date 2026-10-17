/**
 * One view drawn at a coordinate, native — MapLibre Native's `<Marker>`, a
 * real React Native view, so a marker on native is the same Bloom component as
 * on the web. Centred on its coordinate, as Bloom's map markers are designed
 * to be.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Marker as NativeMarker } from '@maplibre/maplibre-react-native';

import { isDrawableCoordinate, reportMapDefect, toLngLat } from './shared';
import type { GeoCoordinate } from './types';

export interface MarkerProps {
  coordinate: GeoCoordinate;
  children: ReactNode;
}

export function Marker({ coordinate, children }: MarkerProps) {
  if (!isDrawableCoordinate(coordinate)) {
    reportMapDefect('marker:coordinate', 'Dropped a marker: its coordinate is not drawable.');
    return null;
  }
  return (
    <NativeMarker lngLat={toLngLat(coordinate)} anchor="center">
      <View>{children}</View>
    </NativeMarker>
  );
}
