/**
 * Coalescing "which of my lists hold this place?" questions into batched reads.
 *
 * Kept apart from `saved.ts` (which needs the app's client and so its React
 * Native runtime) so the batching can be tested on its own.
 */
import { MAX_SAVED_PLACES_LOOKUP } from '@goway.to/sdk';
import type { SavedPlace, SavedPlaces } from '@goway.to/sdk';

/** How long the questions of one render pass are held to travel together. */
const HOLD_BATCH_WINDOW_MS = 12;

type FetchHolds = (placeIds: readonly string[]) => Promise<SavedPlaces>;

interface Waiter {
  resolve: (hold: SavedPlace | null) => void;
  reject: (error: unknown) => void;
}

/**
 * Coalesce "which of my lists hold this place?" questions into batched reads.
 *
 * A place asked about twice in one window is sent once and both askers are
 * answered. A place the person has not saved is answered `null`. A failed
 * request rejects every asker it carried, so none waits forever.
 */
export function createHoldBatcher(
  fetchHolds: FetchHolds,
  windowMs = HOLD_BATCH_WINDOW_MS,
): (placeId: string) => Promise<SavedPlace | null> {
  let waiting = new Map<string, Waiter[]>();
  let scheduled = false;

  async function flush(): Promise<void> {
    const batch = waiting;
    waiting = new Map();
    scheduled = false;
    const ids = [...batch.keys()];
    for (let start = 0; start < ids.length; start += MAX_SAVED_PLACES_LOOKUP) {
      const chunk = ids.slice(start, start + MAX_SAVED_PLACES_LOOKUP);
      try {
        const answer = await fetchHolds(chunk);
        const byId = new Map(answer.items.map((hold) => [hold.placeId, hold]));
        for (const id of chunk) {
          for (const waiter of batch.get(id) ?? []) waiter.resolve(byId.get(id) ?? null);
        }
      } catch (error) {
        for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.reject(error);
      }
    }
  }

  return (placeId) =>
    new Promise<SavedPlace | null>((resolve, reject) => {
      const askers = waiting.get(placeId) ?? [];
      askers.push({ resolve, reject });
      waiting.set(placeId, askers);
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => void flush(), windowMs);
      }
    });
}
