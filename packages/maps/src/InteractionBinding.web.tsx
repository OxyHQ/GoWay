/**
 * The engine's gesture handlers and pitch ceiling, bound to `interaction` and
 * `maxPitch`.
 *
 * maplibre-gl toggles gestures with imperative `enable()`/`disable()` calls on
 * its handlers, so this component holds the one binding that keeps them equal
 * to the props. Every flag is independent, on web as on native: `rotate` and
 * `pitch` are separate axes even though MapLibre drives both from one desktop
 * handler (`dragAxes.web.ts`).
 */
import { useLayoutEffect } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { applyDragAxes } from './dragAxes.web';
import { resolveInteraction, runEngineCommand } from './shared';
import type { MapInteractionOptions } from './types';

export function InteractionBinding({
  map,
  interaction,
  maxPitch,
}: {
  map: MapLibreMap;
  interaction: MapInteractionOptions | undefined;
  maxPitch: number;
}) {
  const { pan, zoom, rotate, pitch } = resolveInteraction(interaction);
  // Binding: the engine's gesture handlers follow `interaction` and `maxPitch`.
  useLayoutEffect(() => {
    const toggle = (handler: { enable(): void; disable(): void }, on: boolean) =>
      on ? handler.enable() : handler.disable();
    runEngineCommand('interaction', () => {
      toggle(map.dragPan, pan);
      toggle(map.scrollZoom, zoom);
      toggle(map.touchZoomRotate, zoom);
      toggle(map.doubleClickZoom, zoom);
      if (rotate) map.touchZoomRotate.enableRotation();
      else map.touchZoomRotate.disableRotation();
      applyDragAxes(map.dragRotate, { rotate, pitch });
      toggle(map.touchPitch, pitch);
      // The backstop: with pitch off no path can tilt the camera.
      map.setMaxPitch(pitch ? maxPitch : 0);
    });
  }, [map, pan, zoom, rotate, pitch, maxPitch]);
  return null;
}
