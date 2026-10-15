/**
 * The source credits owed for what the map shows right now — the satellite
 * imagery's (`lib/map/imagerySources.ts`) and GoWay's own terrain's
 * (`lib/map/terrainSources.ts`), each source's own short credit linking to
 * GoWay's attribution page, where its licence notice is. `MapCanvas` (both
 * forks) passes them to `MapAttribution` beside the basemap's, so they ride
 * in the compact ⓘ credit with no prop to turn them off.
 *
 * Nothing is fetched or loaded until a map draws the family: the coverage
 * document and the tree decoder (`lib/map/rasterCoverage.ts`) are a lazy
 * import, fetched once per page and kept five minutes.
 */
import { useEffect, useState } from 'react';

import type { MapImageryMode } from '@/lib/map/imagery';
import { IMAGERY_COVERAGE_PATH } from '@/lib/map/imagery';
import { IMAGERY_SOURCES } from '@/lib/map/imagerySources';
import {
  IMAGERY_ATTRIBUTION_HREF,
  type MapAttributionLink,
  resolveMapAssetUrl,
  TERRAIN_ATTRIBUTION_LINK,
} from '@/lib/map/provider';
import type { CoverageView } from '@/lib/map/rasterCoverage';
import { TERRAIN_SOURCES } from '@/lib/map/terrainSources';

const NONE: readonly MapAttributionLink[] = [];
const COVERAGE_TTL_MS = 5 * 60_000;
/** The terrain family's document — `TERRAIN_COVERAGE_PATH`, spelled here so the pure module stays lazy. */
const TERRAIN_COVERAGE_PATH = '/map/terrain/coverage.json';

/** A family: where its coverage is, and how its on-screen sources become links (lazy). */
interface Family {
  path: string;
  links: (document: unknown, view: CoverageView) => Promise<readonly MapAttributionLink[]>;
}

const FAMILIES = {
  imagery: {
    path: IMAGERY_COVERAGE_PATH,
    async links(document, view) {
      const { imagerySourcesInView, parseImageryCoverage } = await import(
        '@/lib/map/imageryCoverage'
      );
      return imagerySourcesInView(parseImageryCoverage(document), view).map((id) => ({
        label: IMAGERY_SOURCES[id].credit,
        href: IMAGERY_ATTRIBUTION_HREF,
      }));
    },
  },
  terrain: {
    path: TERRAIN_COVERAGE_PATH,
    async links(document, view) {
      const { parseTerrainCoverage, terrainSourcesInView } = await import(
        '@/lib/map/terrainCoverage'
      );
      return terrainSourcesInView(parseTerrainCoverage(document), view).map((id) => ({
        label: TERRAIN_SOURCES[id].credit,
        href: TERRAIN_ATTRIBUTION_LINK.href,
      }));
    },
  },
} satisfies Record<string, Family>;

type FamilyId = keyof typeof FAMILIES;

const pending = new Map<FamilyId, { at: number; promise: Promise<unknown | null> }>();

/** A family's coverage document; `null` when it cannot be read (then nothing of it is drawn either). */
function loadCoverage(family: FamilyId): Promise<unknown | null> {
  const known = pending.get(family);
  if (known && Date.now() - known.at < COVERAGE_TTL_MS) return known.promise;
  const promise = (async () => {
    try {
      const response = await fetch(resolveMapAssetUrl(FAMILIES[family].path));
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  })();
  pending.set(family, { at: Date.now(), promise });
  return promise;
}

function sameLinks(a: readonly MapAttributionLink[], b: readonly MapAttributionLink[]): boolean {
  return a.length === b.length && a.every((link, i) => link.label === b[i].label);
}

function useSourceCredits(
  family: FamilyId,
  drawn: boolean,
  view: CoverageView | null,
): readonly MapAttributionLink[] {
  const [links, setLinks] = useState<readonly MapAttributionLink[]>(NONE);
  useEffect(() => {
    if (!drawn || !view) return;
    let cancelled = false;
    void (async () => {
      const document = await loadCoverage(family);
      if (cancelled) return;
      const next = document ? await FAMILIES[family].links(document, view) : NONE;
      if (cancelled) return;
      setLinks((current) => (sameLinks(current, next) ? current : next.length ? next : NONE));
    })();
    return () => {
      cancelled = true;
    };
  }, [family, drawn, view]);
  // Nothing of the family drawn: nothing is owed, whatever the last view computed.
  return drawn && view ? links : NONE;
}

/**
 * @param mode - the imagery drawn, or `null` (then no credits and no fetch).
 * @param view - the settled camera: zoom and bounds, from the engine's own
 *   end-of-move event.
 */
export function useImageryCredits(
  mode: MapImageryMode | null,
  view: CoverageView | null,
): readonly MapAttributionLink[] {
  return useSourceCredits('imagery', mode !== null, view);
}

/**
 * @param drawn - whether the map draws elevation (3D terrain or a hillshade);
 *   false: no credits and no fetch.
 * @param view - the settled camera.
 */
export function useTerrainCredits(
  drawn: boolean,
  view: CoverageView | null,
): readonly MapAttributionLink[] {
  return useSourceCredits('terrain', drawn, view);
}
