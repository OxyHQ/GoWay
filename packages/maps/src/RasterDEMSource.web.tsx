/**
 * `<RasterDEMSource>`, web — an elevation source (for a `hillshade` layer),
 * added once per engine with its tiles.
 */
import { type ReactNode, useContext, useLayoutEffect, useState } from 'react';
import type { Map as MapLibreMap, RasterDEMSourceSpecification } from 'maplibre-gl';

import { WebEngineContext } from './engineContext.web';
import { runEngineCommand } from './shared';
import { SourceIdContext } from './sourceContext';
import type { RasterDEMSourceProps } from './types';

export function RasterDEMSource(props: RasterDEMSourceProps) {
  const engine = useContext(WebEngineContext);
  return engine ? <RasterDEMSourceBinding map={engine.map} {...props} /> : null;
}

function RasterDEMSourceBinding({
  map,
  id,
  tiles,
  encoding,
  tileSize,
  minzoom,
  maxzoom,
  children,
}: RasterDEMSourceProps & { map: MapLibreMap; children?: ReactNode }) {
  const [added, setAdded] = useState<MapLibreMap | null>(null);
  const tileKey = tiles.join('\n');
  // Binding: the source `id` exists on the engine with these tiles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tileKey` is the value `tiles` stands for
  useLayoutEffect(() => {
    const spec: RasterDEMSourceSpecification = {
      type: 'raster-dem',
      tiles: [...tiles],
      ...(encoding ? { encoding } : {}),
      ...(tileSize !== undefined ? { tileSize } : {}),
      ...(minzoom !== undefined ? { minzoom } : {}),
      ...(maxzoom !== undefined ? { maxzoom } : {}),
    };
    if (!runEngineCommand('addSource', () => map.addSource(id, spec))) return;
    setAdded(map);
    return () => {
      setAdded(null);
      runEngineCommand('removeSource', () => {
        for (const layer of map.getStyle()?.layers ?? []) {
          if ('source' in layer && layer.source === id) map.removeLayer(layer.id);
        }
        if (map.getSource(id)) map.removeSource(id);
      });
    };
  }, [map, id, tileKey, encoding, tileSize, minzoom, maxzoom]);
  return added === map ? (
    <SourceIdContext.Provider value={id}>{children}</SourceIdContext.Provider>
  ) : null;
}
