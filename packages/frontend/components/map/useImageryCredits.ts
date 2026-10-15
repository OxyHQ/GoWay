/**
 * The imagery credits owed for what the map shows right now — each source's
 * own short credit, linking to GoWay's attribution page, where every source's
 * licence notice is (`lib/map/imagerySources.ts`). `MapCanvas` (both forks)
 * passes them to `MapAttribution` beside the basemap's, so they ride in the
 * compact ⓘ credit with no prop to turn them off.
 *
 * The rule is `imageryCreditSources` (`lib/map/imageryCoverage.ts`): the
 * sources on screen once the coverage and the view are known, and EVERY
 * source until then — on the first frame, while the coverage loads, and if it
 * cannot be read. A source drawn uncredited breaks its licence; one credited
 * a moment early breaks nothing.
 *
 * Nothing is fetched until a map draws imagery: the coverage document and the
 * tree decoder are a lazy import, fetched once per page and kept five minutes
 * — a failed fetch is not kept, so the next settled camera asks again.
 */
import { useEffect, useMemo, useState } from 'react';

import type { MapImageryMode } from '@/lib/map/imagery';
import { IMAGERY_COVERAGE_PATH } from '@/lib/map/imagery';
import type { ImageryCoverage, ImageryView } from '@/lib/map/imageryCoverage';
import { IMAGERY_SOURCES, type ImagerySourceId } from '@/lib/map/imagerySources';
import {
  IMAGERY_ATTRIBUTION_HREF,
  type MapAttributionLink,
  resolveMapAssetUrl,
} from '@/lib/map/provider';

const NONE: readonly MapAttributionLink[] = [];
const COVERAGE_TTL_MS = 5 * 60_000;

let pending: { at: number; promise: Promise<ImageryCoverage | null> } | null = null;

/**
 * The coverage document, parsed; `null` when it cannot be read. A success is
 * kept {@link COVERAGE_TTL_MS}; a failure is not kept at all.
 */
export function loadImageryCoverage(): Promise<ImageryCoverage | null> {
  if (pending && Date.now() - pending.at < COVERAGE_TTL_MS) return pending.promise;
  const promise = (async () => {
    try {
      const { parseImageryCoverage } = await import('@/lib/map/imageryCoverage');
      const response = await fetch(resolveMapAssetUrl(IMAGERY_COVERAGE_PATH));
      if (!response.ok) return null;
      return parseImageryCoverage(await response.json());
    } catch {
      return null;
    }
  })();
  const entry = { at: Date.now(), promise };
  pending = entry;
  void promise.then((coverage) => {
    if (!coverage && pending === entry) pending = null;
  });
  return promise;
}

/** For tests: forget the page's coverage. */
export function forgetImageryCoverage(): void {
  pending = null;
}

/**
 * The sources to credit for `view` — the coverage loaded (or not) and
 * `imageryCreditSources` applied: every source while it cannot be read.
 */
export async function imageryCreditsFor(view: ImageryView | null): Promise<ImagerySourceId[]> {
  const coverage = await loadImageryCoverage();
  const { imageryCreditSources } = await import('@/lib/map/imageryCoverage');
  return imageryCreditSources(coverage, view);
}

/**
 * The links for `sources` — every source GoWay may serve when they are not
 * known yet (`null`), nothing when no imagery is drawn.
 */
export function imageryCreditLinks(
  mode: MapImageryMode | null,
  sources: readonly ImagerySourceId[] | null,
): readonly MapAttributionLink[] {
  if (!mode) return NONE;
  const ids = sources ?? (Object.keys(IMAGERY_SOURCES) as ImagerySourceId[]);
  return ids.map((id) => ({ label: IMAGERY_SOURCES[id].credit, href: IMAGERY_ATTRIBUTION_HREF }));
}

function sameSources(a: readonly ImagerySourceId[] | null, b: readonly ImagerySourceId[]) {
  return a !== null && a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * @param mode - the imagery drawn, or `null` (then no credits and no fetch).
 * @param view - the camera, from the engine once the map is up and at every
 *   settled move (`imageryViewOf`); `null` before the first.
 */
export function useImageryCredits(
  mode: MapImageryMode | null,
  view: ImageryView | null,
): readonly MapAttributionLink[] {
  // `null`: not known yet, so every source is credited.
  const [sources, setSources] = useState<readonly ImagerySourceId[] | null>(null);
  useEffect(() => {
    if (!mode) return;
    let cancelled = false;
    void (async () => {
      const next = await imageryCreditsFor(view);
      if (cancelled) return;
      setSources((current) => (sameSources(current, next) ? current : next));
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, view]);
  return useMemo(() => imageryCreditLinks(mode, sources), [mode, sources]);
}
