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
 * Two languages to start, both REQUIRED on every entry: a vocabulary that is
 * translated for most of its keys renders as a patchwork, which is worse than
 * one consistent language. Adding a third is additive — the object gains a key.
 */

import { z } from 'zod';
import { baseLanguageTag } from './language';

/** The languages every label is written in. The first is the fallback. */
export const LABEL_LANGUAGES = ['en', 'es'] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

/** One label in every {@link LABEL_LANGUAGES} language. */
export type Labels = Readonly<Record<LabelLanguage, string>>;

export const labelsSchema = z.object({
  en: z.string().min(1),
  es: z.string().min(1),
});

/** Shorthand for writing a registry entry: `labels('Café', 'Cafetería')`. */
export function labels(en: string, es: string): Labels {
  return { en, es };
}

/**
 * The label for a locale: the bare language when GoWay has it, English
 * otherwise. `es-MX` reads the Spanish label; `ja` reads the English one.
 */
export function localizedLabel(entry: Labels, locale?: string | null): string {
  const language = locale ? baseLanguageTag(locale) : undefined;
  return language !== undefined && (LABEL_LANGUAGES as readonly string[]).includes(language)
    ? entry[language as LabelLanguage]
    : entry.en;
}
