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
import type { LocalizedLabels } from './localized-label';

export * from './localized-label';

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
 * {@link LocalizedLabels} as a response publishes them. Open, so a language
 * GoWay adds is not a parse failure in an SDK built before it.
 */
export const localizedLabelsSchema = z.object({ en: labelSchema }).catchall(labelSchema);
