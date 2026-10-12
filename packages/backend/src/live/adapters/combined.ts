/**
 * One source fed by several upstream feeds of the same operator — Renfe
 * publishes its commuter trains (Cercanías, Rodalies) and its regional,
 * long-distance and high-speed trains as two GTFS-Realtime feeds.
 *
 * Every feed is polled each time; a vehicle in more than one (a Rodalies
 * regional train also listed as Media Distancia) is drawn once, from the
 * EARLIER feed in the list, by `keyOf`. A feed that fails does not take the
 * others down; only when every feed fails does the poll fail (and back off).
 */
import type { LiveEntity } from '@goway/contracts';
import type { MatchHint } from '../staticGtfs';
import type { LiveAdapter, LiveFetchContext, LivePollResult } from '../types';

export function createCombinedAdapter(
  adapters: readonly LiveAdapter[],
  keyOf: (entity: LiveEntity) => string,
): LiveAdapter {
  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      const results = await Promise.allSettled(adapters.map((adapter) => adapter.poll(context)));
      const entities: LiveEntity[] = [];
      const hints = new Map<string, MatchHint>();
      const seen = new Set<string>();
      let rejected = 0;
      let answered = 0;
      let backoffSeconds: number | undefined;
      let lastError: unknown = null;
      for (const result of results) {
        if (result.status === 'rejected') {
          lastError = result.reason;
          continue;
        }
        answered++;
        rejected += result.value.rejected;
        if (result.value.backoffSeconds !== undefined)
          backoffSeconds = Math.max(backoffSeconds ?? 0, result.value.backoffSeconds);
        for (const entity of result.value.entities) {
          const key = keyOf(entity);
          if (seen.has(key)) continue;
          seen.add(key);
          entities.push(entity);
          const hint = result.value.hints?.get(entity.id);
          if (hint) hints.set(entity.id, hint);
        }
      }
      if (answered === 0) throw lastError;
      return {
        entities,
        rejected,
        hints,
        ...(backoffSeconds !== undefined ? { backoffSeconds } : {}),
      };
    },
  };
}
