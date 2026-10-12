/**
 * The landmark tour's ways in are labelled in every `LABEL_LANGUAGES`
 * language, each naming the landmark where its accessible name should.
 */
import { describe, expect, test } from 'bun:test';
import { LABEL_LANGUAGES, type Labels, localizedLabel } from '@goway.to/sdk';

import { LANDMARK_ENTRY_LABELS } from '@/lib/map/landmarks/labels';

describe('landmark entry labels', () => {
  test('every label in every language, trimmed and NFC', () => {
    for (const [key, labels] of Object.entries(LANDMARK_ENTRY_LABELS) as [string, Labels][]) {
      expect(Object.keys(labels).sort(), key).toEqual([...LABEL_LANGUAGES].sort());
      for (const language of LABEL_LANGUAGES) {
        const label = labels[language];
        expect(label.length, `${key}.${language}`).toBeGreaterThan(0);
        expect(label, `${key}.${language}`).toBe(label.trim());
        expect(label, `${key}.${language}`).toBe(label.normalize('NFC'));
      }
    }
  });

  test('the accessible names carry the landmark’s name in every language', () => {
    for (const language of LABEL_LANGUAGES) {
      expect(LANDMARK_ENTRY_LABELS.pillName[language], language).toContain('{name}');
      expect(LANDMARK_ENTRY_LABELS.placeActionName[language], language).toContain('{name}');
    }
    expect(localizedLabel(LANDMARK_ENTRY_LABELS.pill, 'es-MX')).toBe('Monumentos');
  });
});
