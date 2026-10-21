/**
 * One source fed by several upstream feeds of the same operator — Renfe
 * publishes its commuter trains (Cercanías, Rodalies) and its regional,
 * long-distance and high-speed trains as two GTFS-Realtime feeds.
 *
 * Each feed is a PART with its own state:
 *
 * - a part that fails keeps what it last sent — its trains stay on the map,
 *   ageing out by their own fixes (`dropAfterSeconds`), rather than vanish
 *   while the source still says it is live — and the poll is marked
 *   `degraded`, which the hub logs and reports;
 * - a failed part backs off on its own, as long as its upstream asked
 *   (`Retry-After`) or exponentially, and is not asked again until then;
 * - a vehicle in more than one part (a Rodalies regional train also listed as
 *   Media Distancia) is drawn once, from the EARLIER part, by `keyOf` — the
 *   same one whether a later part answered or not.
 *
 * Only when every part fails, with nothing kept, does the poll fail.
 */
import type { LiveEntity } from '@goway/contracts';
import type { MatchHint } from '../staticGtfs';
import { LiveUpstreamError } from '../types';
import type { LiveAdapter, LiveFetchContext, LivePollResult } from '../types';

/** A failed part waits at least this long, doubling per failure, up to {@link PART_MAX_BACKOFF_MS}. */
export const PART_BASE_BACKOFF_MS = 20_000;
export const PART_MAX_BACKOFF_MS = 5 * 60_000;

interface Part {
  adapter: LiveAdapter;
  /** What it last answered: kept while it fails. */
  last: { entities: LiveEntity[]; hints: Map<string, MatchHint> } | null;
  failures: number;
  /** Not asked again before this (its backoff, or its upstream's `Retry-After`). */
  dueAt: number;
  lastError: unknown;
}

export function createCombinedAdapter(
  adapters: readonly LiveAdapter[],
  keyOf: (entity: LiveEntity) => string,
): LiveAdapter {
  const parts: Part[] = adapters.map((adapter) => ({
    adapter,
    last: null,
    failures: 0,
    dueAt: 0,
    lastError: null,
  }));
  return {
    async poll(context: LiveFetchContext): Promise<LivePollResult> {
      const now = context.now();
      let rejected = 0;
      let backoffSeconds: number | undefined;
      await Promise.all(
        parts.map(async (part) => {
          if (now < part.dueAt) return; // backing off: what it last sent stands
          try {
            const result = await part.adapter.poll(context);
            part.last = { entities: result.entities, hints: result.hints ?? new Map() };
            part.failures = 0;
            part.lastError = null;
            part.dueAt = result.backoffSeconds ? now + result.backoffSeconds * 1000 : 0;
            rejected += result.rejected;
            if (result.backoffSeconds !== undefined)
              backoffSeconds = Math.max(backoffSeconds ?? 0, result.backoffSeconds);
          } catch (error) {
            part.failures++;
            part.lastError = error;
            const asked =
              error instanceof LiveUpstreamError && error.retryAfterSeconds !== null
                ? error.retryAfterSeconds * 1000
                : 0;
            const backoff = Math.min(
              PART_MAX_BACKOFF_MS,
              PART_BASE_BACKOFF_MS * 2 ** (part.failures - 1),
            );
            part.dueAt = now + Math.max(asked, backoff);
          }
        }),
      );

      const failing = parts.filter((part) => part.failures > 0);
      if (failing.length === parts.length && parts.every((part) => part.last === null))
        throw failing[failing.length - 1]?.lastError;

      const entities: LiveEntity[] = [];
      const hints = new Map<string, MatchHint>();
      const seen = new Set<string>();
      for (const part of parts) {
        for (const entity of part.last?.entities ?? []) {
          const key = keyOf(entity);
          if (seen.has(key)) continue;
          seen.add(key);
          entities.push(entity);
          const hint = part.last?.hints.get(entity.id);
          if (hint) hints.set(entity.id, hint);
        }
      }
      return {
        entities,
        rejected,
        hints,
        ...(backoffSeconds !== undefined ? { backoffSeconds } : {}),
        ...(failing.length > 0
          ? {
              degraded: `${failing.length} of ${parts.length} feeds not answering: ${describe(failing[0]?.lastError)}`,
            }
          : {}),
      };
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 160);
  return String(error).slice(0, 160);
}
