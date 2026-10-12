/**
 * The landmarks the tour UI may offer: the registry, fetched once per page
 * through its own lazy chunk (`lib/map/landmarks/load.ts` — never statically,
 * see its header), as the map adapter does — kept to those the map can draw
 * right now (`offerLandmarks`: over published city tiles, the 3D city on).
 * Nothing published, nothing offered: no pill and no tour.
 */
import { useEffect, useMemo, useState } from 'react';

import type { PreparedLandmark } from '@/lib/map/landmarks/load';

const NONE: readonly PreparedLandmark[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

export function useLandmarks(): readonly PreparedLandmark[] {
  const [landmarks, setLandmarks] = useState<readonly PreparedLandmark[]>(NONE);
  const [offered, setOffered] = useState<ReadonlySet<string>>(NO_IDS);
  useEffect(() => {
    let live = true;
    let unsubscribe: (() => void) | null = null;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    void import('@/lib/map/landmarks/load').then((module) => {
      if (!live) return;
      unsubscribe = module.subscribeOfferedLandmarks((ids) => setOffered(ids));
      void module.loadLandmarks(origin).then((list) => {
        if (live) setLandmarks(list);
      });
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);
  return useMemo(
    () => (offered.size === 0 ? NONE : landmarks.filter(({ entry }) => offered.has(entry.id))),
    [landmarks, offered],
  );
}
