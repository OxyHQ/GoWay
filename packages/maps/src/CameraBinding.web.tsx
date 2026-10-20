/**
 * `MapView`'s `camera` target, web — framed whenever its VALUE changes.
 *
 * The camera is an imperative object behind maplibre-gl's `fitBounds`, and a
 * target that changes because the app's state changed — a place picked, a URL
 * arriving, back and forward — comes with no event this map handles. So the
 * one binding below applies it, keyed on the four numbers of the box (or the
 * point and zoom), never on the object: a re-render with an equal target does
 * nothing, and the map never moves under a reader who has panned.
 *
 * The first target is JUMPED to — the map opens on it. A later change
 * animates over `duration`. An engine rebuilt for a new style keeps the
 * camera it had, so an unchanged target is not applied to it again: changing
 * the map's look never moves the map.
 */
import { type RefObject, useLayoutEffect } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { cameraTargetKey } from './cameraTarget';
import { createWebMapApi } from './commands.web';
import type { MapCameraTarget } from './types';

export function CameraBinding({
  map,
  target,
  applied,
}: {
  map: MapLibreMap;
  target: MapCameraTarget;
  /** The target last applied, on ANY engine of this map — owned by `MapView`, which outlives them. */
  applied: RefObject<string | null>;
}) {
  const { bounds, center, zoom, padding, maxZoom, duration } = target;
  const key = cameraTargetKey({ bounds, center, zoom });
  // Binding: the engine's camera follows the VALUE of `camera` (`key`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the value the target stands for; a new object with the same numbers must not move the camera
  useLayoutEffect(() => {
    if (key === null || key === applied.current) return;
    const first = applied.current === null;
    applied.current = key;
    const api = createWebMapApi(() => map);
    const time = first ? 0 : duration;
    if (bounds) {
      api.fitBounds(bounds, {
        ...(padding !== undefined ? { padding } : {}),
        ...(maxZoom !== undefined ? { maxZoom } : {}),
        ...(time !== undefined ? { duration: time } : {}),
      });
    } else if (center) {
      api.moveTo(center, {
        ...(zoom !== undefined ? { zoom } : {}),
        ...(time !== undefined ? { duration: time } : {}),
      });
    }
  }, [map, key]);
  return null;
}
