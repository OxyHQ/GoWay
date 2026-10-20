/** `<RasterDEMSource>`, native — MapLibre Native's elevation source (for a `hillshade` layer). */
import { RasterDEMSource as NativeRasterDEMSource } from '@maplibre/maplibre-react-native';

import { SourceIdContext } from './sourceContext';
import type { RasterDEMSourceProps } from './types';

export function RasterDEMSource({
  id,
  tiles,
  encoding,
  tileSize,
  minzoom,
  maxzoom,
  children,
}: RasterDEMSourceProps) {
  return (
    <NativeRasterDEMSource
      id={id}
      tiles={[...tiles]}
      {...(encoding ? { encoding } : {})}
      {...(tileSize !== undefined ? { tileSize } : {})}
      {...(minzoom !== undefined ? { minzoom } : {})}
      {...(maxzoom !== undefined ? { maxzoom } : {})}
    >
      <SourceIdContext.Provider value={id}>{children}</SourceIdContext.Provider>
    </NativeRasterDEMSource>
  );
}
