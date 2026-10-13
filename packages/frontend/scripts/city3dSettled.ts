/**
 * When the 3D city is SETTLED — what the visibility gate
 * (`check-city3d-visible.ts`) waits for before it looks at the screen, as one
 * pure predicate over what a development build publishes:
 *
 *  - the city (`__gowayCity3d`): it wants tiles, every one is loaded at its
 *    selected level, none is pending or queued for upload;
 *  - the street detail (`__gowayCityStreets`), when the view draws it: every
 *    tile it wants is answered (meshed, or known empty) and none is pending.
 *    "Some tile drawn" was not enough, and a throttled report could leave a
 *    stale `pending` behind for good (`streetRenderer.ts` → `statsDue`);
 *  - a landmark (`__gowayLandmarks`), when the view expects one: the registry
 *    is read, the engine holds it, and its model is drawn — or failed, which
 *    is settled too (the city's buildings stay; the gate's assertion then
 *    says what is wrong, rather than a timeout).
 */
export interface PublishedStats {
  city?: {
    tilesWanted: number;
    tilesLoaded: number;
    tilesPending: number;
    uploadsQueued?: number;
  };
  streets?: { tilesWanted?: number; tilesSettled?: number; pending: number };
  landmarks?: { loaded: boolean; held: string[]; drawn: string[]; failed: string[] };
}

export interface SettledWants {
  streets: boolean;
  /** The landmark id the view expects drawn, or `null`. */
  landmark: string | null;
}

/** Why the view is not settled yet (`null`: settled). */
export function unsettled(stats: PublishedStats, wants: SettledWants): string | null {
  const c = stats.city;
  if (!c) return 'city: no stats';
  if (c.tilesWanted <= 0) return 'city: wants no tiles';
  if (c.tilesPending > 0) return `city: ${c.tilesPending} pending`;
  if ((c.uploadsQueued ?? 0) > 0) return `city: ${c.uploadsQueued} queued for upload`;
  if (c.tilesLoaded !== c.tilesWanted) return `city: ${c.tilesLoaded}/${c.tilesWanted} loaded`;
  if (wants.streets) {
    const s = stats.streets;
    if (!s) return 'streets: no stats';
    if (s.pending > 0) return `streets: ${s.pending} pending`;
    if (s.tilesWanted === undefined || s.tilesSettled === undefined) {
      return 'streets: no settled count';
    }
    if (s.tilesWanted <= 0) return 'streets: want no tiles';
    if (s.tilesSettled !== s.tilesWanted) {
      return `streets: ${s.tilesSettled}/${s.tilesWanted} answered`;
    }
  }
  if (wants.landmark) {
    const l = stats.landmarks;
    const id = wants.landmark;
    if (!l?.loaded) return 'landmarks: registry not read';
    if (l.failed.includes(id)) return null;
    if (!l.held.includes(id)) return `landmarks: ${id} not held`;
    if (!l.drawn.includes(id)) return `landmarks: ${id} not drawn`;
  }
  return null;
}
