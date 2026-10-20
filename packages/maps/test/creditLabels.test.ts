/**
 * The credit's own words exist in every `LABEL_LANGUAGES` language, with the
 * label hygiene GoWay's vocabularies are held to.
 */
import { describe, expect, test } from 'bun:test';
import { LABEL_LANGUAGES, type Labels } from '@goway.to/sdk';

import { CREDIT_LABELS } from '../src/creditLabels';

const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/;

function expectComplete(name: string, labels: Labels) {
  expect(Object.keys(labels).sort(), name).toEqual([...LABEL_LANGUAGES].sort());
  for (const language of LABEL_LANGUAGES) {
    const label = labels[language];
    expect(label.length, `${name}.${language}`).toBeGreaterThan(0);
    expect(label, `${name}.${language}`).toBe(label.trim());
    expect(label, `${name}.${language}`).toBe(label.normalize('NFC'));
    expect(BIDI_CONTROLS.test(label), `${name}.${language}`).toBe(false);
  }
}

describe('the credit’s words', () => {
  test('show and hide, in every language', () => {
    for (const [key, labels] of Object.entries(CREDIT_LABELS))
      expectComplete(`credit.${key}`, labels);
  });
});
