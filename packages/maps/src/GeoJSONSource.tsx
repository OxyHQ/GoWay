/**
 * `<GeoJSONSource>`, native — MapLibre Native's source, whose data and
 * clustering options are props it diffs itself.
 */
import type { ComponentProps } from 'react';
import { GeoJSONSource as NativeGeoJSONSource } from '@maplibre/maplibre-react-native';

import { isDrawableGeoJSON, reportMapDefect } from './shared';
import { SourceIdContext } from './sourceContext';
import type { GeoJSONSourceProps } from './types';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function GeoJSONSource({
  id,
  data,
  cluster,
  clusterRadius,
  clusterMaxZoom,
  clusterMinPoints,
  clusterProperties,
  children,
}: GeoJSONSourceProps) {
  // Raw GeoJSON fails SILENTLY rather than loudly: refused here, and said so.
  const drawable = isDrawableGeoJSON(data);
  if (!drawable) {
    reportMapDefect(
      `source:${id}`,
      `Dropped the data of source "${id}": it is not drawable GeoJSON.`,
    );
  }
  return (
    <NativeGeoJSONSource
      id={id}
      data={drawable ? data : EMPTY}
      {...(cluster ? { cluster: true } : {})}
      {...(clusterRadius !== undefined ? { clusterRadius } : {})}
      {...(clusterMaxZoom !== undefined ? { clusterMaxZoom } : {})}
      {...(clusterMinPoints !== undefined ? { clusterMinPoints } : {})}
      {...(clusterProperties
        ? {
            clusterProperties: clusterProperties as ComponentProps<
              typeof NativeGeoJSONSource
            >['clusterProperties'],
          }
        : {})}
    >
      <SourceIdContext.Provider value={id}>{children}</SourceIdContext.Provider>
    </NativeGeoJSONSource>
  );
}
