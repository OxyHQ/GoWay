/**
 * `<Layer>`, web — a style layer drawing the source around it.
 *
 * Added once per engine with what maplibre-gl fixes at creation (its id,
 * type, source and place in the stack); its paint, layout and filter are
 * their own binding (`LayerStyle.web.tsx`), so a new colour restyles the layer
 * instead of removing and re-adding it.
 */
import { useContext, useLayoutEffect, useState } from 'react';
import type { AddLayerObject, Map as MapLibreMap } from 'maplibre-gl';

import { WebEngineContext } from './engineContext.web';
import { LayerStyle } from './LayerStyle.web';
import { runEngineCommand } from './shared';
import { useSourceId } from './sourceContext';
import type { LayerProps } from './types';

export function Layer(props: LayerProps) {
  const engine = useContext(WebEngineContext);
  const source = useSourceId();
  return engine ? <LayerBinding map={engine.map} source={source} {...props} /> : null;
}

function LayerBinding({
  map,
  source,
  id,
  type,
  beforeId,
  minzoom,
  maxzoom,
  paint,
  layout,
  filter,
}: LayerProps & { map: MapLibreMap; source: string }) {
  const [added, setAdded] = useState<MapLibreMap | null>(null);
  // Binding: the layer `id` exists on the engine, over `source`, under `beforeId`.
  useLayoutEffect(() => {
    const spec = {
      id,
      type,
      source,
      ...(minzoom !== undefined ? { minzoom } : {}),
      ...(maxzoom !== undefined ? { maxzoom } : {}),
    } as AddLayerObject;
    // Under `beforeId` only when the style has it: a style that makes no such
    // promise gets the layer on top rather than an exception.
    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
    if (!runEngineCommand('addLayer', () => map.addLayer(spec, before))) return;
    setAdded(map);
    return () => {
      setAdded(null);
      runEngineCommand('removeLayer', () => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
    };
  }, [map, source, id, type, beforeId, minzoom, maxzoom]);

  return added === map ? (
    <LayerStyle map={map} id={id} paint={paint} layout={layout} filter={filter} />
  ) : null;
}
