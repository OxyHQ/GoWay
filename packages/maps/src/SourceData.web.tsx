/**
 * A GeoJSON source's data, bound to its `data` prop with maplibre-gl's
 * imperative `setData` (see `GeoJSONSource.web.tsx` for why it is its own
 * binding).
 */
import { useLayoutEffect } from 'react';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

import { runEngineCommand } from './shared';

export function SourceData({
  map,
  id,
  data,
}: {
  map: MapLibreMap;
  id: string;
  data: GeoJSON.GeoJSON;
}) {
  // Binding: the source's data follows `data`.
  useLayoutEffect(() => {
    runEngineCommand('setData', () => map.getSource<GeoJSONSource>(id)?.setData(data));
  }, [map, id, data]);
  return null;
}
