/**
 * The map's scale bar — Bloom's `MapScaleBar`, parked bottom-left above the
 * mark, in the units the reader's locale speaks.
 *
 * Rendered by `MapCanvas` itself, like the mark and the credit, so every map
 * GoWay draws has one. It re-renders on the scale store alone (`scaleFeed.ts`),
 * never with the screen around it.
 */
import { memo } from 'react';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { MapScaleBar } from '@oxy.so/bloom/map-attribution';

import { useBrandedChrome } from '@/components/brand';
import { useTranslation } from '@/lib/i18n';
import { CREDIT_GAP } from '@/lib/map/creditRise';
import { formatScale, scaleFor, scaleSystemFor, type MapScaleReading } from '@/lib/map/scale';

import { useMapChromeLift } from './chromeLift';
import { LiftedBox } from './MapAttribution';
import { MAP_BRAND_HEIGHT } from './MapBrand';
import { type MapCameraStore, useCameraValue } from './cameraFeed';

/** A sub-pixel difference is the same bar. */
function sameReading(a: MapScaleReading | null, b: MapScaleReading | null): boolean {
  if (!a || !b) return a === b;
  return a.unit === b.unit && a.value === b.value && Math.abs(a.width - b.width) < 0.5;
}

function MapScaleComponent({ camera }: { camera: MapCameraStore }) {
  const { locale } = useTranslation();
  const system = scaleSystemFor(locale);
  const reading = useCameraValue(
    camera,
    (viewport) => (viewport ? scaleFor(viewport.latitude, viewport.zoom, system) : null),
    sameReading,
  );
  const bottomEdge = useBottomEdgeInset();
  const chromeLift = useMapChromeLift();
  // Above the mark where it is drawn; the corner is free where the screen's
  // chrome carries the logo instead (`BrandedChromeProvider`).
  const brandDrawn = !useBrandedChrome();

  if (!reading) return null;

  const base = bottomEdge > 0 ? bottomEdge + CREDIT_GAP : CREDIT_GAP;
  return (
    <LiftedBox
      lift={chromeLift}
      className="absolute left-space-8 items-start"
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
