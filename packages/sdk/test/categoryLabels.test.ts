import { readFileSync } from 'node:fs';
import { CATEGORY_DEFINITIONS, LABEL_LANGUAGES, labelsSchema } from '@goway/contracts';
import { describe, expect, it } from 'vitest';

/**
 * `packages/contracts/src/i18n/category-labels.json` — the category taxonomy's
 * labels in every label language, as DATA for the migration that seeds
 * `place_category_labels`. Nothing imports it at runtime (so it ships in no
 * bundle); this suite is what holds it to the taxonomy.
 *
 * Here rather than in the backend because this suite reads `@goway/contracts`
 * from SOURCE: a check against the compiled `dist/` would compare the file
 * with whatever taxonomy was last built.
 */

const TRANSLATIONS = JSON.parse(
  readFileSync(new URL('../../contracts/src/i18n/category-labels.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, string>>;

describe('the category label translations', () => {
  it('cover exactly the taxonomy, in its order', () => {
    expect(Object.keys(TRANSLATIONS)).toEqual(CATEGORY_DEFINITIONS.map((entry) => entry.key));
  });

  it('give every category every label language, and nothing else', () => {
    for (const [key, labels] of Object.entries(TRANSLATIONS)) {
      expect(Object.keys(labels), key).toEqual([...LABEL_LANGUAGES]);
      expect(labelsSchema.safeParse(labels).success, key).toBe(true);
      for (const language of LABEL_LANGUAGES) {
        const label = labels[language] ?? '';
        expect(label, `${key} ${language}`).toBe(label.trim());
        expect(label, `${key} ${language}`).toBe(label.normalize('NFC'));
        expect(label, `${key} ${language}`).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
      }
    }
  });

  it('agree with the English and Spanish the taxonomy ships', () => {
    for (const entry of CATEGORY_DEFINITIONS) {
      expect(TRANSLATIONS[entry.key]?.en, entry.key).toBe(entry.labels.en);
      expect(TRANSLATIONS[entry.key]?.es, entry.key).toBe(entry.labels.es);
    }
  });
});
