/**
 * Reading the landmark registry at runtime, and the few questions the map and
 * the tour ask of it (`docs/MAP_LANDMARKS.md`).
 *
 * Import this ONLY with `import('@/lib/map/landmarks/load')`. Two lazy chunks
 * use it — the map adapter (`components/map/city3dLayer.web.ts`) and the tour
 * (`features/landmarks/`) — and a module two lazy chunks import STATICALLY is
 * hoisted by Expo's serializer into the first-paint `__common` chunk
 * (`~/Oxy/docs/build-and-runtime-traps.md` → Metro web chunking). Reached by
 * `import()` from both, it is an async chunk of its own instead
 * (`components/__tests__/landmarksChunk.test.ts`).
 *
 * The registry itself is not bundled at all: it is a static file beside the
 * GLBs (`public/landmarks/registry.json`), fetched once per page and parsed
 * with the same schema the build script validated it with. A file that fails
 * to parse draws no landmarks — the city's own buildings stay — and says so
 * once on the console.
 */
import { type ModelPlacement, parseModelPlacement } from '@goway.to/sdk';

import type { MapAttributionLink } from '../provider';
import { distanceMeters } from '../geo';
import {
  cityFeatureId,
  type LandmarkEntry,
  type LandmarkRegistry,
  parseLandmarkRegistry,
} from './registry';

export const LANDMARK_REGISTRY_PATH = '/landmarks/registry.json';

/** A registry entry made drawable: parsed placement, absolute URL, feature ids. */
export interface PreparedLandmark {
  entry: LandmarkEntry;
  placement: ModelPlacement;
  /** Absolute URL of the GLB. */
  url: string;
  /** City-tile feature ids of the buildings it replaces. */
  hides: number[];
}

let pending: Promise<readonly PreparedLandmark[]> | null = null;

/** The registry, fetched and prepared once per page. Never rejects: failure is `[]`. */
export function loadLandmarks(
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly PreparedLandmark[]> {
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetcher(`${origin}${LANDMARK_REGISTRY_PATH}`, {
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`registry answered ${response.status}`);
      return prepareLandmarks(parseLandmarkRegistry(await response.json()), origin);
    } catch (cause) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(`[goway/landmarks] no landmarks drawn: ${String(cause)}`);
      }
      pending = null;
      return [];
    }
  })();
  return pending;
}

/** Every entry, drawable. Entries whose placement does not parse are left out. */
export function prepareLandmarks(registry: LandmarkRegistry, origin: string): PreparedLandmark[] {
  const out: PreparedLandmark[] = [];
  for (const entry of registry.landmarks) {
    const placement = parseModelPlacement(entry.placement);
    if (!placement) continue;
    out.push({
      entry,
      placement,
      url: `${origin}${entry.model.path}`,
      hides: entry.osm.replaces.flatMap((element) => {
        const id = cityFeatureId(element);
        return id === null ? [] : [id];
      }),
    });
  }
  return out;
}

/** The landmarks within `radiusM` of `centre`, nearest first. */
export function landmarksNear(
  landmarks: readonly PreparedLandmark[],
  centre: { latitude: number; longitude: number },
  radiusM: number,
): PreparedLandmark[] {
  return landmarks
    .map((landmark) => ({ landmark, d: distanceMeters(centre, landmark.placement.position) }))
    .filter(({ d }) => d <= radiusM)
    .sort((a, b) => a.d - b.d)
    .map(({ landmark }) => landmark);
}

/**
 * The credits the data line owes for the landmarks DRAWN right now — a
 * CC BY author while their model is on screen, nothing for GoWay's own CC0
 * work (`docs/MAP_LANDMARKS.md` → Credits). De-duplicated by text.
 */
export function landmarkCredits(
  landmarks: readonly PreparedLandmark[],
  drawn: ReadonlySet<string>,
): MapAttributionLink[] {
  const out = new Map<string, MapAttributionLink>();
  for (const { entry } of landmarks) {
    if (!drawn.has(entry.id) || !entry.licence.credit) continue;
    out.set(entry.licence.credit, {
      label: entry.licence.credit,
      href: /^https:\/\//.test(entry.licence.source) ? entry.licence.source : 'https://goway.to',
    });
  }
  return [...out.values()];
}
