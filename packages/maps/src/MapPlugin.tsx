/**
 * `<MapPlugin>`, native — nothing. MapLibre Native has no custom-layer API, so
 * an engine plugin is a web-only extension (`plugin.ts`).
 */
import type { MapPluginProps } from './plugin';

export function MapPlugin<Props>(_props: MapPluginProps<Props>): null {
  return null;
}
