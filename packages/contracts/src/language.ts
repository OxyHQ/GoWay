/**
 * Language tags (`language-tags.ts`, which holds the rules and has no zod in
 * it, so a renderer can match a label without loading the schemas) and the
 * schemas a request and a response hold them to.
 */
import { z } from 'zod';

import {
  LANGUAGE_TAG_PATTERN,
  MAX_LANGUAGE_TAG_LENGTH,
  normalizeLanguageTag,
} from './language-tags';

export * from './language-tags';

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
