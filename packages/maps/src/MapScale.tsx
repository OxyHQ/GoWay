/**
 * The map's scale bar — Bloom's `MapScaleBar`, parked bottom-left above the
 * mark, in the units the reader's locale speaks (miles in the US, Liberia and
 * Myanmar; metres elsewhere).
 *
 * Drawn by `MapView` itself, like the mark and the credit, so every map has
 * one. It re-renders on its own value alone (`cameraStore.ts`), never with the
 * screen around the map.
 */
import { memo } from 'react';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { useBloomLocale } from '@oxy.so/bloom/locale';
import { MapScaleBar } from '@oxy.so/bloom/map-attribution';

import { useBrandedChrome } from './brand/BrandedChrome';
import { useMapCamera } from './cameraStore';
import { useMapChromeLift } from './chromeLift';
import { CREDIT_GAP } from './creditRise';
import { LiftedBox } from './LiftedBox';
import { MAP_BRAND_HEIGHT } from './MapBrand';
import { formatScale, type MapScaleReading, scaleFor, scaleSystemFor } from './scale';

/** A sub-pixel difference is the same bar. */
function sameReading(a: MapScaleReading | null, b: MapScaleReading | null): boolean {
  if (!a || !b) return a === b;
  return a.unit === b.unit && a.value === b.value && Math.abs(a.width - b.width) < 0.5;
}

function MapScaleComponent() {
  const locale = useBloomLocale() ?? 'en';
  const system = scaleSystemFor(locale);
  const reading = useMapCamera(
    (viewport) => (viewport ? scaleFor(viewport.latitude, viewport.zoom, system) : null),
    sameReading,
  );
  const bottomEdge = useBottomEdgeInset();
  const chromeLift = useMapChromeLift();
  // Above the mark where it is drawn; the corner is free where the app's own
  // chrome carries the logo instead.
  const brandDrawn = !useBrandedChrome();

  if (!reading) return null;

  const base = bottomEdge > 0 ? bottomEdge + CREDIT_GAP : CREDIT_GAP;
  return (
    <LiftedBox
      side="left"
      lift={chromeLift}
      style={{ bottom: brandDrawn ? base + MAP_BRAND_HEIGHT + CREDIT_GAP : base }}
    >
      <MapScaleBar
        scales={[{ width: reading.width, label: formatScale(reading, locale) }]}
        testID="map-scale"
      />
    </LiftedBox>
  );
}

export const MapScale = memo(MapScaleComponent);
