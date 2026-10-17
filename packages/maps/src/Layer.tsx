/**
 * `<Layer>`, native — MapLibre Native's layer over the source around it; its
 * paint, layout and filter are props it diffs itself.
 */
import type { ComponentProps } from 'react';
import { Layer as NativeLayer } from '@maplibre/maplibre-react-native';

import { useSourceId } from './sourceContext';
import type { LayerProps } from './types';

export function Layer({ id, type, paint, layout, filter, beforeId, minzoom, maxzoom }: LayerProps) {
  const source = useSourceId();
  const props = {
    id,
    type,
    source,
    ...(paint ? { paint } : {}),
    ...(layout ? { layout } : {}),
    ...(filter ? { filter } : {}),
    ...(beforeId ? { beforeId } : {}),
    ...(minzoom !== undefined ? { minzoom } : {}),
    ...(maxzoom !== undefined ? { maxzoom } : {}),
  };
  // MapLibre Native types a layer as a union keyed by `type`; a `<Layer>`
  // takes its type as a value and its properties as plain style-spec names,
  // which the engine validates itself.
  return <NativeLayer {...(props as ComponentProps<typeof NativeLayer>)} />;
}
