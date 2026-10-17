/**
 * A layer's paint, layout and filter, bound to its props with maplibre-gl's
 * imperative setters (see `Layer.web.tsx` for why it is its own binding).
 * A property the props drop is reset to the style default.
 */
import { useLayoutEffect, useRef } from 'react';
import type { FilterSpecification, Map as MapLibreMap } from 'maplibre-gl';

import { runEngineCommand } from './shared';

type Properties = Readonly<Record<string, unknown>>;
const NONE: Properties = {};

export function LayerStyle({
  map,
  id,
  paint = NONE,
  layout = NONE,
  filter,
}: {
  map: MapLibreMap;
  id: string;
  paint?: Properties;
  layout?: Properties;
  filter?: readonly unknown[];
}) {
  // What this binding last set on THIS engine's layer; a rebuilt engine's
  // layer starts from the style's defaults.
  const applied = useRef<{ map: MapLibreMap | null; paint: Properties; layout: Properties }>({
    map: null,
    paint: NONE,
    layout: NONE,
  });
  // Binding: the layer's paint, layout and filter follow the props.
  useLayoutEffect(() => {
    const previous =
      applied.current.map === map ? applied.current : { map, paint: NONE, layout: NONE };
    runEngineCommand('setLayerStyle', () => {
      for (const key of new Set([...Object.keys(previous.paint), ...Object.keys(paint)])) {
        if (previous.paint[key] !== paint[key]) setPaint(map, id, key, paint[key]);
      }
      for (const key of new Set([...Object.keys(previous.layout), ...Object.keys(layout)])) {
        if (previous.layout[key] !== layout[key]) setLayout(map, id, key, layout[key]);
      }
      map.setFilter(id, (filter ?? null) as FilterSpecification | null);
    });
    applied.current = { map, paint, layout };
  }, [map, id, paint, layout, filter]);
  return null;
}

/**
 * maplibre-gl types a property NAME by the layer type it belongs to; a
 * `<Layer>` names its properties in plain style-spec strings, which the
 * engine validates itself (an unknown name is reported, not thrown).
 */
function setPaint(map: MapLibreMap, id: string, name: string, value: unknown): void {
  (map.setPaintProperty as (layer: string, property: string, value: unknown) => void).call(
    map,
    id,
    name,
    value,
  );
}

function setLayout(map: MapLibreMap, id: string, name: string, value: unknown): void {
  (map.setLayoutProperty as (layer: string, property: string, value: unknown) => void).call(
    map,
    id,
    name,
    value,
  );
}
