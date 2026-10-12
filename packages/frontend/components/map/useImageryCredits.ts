/**
 * The imagery credits owed for what the map shows right now — each source's
 * own short credit, linking to GoWay's attribution page, where every source's
 * licence notice is (`lib/map/imagerySources.ts`). `MapCanvas` (both forks)
 * passes them to `MapAttribution` beside the basemap's, so they ride in the
 * compact ⓘ credit with no prop to turn them off.
 *
 * Nothing is fetched or loaded until a map draws imagery: the coverage
 * document and the tree decoder (`lib/map/imageryCoverage.ts`) are a lazy
 * import, fetched once per page and kept five minutes.
 */
import { useEffect, useState } from 'react';

import type { MapImageryMode } from '@/lib/map/imagery';
import { IMAGERY_COVERAGE_PATH } from '@/lib/map/imagery';
import type { ImageryCoverage, ImageryView } from '@/lib/map/imageryCoverage';
import { IMAGERY_SOURCES } from '@/lib/map/imagerySources';
import {
  IMAGERY_ATTRIBUTION_HREF,
  type MapAttributionLink,
  resolveMapAssetUrl,
} from '@/lib/map/provider';

const NONE: readonly MapAttributionLink[] = [];
const COVERAGE_TTL_MS = 5 * 60_000;

let pending: { at: number; promise: Promise<ImageryCoverage | null> } | null = null;

/** The coverage document, parsed; `null` when it cannot be read (then nothing is drawn either). */
function loadCoverage(): Promise<ImageryCoverage | null> {
  if (pending && Date.now() - pending.at < COVERAGE_TTL_MS) return pending.promise;
  const promise = (async () => {
    const { parseImageryCoverage } = await import('@/lib/map/imageryCoverage');
    try {
      const response = await fetch(resolveMapAssetUrl(IMAGERY_COVERAGE_PATH));
      if (!response.ok) return null;
      return parseImageryCoverage(await response.json());
    } catch {
      return null;
    }
  })();
  pending = { at: Date.now(), promise };
  return promise;
}

function sameLinks(a: readonly MapAttributionLink[], b: readonly MapAttributionLink[]): boolean {
  return a.length === b.length && a.every((link, i) => link.label === b[i].label);
}

/**
 * @param mode - the imagery drawn, or `null` (then no credits and no fetch).
 * @param view - the settled camera: zoom and bounds, from the engine's own
 *   end-of-move event.
 */
export function useImageryCredits(
  mode: MapImageryMode | null,
  view: ImageryView | null,
): readonly MapAttributionLink[] {
  const [links, setLinks] = useState<readonly MapAttributionLink[]>(NONE);
  useEffect(() => {
    if (!mode || !view) return;
    let cancelled = false;
    void (async () => {
      const coverage = await loadCoverage();
      if (cancelled) return;
      const { imagerySourcesInView } = await import('@/lib/map/imageryCoverage');
      if (cancelled) return;
      const next = coverage
        ? imagerySourcesInView(coverage, view).map((id) => ({
            label: IMAGERY_SOURCES[id].credit,
            href: IMAGERY_ATTRIBUTION_HREF,
          }))
        : NONE;
      setLinks((current) => (sameLinks(current, next) ? current : next.length ? next : NONE));
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, view]);
  // No imagery drawn: nothing is owed, whatever the last view computed.
  return mode && view ? links : NONE;
}
