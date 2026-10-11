/**
 * The landmark registry for the tour UI: fetched once per page through the
 * registry's own lazy chunk (`lib/map/landmarks/load.ts` — never statically,
 * see its header), as the map adapter does.
 */
import { useEffect, useState } from 'react';

import type { PreparedLandmark } from '@/lib/map/landmarks/load';

const NONE: readonly PreparedLandmark[] = [];

export function useLandmarks(): readonly PreparedLandmark[] {
  const [landmarks, setLandmarks] = useState<readonly PreparedLandmark[]>(NONE);
  useEffect(() => {
    let live = true;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    void import('@/lib/map/landmarks/load')
      .then(({ loadLandmarks }) => loadLandmarks(origin))
      .then((list) => {
        if (live) setLandmarks(list);
      });
    return () => {
      live = false;
    };
  }, []);
  return landmarks;
}
