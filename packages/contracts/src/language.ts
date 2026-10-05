/**
 * Language tags, in exactly one spelling.
 *
 * A place name is stored, keyed, upserted, compared and published under a
 * language tag, so the tag's canonical form is part of the contract rather than
 * a detail of whichever layer happened to write it. `es` and `ES`, `zh-hant`
 * and `zh-Hant`, `ca_valencia` and `ca-valencia` all name one language; stored
 * verbatim they are four rows, four cache keys and four chances for a
 * re-import to add a duplicate instead of refreshing what is there.
 *
 * {@link normalizeLanguageTag} is therefore the ONLY way a tag enters GoWay,
 * and {@link LANGUAGE_TAG_PATTERN} is the shape it comes out as — the same
 * pattern the `places_names.language` CHECK enforces, so a tag the database
 * would refuse is refused at the edge instead.
 *
 * ## Why the primary subtag is restricted to two or three letters
 *
 * BCP 47 also reserves four-letter and registers five-to-eight-letter primary
 * subtags. None is assigned, and admitting them would make this function say
 * yes to OpenStreetMap keys that are not languages at all: `name:left`,
 * `name:right`, `name:signed` and `name:prefix` are all well-formed under the
 * wider rule and none of them is a translation. An importer that trusted the
 * wider rule would file "left" as a language and put a street's left-hand-side
 * label into the map's vocabulary.
 */

import { z } from 'zod';

/**
 * The canonical shape a normalized tag has: `es`, `zh-Hant`, `en-GB`,
 * `es-419`, `ca-valencia`, `zh-Hant-HK`.
 *
 * Deliberately a SUBSET of BCP 47 — language, script, region and variants, and
 * no extension or private-use sequences. GoWay has no use for `en-u-ca-gregory`
 * as a name key, and every subtag this admits is one OpenStreetMap actually
 * carries in a `name:*` key.
 */
export const LANGUAGE_TAG_PATTERN =
  /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-(?:[0-9][a-z0-9]{3}|[a-z0-9]{5,8}))*$/;

/** The same pattern as a string, for a database CHECK or another regex engine. */
export const LANGUAGE_TAG_SQL_PATTERN =
  '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?(-([0-9][a-z0-9]{3}|[a-z0-9]{5,8}))*$';

/** The longest tag GoWay will store. Far past anything the subset above can spell. */
export const MAX_LANGUAGE_TAG_LENGTH = 35;

/**
 * A language tag in canonical form, or `undefined` when the input is not one.
 *
 * `undefined` rather than a throw or a best-effort guess: the caller is
 * typically an importer reading a key it did not choose, and the right response
 * to `name:etymology` is to skip that key, not to fail the element or to file
 * it under a made-up language.
 *
 * Underscore is accepted as a separator on the way IN — OpenStreetMap carries
 * `name:zh_pinyin` beside `name:zh-Hant` — and never emitted.
 */
export function normalizeLanguageTag(tag: string | null | undefined): string | undefined {
  if (typeof tag !== 'string') return undefined;
  const trimmed = tag.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LANGUAGE_TAG_LENGTH) return undefined;

  const parts = trimmed.split(/[-_]/);
  const [primary, ...rest] = parts;
  if (primary === undefined || !/^[A-Za-z]{2,3}$/.test(primary)) return undefined;

  const canonical: string[] = [primary.toLowerCase()];
  let index = 0;

  // Script: four letters, Titlecase. At most one, and only immediately after
  // the language — `zh-Hant`, never `zh-GB-Hant`.
  const script = rest[index];
  if (script !== undefined && /^[A-Za-z]{4}$/.test(script)) {
    canonical.push(script[0]!.toUpperCase() + script.slice(1).toLowerCase());
    index += 1;
  }

  // Region: two letters UPPER, or three digits (a UN M.49 area such as `419`).
  const region = rest[index];
  if (region !== undefined && /^([A-Za-z]{2}|[0-9]{3})$/.test(region)) {
    canonical.push(/^[0-9]{3}$/.test(region) ? region : region.toUpperCase());
    index += 1;
  }

  // Variants: five-to-eight alphanumerics, or four starting with a digit.
  for (; index < rest.length; index += 1) {
    const variant = rest[index];
    if (variant === undefined || !/^([0-9][A-Za-z0-9]{3}|[A-Za-z0-9]{5,8})$/.test(variant)) {
      return undefined;
    }
    canonical.push(variant.toLowerCase());
  }

  const result = canonical.join('-');
  // Belt and braces: the assembled tag is held to the very pattern the database
  // enforces, so no path can produce a value the CHECK would then refuse.
  return LANGUAGE_TAG_PATTERN.test(result) ? result : undefined;
}

/**
 * The language a tag is a variety of: `es-419` and `es-ES` are both `es`.
 *
 * Returns the tag itself when it is already bare, and `undefined` when it is
 * not a tag at all — so `baseLanguageTag` can be called on untrusted input
 * without a normalization step in front of it.
 */
export function baseLanguageTag(tag: string | null | undefined): string | undefined {
  const normalized = normalizeLanguageTag(tag);
  if (normalized === undefined) return undefined;
  return normalized.split('-')[0];
}

/**
 * A language tag as a request carries it: trimmed, normalized by
 * {@link normalizeLanguageTag}, and refused when it is not one.
 *
 * Every `locale` parameter and every written name's `language` goes through
 * this one schema, so `?locale=ES` and `?locale=es` are one cache key and one
 * resolution, and a tag the `places_names.language` CHECK would refuse is a
 * 422 naming the field rather than a 500 naming a constraint.
 */
