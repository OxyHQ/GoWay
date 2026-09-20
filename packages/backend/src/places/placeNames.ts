/**
 * Which of a place's names answers a requested locale — decided ONCE, here.
 *
 * Every read that takes a `locale` runs this function and nothing else. The
 * alternative is a fallback chain restated at each call site, and the failure
 * mode of that is not a crash: it is `/places/:id` and `/places/bounds`
 * disagreeing about what `es-MX` shows, so a pin and the sheet it opens are
 * labelled differently and the user assumes they tapped the wrong thing.
 *
 * ## The order, and the rung that is deliberately missing
 *
 *   1. the exact tag           `es-MX`
 *   2. the bare language       `es`
 *   3. any other variety of it `es-AR`, `es-419` — same language, different
 *                              spelling conventions, which is a far better
 *                              answer than none
 *   4. the place's DEFAULT name (`places.name`)
 *
 * There is no fifth rung, and the issue's sketch of "→ anything" is refused on
 * purpose. An arbitrary other language is not a better answer than the default:
 * the default is the name written on the shopfront, so a Spanish speaker in
 * Tokyo is better served by 東京都庁 — which matches the sign, the tile and
 * anyone they ask — than by whichever exonym happened to be recorded first.
 * Rung 4 is expressed by returning `undefined` here and letting the mapper omit
 * `localizedName`, so "we found nothing for your locale" and "we found the
 * default" are the same statement rather than two.
 *
 * ## Provenance breaks every tie
 *
 * Within a rung, a `goway` row beats every other source. That is the read half
 * of the guarantee the schema makes at write time: the importer cannot touch
 * the `goway` row, and a read never prefers the source's spelling over GoWay's
 * correction of it. After that, freshest wins, then the tag alphabetically — so
 * the answer is deterministic and a re-fetch does not reshuffle a label.
 */

import { baseLanguageTag, normalizeLanguageTag } from '@goway/shared-types';

/** GoWay's own corrections outrank every external source's spelling. */
const GOWAY_SOURCE = 'goway';

/** The fields resolution reads. Structural, so a row or a fixture both fit. */
export interface ResolvableName {
  language: string;
  name: string;
  source: string;
  observedAt: Date;
}

/**
 * Which rung of the chain a candidate sits on, or `undefined` for "not an
 * answer to this question at all".
 *
 * Lower is better, and the numbers are the documented order above.
 */
function rung(language: string, requested: string, base: string | undefined): number | undefined {
  if (language === requested) return 1;
  if (language === base) return 2;
  if (base !== undefined && baseLanguageTag(language) === base) return 3;
  return undefined;
}

/** `goway` first, then everything else. Not an ordering over external sources. */
function sourceRank(source: string): number {
  return source === GOWAY_SOURCE ? 0 : 1;
}

/**
 * The best name for `locale`, or `undefined` when the place has none in that
 * language and the caller should publish the default name instead.
 *
 * `locale` is normalized here rather than assumed normalized: this is called
 * with whatever the HTTP layer parsed, and a tag that is well-formed but not
 * canonical (`ES-mx`) must resolve exactly as its canonical form does.
 */
export function resolveLocalizedName<T extends ResolvableName>(
  names: readonly T[],
  locale: string | null | undefined,
): T | undefined {
  const requested = normalizeLanguageTag(locale);
  if (requested === undefined || names.length === 0) return undefined;
  const base = baseLanguageTag(requested);

  let best: T | undefined;
  let bestRung = Number.POSITIVE_INFINITY;

  for (const candidate of names) {
    const candidateRung = rung(candidate.language, requested, base);
    if (candidateRung === undefined) continue;
    if (best === undefined || candidateRung < bestRung) {
      best = candidate;
      bestRung = candidateRung;
      continue;
    }
    if (candidateRung > bestRung) continue;
    if (preferred(candidate, best)) best = candidate;
  }

  return best;
}

/** Within one rung: GoWay's correction, then the freshest, then the lowest tag. */
function preferred(candidate: ResolvableName, incumbent: ResolvableName): boolean {
  const bySource = sourceRank(candidate.source) - sourceRank(incumbent.source);
  if (bySource !== 0) return bySource < 0;
  const byFreshness = candidate.observedAt.getTime() - incumbent.observedAt.getTime();
  if (byFreshness !== 0) return byFreshness > 0;
  return candidate.language.localeCompare(incumbent.language) < 0;
}

/**
 * The order a place's names are PUBLISHED in: by language, then strongest
 * provenance first within a language, then freshest.
 *
 * The same shape `placeMapper` already gives capabilities, and for the same
 * reason — a consumer that takes the first row per language gets GoWay's
 * current answer without having to know the ranking.
 */
export function comparePublishedNames(left: ResolvableName, right: ResolvableName): number {
  return (
    left.language.localeCompare(right.language) ||
    sourceRank(left.source) - sourceRank(right.source) ||
    right.observedAt.getTime() - left.observedAt.getTime()
  );
}
