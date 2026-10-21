/**
 * The style document the native map is handed: the published URL as it is,
 * or — while the quality profile asks for Standard's density — the document
 * fetched and folded through the SAME function the web folds it through
 * (`qualityOverrides.ts` → `withQualityOverrides`), handed to `<Map mapStyle>`
 * as an object. MapLibre Native cannot restyle a loaded document at runtime
 * from React, so the document itself is what changes.
 *
 * Until the folded document arrives (and if it cannot be fetched), the URL:
 * the map is never held back for a density.
 */
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { useEffect, useState } from 'react';

import { hasQualityOverrides, withQualityOverrides } from './qualityOverrides';

export function useStyleDocument(
  url: string,
  standardDensity: boolean,
): string | StyleSpecification {
  const [folded, setFolded] = useState<{ url: string; style: StyleSpecification } | null>(null);
  useEffect(() => {
    if (!standardDensity) return;
    let cancelled = false;
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<StyleSpecification>;
      })
      .then((style) => {
        // A document with nothing to fold stays the URL (the same map, no reload).
        if (!cancelled && hasQualityOverrides(style)) {
          setFolded({ url, style: withQualityOverrides(style) });
        }
      })
      .catch(() => {
        // The published document, dense, is still the map.
      });
    return () => {
      cancelled = true;
    };
  }, [url, standardDensity]);
  return standardDensity && folded?.url === url ? folded.style : url;
}
