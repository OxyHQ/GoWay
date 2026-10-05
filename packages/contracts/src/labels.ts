/**
 * Human labels for GoWay's own closed vocabularies — categories, capability
 * keys, their enum values and groups.
 *
 * A label is CONTRACT data rather than app copy, for the same reason a place
 * name is: every client that renders a category has to say it in the reader's
 * language, and a label table copied into each client is a table that drifts.
 * GoWay publishes one, in the languages it can stand behind, and every client
 * reads it through {@link localizedLabel}.
 *
 * Two shapes, one reader:
 *
 *  - {@link Labels} — every {@link LABEL_LANGUAGES} language, all REQUIRED.
 *    The vocabularies that live in code (the capability registry) are written
 *    this way: a vocabulary translated for most of its keys renders as a
 *    patchwork, which is worse than one consistent language, so the type
 *    refuses an entry with a language missing.
 *  - {@link LocalizedLabels} — English and any other languages, keyed by
 *    canonical tag. What a vocabulary stored as DATA publishes (the category
 *    taxonomy), where the set of languages is the rows that exist.
 *
 * Both are read by {@link localizedLabel}, which picks the best language with
 * {@link matchLanguageTag} and falls back to English. How to add a language
 * and where each one stands on review: `docs/LABEL_TRANSLATIONS.md`.
 */

import { z } from 'zod';
import { matchLanguageTag } from './language';

/**
 * The languages every in-code label is written in, as canonical tags. The
 * first is the fallback. Mercaria's locales, so the two products read alike.
 */
export const LABEL_LANGUAGES = [
  'en',
  'ar',
  'bn',
  'ca',
  'de',
  'es',
  'fr',
  'hi',
  'ja',
  'pt-BR',
  'ru',
  'zh-Hans',
] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

/** One label in every {@link LABEL_LANGUAGES} language. */
export type Labels = Readonly<Record<LabelLanguage, string>>;

const labelSchema = z.string().min(1);

export const labelsSchema = z.object({
  en: labelSchema,
  ar: labelSchema,
  bn: labelSchema,
  ca: labelSchema,
  de: labelSchema,
  es: labelSchema,
  fr: labelSchema,
  hi: labelSchema,
  ja: labelSchema,
  'pt-BR': labelSchema,
  ru: labelSchema,
  'zh-Hans': labelSchema,
}) satisfies z.ZodType<Labels>;

/**
 * Labels keyed by canonical language tag: English always, any others as they
 * exist. Every {@link Labels} is one.
 */
export type LocalizedLabels = Readonly<{ en: string; [language: string]: string }>;

/**
 * {@link LocalizedLabels} as a response publishes them. Open, so a language
 * GoWay adds is not a parse failure in an SDK built before it.
 */
export const localizedLabelsSchema = z.object({ en: labelSchema }).catchall(labelSchema);

/**
 * The label for a reader of `locale`: the best match among the languages the
 * entry has (see {@link matchLanguageTag}), English when none serves.
 *
 * `es-MX` reads `es`; `pt-PT` reads `pt-BR`; `zh-Hans-CN` and `zh-SG` read
 * `zh-Hans`; `zh-TW` reads `zh-Hans` too until a `zh-Hant` label exists.
 */
export function localizedLabel(entry: LocalizedLabels, locale?: string | null): string {
  const language = matchLanguageTag(Object.keys(entry), locale);
  return (language === undefined ? undefined : entry[language]) ?? entry.en;
}
