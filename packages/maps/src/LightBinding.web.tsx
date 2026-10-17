/**
 * The style's light, bound to the `light` prop.
 *
 * A light is a property of the loaded style, and maplibre-gl sets it with an
 * imperative `setLight` — so this component holds the one binding that keeps
 * the engine's light equal to the prop. `null` leaves the document's own
 * light alone. maplibre-gl diffs the light itself and eases the change.
 */
import { useLayoutEffect } from 'react';
import type { LightSpecification, Map as MapLibreMap } from 'maplibre-gl';

import { runEngineCommand } from './shared';

export function LightBinding({
  map,
  light,
}: {
  map: MapLibreMap;
  light: Readonly<Record<string, unknown>> | null;
}) {
  // Binding: the engine's light follows `light` (an imperative style setter).
  useLayoutEffect(() => {
    if (!light) return;
    runEngineCommand('setLight', () => map.setLight(light as LightSpecification));
  }, [map, light]);
  return null;
}
