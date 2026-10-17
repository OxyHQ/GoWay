/**
 * One view drawn at a coordinate, web — a `maplibregl.Marker` whose DOM element
 * React portals the children into, so a marker on the web is the same
 * component as a marker on native.
 *
 * Centred on its coordinate, as Bloom's map markers are designed to be
 * (`@oxy.so/bloom/map-marker`: "centre a marker on its coordinate").
 */
import { type ReactNode, useContext, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';

import { type WebEngine, WebEngineContext } from './engineContext.web';
import { isDrawableCoordinate, reportMapDefect, runEngineCommand } from './shared';
import type { GeoCoordinate } from './types';

export interface MarkerProps {
  coordinate: GeoCoordinate;
  children: ReactNode;
}

export function Marker({ coordinate, children }: MarkerProps) {
  const engine = useContext(WebEngineContext);
  if (!engine) return null;
  // Undrawable pins never reach `setLngLat`, which throws on one.
  if (!isDrawableCoordinate(coordinate)) {
    reportMapDefect('marker:coordinate', 'Dropped a marker: its coordinate is not drawable.');
    return null;
  }
  return (
    <MarkerBinding engine={engine} coordinate={coordinate}>
      {children}
    </MarkerBinding>
  );
}

function MarkerBinding({
  engine,
  coordinate,
  children,
}: {
  engine: WebEngine;
  coordinate: GeoCoordinate;
  children: ReactNode;
}) {
  // The element the engine positions; the children are portalled into it.
  const [element] = useState(() => {
    const div = document.createElement('div');
    // The pill sizes itself; a fixed-size element would clip it.
    div.style.willChange = 'transform';
    return div;
  });
  const { latitude, longitude } = coordinate;
  // Binding: a `maplibregl.Marker` holds `element` at `coordinate` on the engine.
  useLayoutEffect(() => {
    const { map, markerElements } = engine;
    let marker: maplibregl.Marker | null = null;
    runEngineCommand('addMarker', () => {
      marker = new maplibregl.Marker({ element, anchor: 'center' })
        .setLngLat([longitude, latitude])
        .addTo(map);
    });
    markerElements.add(element);
    return () => {
      markerElements.delete(element);
      (marker as maplibregl.Marker | null)?.remove();
    };
  }, [engine, element, latitude, longitude]);
  return createPortal(children, element);
}
