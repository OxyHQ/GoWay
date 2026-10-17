/**
 * `<GeoJSONSource>`, web — a GeoJSON source on the engine, with `<Layer>`
 * children drawing it.
 *
 * Two bindings, in two files, because a source has two lives: it is ADDED
 * once per engine (here, with its clustering options, which maplibre-gl takes
 * only at creation) and its DATA changes many times (`SourceData.web.tsx`,
 * `setData`). Removing and re-adding it for every new data set would take its
 * layers with it.
 *
 * The layers render only once the source exists: React binds children before
 * their parent, and a layer added before its source throws.
 */
import { type ReactNode, useContext, useLayoutEffect, useState } from 'react';
import type { GeoJSONSourceSpecification, Map as MapLibreMap } from 'maplibre-gl';

import { WebEngineContext } from './engineContext.web';
import { isDrawableGeoJSON, reportMapDefect, runEngineCommand } from './shared';
import { SourceIdContext } from './sourceContext';
import { SourceData } from './SourceData.web';
import type { GeoJSONSourceProps } from './types';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function GeoJSONSource(props: GeoJSONSourceProps) {
  const engine = useContext(WebEngineContext);
  return engine ? <GeoJSONSourceBinding map={engine.map} {...props} /> : null;
}

function GeoJSONSourceBinding({
  map,
  id,
  data,
  cluster,
  clusterRadius,
  clusterMaxZoom,
  clusterMinPoints,
  clusterProperties,
  children,
}: GeoJSONSourceProps & { map: MapLibreMap; children?: ReactNode }) {
  const [added, setAdded] = useState<MapLibreMap | null>(null);
  // Binding: the source `id` exists on the engine, with its creation options.
  useLayoutEffect(() => {
    const spec: GeoJSONSourceSpecification = {
      type: 'geojson',
      data: EMPTY,
      ...(cluster ? { cluster: true } : {}),
      ...(clusterRadius !== undefined ? { clusterRadius } : {}),
      ...(clusterMaxZoom !== undefined ? { clusterMaxZoom } : {}),
      ...(clusterMinPoints !== undefined ? { clusterMinPoints } : {}),
      ...(clusterProperties
        ? {
            clusterProperties: clusterProperties as GeoJSONSourceSpecification['clusterProperties'],
          }
        : {}),
    };
    if (!runEngineCommand('addSource', () => map.addSource(id, spec))) return;
    setAdded(map);
    return () => {
      setAdded(null);
      runEngineCommand('removeSource', () => {
        // A layer still drawing the source would make the removal throw.
        for (const layer of map.getStyle()?.layers ?? []) {
          if ('source' in layer && layer.source === id) map.removeLayer(layer.id);
        }
        if (map.getSource(id)) map.removeSource(id);
      });
    };
  }, [map, id, cluster, clusterRadius, clusterMaxZoom, clusterMinPoints, clusterProperties]);

  if (added !== map) return null;
  // Raw GeoJSON fails SILENTLY rather than loudly: a NaN vertex tiles to
  // nothing and the line the reader asked for is simply absent. Refused here,
  // and said so.
  const drawable = isDrawableGeoJSON(data);
  if (!drawable) {
    reportMapDefect(
      `source:${id}`,
      `Dropped the data of source "${id}": it is not drawable GeoJSON.`,
    );
  }
  return (
    <SourceIdContext.Provider value={id}>
      <SourceData map={map} id={id} data={drawable ? data : EMPTY} />
      {children}
    </SourceIdContext.Provider>
  );
}
