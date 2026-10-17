/**
 * A label in the reader's language, picked without zod — so a renderer (the
 * map's credit) can read one without loading the schemas `labels.ts` holds.
 */
import { matchLanguageTag } from './language-tags';

/**
 * Labels keyed by canonical language tag: English always, any others as they
 * exist. Every `Labels` (`labels.ts`) is one.
 */
export type LocalizedLabels = Readonly<{ en: string; [language: string]: string }>;

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