export const languageTagSchema = z
  .string()
  .trim()
  .max(MAX_LANGUAGE_TAG_LENGTH)
  .transform((value, context) => {
    const normalized = normalizeLanguageTag(value);
    if (normalized === undefined) {
      context.addIssue({ code: 'custom', message: 'must be a BCP 47 language tag' });
      return z.NEVER;
    }
    return normalized;
  });

/** A language tag as a response publishes it: already canonical. */
export const canonicalLanguageTagSchema = z.string().regex(LANGUAGE_TAG_PATTERN);

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * The script a language is written in when its tag does not say.
 *
 * CLDR's likely subtags, cut down to what matching needs: the languages GoWay
 * labels in. A language missing here has an UNKNOWN script, and an unknown
 * script conflicts with nothing — so leaving a language out can only make a
 * match more permissive, never refuse one.
 */
const LIKELY_SCRIPTS: Readonly<Record<string, string>> = {
  ar: 'Arab',
  bn: 'Beng',
  ca: 'Latn',
  de: 'Latn',
  en: 'Latn',
  es: 'Latn',
  fr: 'Latn',
  hi: 'Deva',
  ja: 'Jpan',
  pt: 'Latn',
  ru: 'Cyrl',
  zh: 'Hans',
};

/** The regions that write a language in a script other than its likely one. */
const LIKELY_SCRIPTS_BY_REGION: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  zh: { TW: 'Hant', HK: 'Hant', MO: 'Hant' },
};

interface Subtags {
  readonly language: string;
  readonly script: string | undefined;
  readonly region: string | undefined;
  readonly variants: readonly string[];
}

/** A CANONICAL tag split into its parts, the script filled in when it is likely. */
function subtagsOf(tag: string): Subtags {
  const [language = tag, ...rest] = tag.split('-');
  const explicitScript = /^[A-Z][a-z]{3}$/.test(rest[0] ?? '') ? rest.shift() : undefined;
  const region = /^([A-Z]{2}|[0-9]{3})$/.test(rest[0] ?? '') ? rest.shift() : undefined;
  const script =
    explicitScript ??
    (region === undefined ? undefined : LIKELY_SCRIPTS_BY_REGION[language]?.[region]) ??
    LIKELY_SCRIPTS[language];
  return { language, script, region, variants: rest };
}

/**
 * How well an offered tag serves a requested one that it is not identical to;
 * lower is better, `undefined` is "not at all".
 *
 * Only the same language is an answer. The reader's own script always wins,
 * but another script of the same language still beats the caller's fallback:
 * a `zh-TW` reader gets `zh-Hant` when it is offered and `zh-Hans` when it is
 * not, never English (a product decision: Simplified is far more legible to a
 * Traditional reader than English). Within each script, by region —
 *
 *   1. the reader's own      `es-MX` for `es-MX-…`
 *   2. none at all           `es` for `es-MX`, `zh-Hans` for `zh-CN`
 *   3. another one           `pt-BR` for `pt-PT`
 *
 * and within each, an offer carrying the variant the reader asked for, then
 * one with no variant, then one naming a variant the reader did not ask for —
 * so `ca-valencia` answers `ca-ES-valencia` and `ca` answers `ca-ES`.
 */
function matchRank(offered: Subtags, requested: Subtags): number | undefined {
  if (offered.language !== requested.language) return undefined;
  const scriptRank =
    offered.script !== undefined && requested.script !== undefined && offered.script !== requested.script ? 1 : 0;
  const regionRank = offered.region === undefined ? 2 : offered.region === requested.region ? 1 : 3;
  const variantRank = offered.variants.some((variant) => !requested.variants.includes(variant))
    ? 2
    : offered.variants.length > 0
      ? 0
      : 1;
  return scriptRank * 12 + regionRank * 3 + variantRank;
}

/**
 * The tag among `offered` that best serves a reader of `locale`, or
 * `undefined` when none does and the caller should use its own fallback.
 *
 * A BCP 47 best match, in this order:
 *
 *   1. the exact tag                     `pt-BR` → `pt-BR`
 *   2. the same language and script, preferring the reader's own region, then
 *      a tag with no region, then any other region
 *                                        `zh-Hans-CN`, `zh-CN`, `zh-SG`, `zh`
 *                                        → `zh-Hans`; `pt`, `pt-PT` → `pt-BR`;
 *                                        `es-MX` → `es`
 *   3. the same language in another script, ranked the same way by region —
 *      `zh-Hant`, `zh-TW` and `zh-HK` read `zh-Hans` when no Traditional tag
 *      is offered. This departs from CLDR (whose `zh-Hant` does not inherit
 *      from `zh`) on purpose: Simplified beats English for those readers.
 *   4. nothing — the caller uses its own fallback.
 *
 * The script comes from the tag when it names one and from CLDR's likely
 * subtags when it does not (`zh-TW` is `Hant`, `zh` is `Hans`). Ties go to
 * the earlier entry of `offered`.
 *
 * Both sides are normalized here, so `ZH-hans-cn` is matched exactly as its
 * canonical form is, and the tag returned is the one `offered` spelled — the
 * key to read the answer with.
 */
export function matchLanguageTag(offered: readonly string[], locale: string | null | undefined): string | undefined {
  const normalized = normalizeLanguageTag(locale);
  if (normalized === undefined) return undefined;
  const requested = subtagsOf(normalized);

  let best: string | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const tag of offered) {
    const candidate = normalizeLanguageTag(tag);
    if (candidate === undefined) continue;
    if (candidate === normalized) return tag;
    const rank = matchRank(subtagsOf(candidate), requested);
    if (rank !== undefined && rank < bestRank) {
      best = tag;
      bestRank = rank;
    }
  }
  return best;
}
